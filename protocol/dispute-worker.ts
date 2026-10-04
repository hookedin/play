import type { Contract, JsonRpcProvider } from 'ethers';
import type { ChainObserver, Observation } from './chain-observer.ts';
import type { JournalOptions } from './transaction-journal.ts';
import type { EvidenceBundle } from './types.ts';
export interface DisputeAlert {
  channelId?: string;
  severity: string;
  reason: string;
  remaining?: number;
  detail?: string;
}
import {
  STATUS,
  channelId as channelOf,
  covers,
  domain,
  hashState,
  quoteTerms,
  verifyEvidence,
  same,
} from './protocol.ts';
import { TransactionJournal } from './transaction-journal.ts';
/** How long before its quote expires the watcher disputes a casino bet the casino has not settled, in seconds. */
export const DISPUTE_MARGIN = 3600;

/** Evidence-driven watcher: no channel private keys are needed to challenge a close, or to dispute a casino bet the
 * casino leaves unsettled. */
export class DisputeWorker {
  declare contract: Contract;
  declare provider: JsonRpcProvider;
  declare observer: ChainObserver;
  declare now: () => number;
  declare outbox: TransactionJournal;
  declare alerts: DisputeAlert[];

  constructor({
    contract,
    provider,
    observer,
    signer,
    file,
    chainId,
    confirmations = 1,
    now = Date.now,
    outbox,
  }: JournalOptions & { contract: Contract; observer: ChainObserver; outbox?: TransactionJournal }) {
    Object.assign(this, { contract, provider, observer, now });
    this.outbox = outbox || new TransactionJournal({ file, provider, observer, signer, chainId, confirmations, now });
    this.alerts = [];
  }
  async tick(
    bundles: EvidenceBundle[],
    observation: Observation,
    observedChannels: Map<string, any> | null = null,
    beforeChallenge: (() => Promise<void>) | null = null,
  ) {
    this.alerts = [];
    await this.outbox.reconcile();
    const jobs = [];
    for (const bundle of bundles) {
      let channelId: string | undefined;
      try {
        const { player, index } = bundle.evidence.base;
        channelId = channelOf(player, index);
        const c =
          observedChannels?.get(channelId) ||
          (await this.observer.contractRead(this.contract, 'channels', [player, index], observation.block));
        // Read the claimed sequence, a casino bet's when the bundle carries one, before verifying anything: an active
        // channel needs no defense but for a casino bet the casino has not settled, so signature verification runs only
        // for those and for channels that are closing or finalized behind us.
        const claimed =
          BigInt(bundle.evidence.base.sequence) +
          (bundle.dispute || Number(bundle.evidence.step.operation.kind) ? 1n : 0n);
        const status = Number(c.status);
        if (
          !(status === STATUS.active && bundle.dispute) &&
          status !== STATUS.closing &&
          !(status === STATUS.finalized && claimed > BigInt(c.closingSequence))
        )
          continue;
        const { state } = verifyEvidence(bundle);
        const stateHash = hashState(domain(bundle.chainId, bundle.casino), state),
          now = observation.block.timestamp,
          bet =
            bundle.dispute && covers(bundle.dispute.quote, bundle.dispute.step.operation, now) ? bundle.dispute : null,
          dispute = bet && {
            method: 'dispute',
            args: [{ ...bundle.evidence, step: bet.step }, quoteTerms(bet.quote)],
            sequence: BigInt(state.sequence) + 1n,
            expiresAt: Number(bet.quote.message.expiresAt),
          };
        // A casino bet its quote no longer covers cannot be disputed: unless the casino settles it, it ends void.
        if (bundle.dispute && !bet && claimed > BigInt(c.closingSequence))
          this.alerts.push({
            channelId,
            severity: status === STATUS.active ? 'warning' : 'critical',
            reason: 'expired-bet',
          });
        if (status === STATUS.active) {
          // Disputing closes the channel, so it waits until the bet's quote is about to expire: the casino may still
          // settle it, and the wallet's newer bundle then has no bet to dispute.
          if (!dispute) continue;
          const remaining = dispute.expiresAt - now;
          this.alerts.push({
            channelId,
            severity: remaining < DISPUTE_MARGIN ? 'critical' : 'warning',
            reason: 'unsettled-bet',
            remaining,
          });
          if (remaining < DISPUTE_MARGIN) jobs.push({ channelId, deadline: dispute.expiresAt, ...dispute });
          continue;
        }
        if (status === STATUS.finalized) {
          // The channel finalized on its closing checkpoint.
          if (!same(c.closingHash, stateHash))
            this.alerts.push({
              channelId,
              severity: 'critical',
              reason: 'finalized-state-differs',
              remaining: 0,
            });
          continue;
        }
        // A disputed casino bet is settled by evidence at its own sequence.
        const disputed = BigInt(c.disputedPrize) > 0n && BigInt(state.sequence) === BigInt(c.closingSequence),
          // A close that stops short of a casino bet the casino has not settled is challenged by disputing the bet,
          // which counts it as won, while its quote holds.
          short = dispute && dispute.sequence > BigInt(c.closingSequence) ? dispute : null,
          deadline = short ? Math.min(short.expiresAt, Number(c.deadline)) : Number(c.deadline),
          remaining = deadline - observation.block.timestamp;
        if (short || BigInt(state.sequence) > BigInt(c.closingSequence) || disputed) {
          this.alerts.push({
            channelId,
            severity: remaining < 3600 ? 'critical' : 'warning',
            reason:
              remaining <= 0 ? 'missed-deadline' : disputed ? 'disputed-bet' : short ? 'unsettled-bet' : 'stale-close',
            remaining,
          });
          if (remaining > 0)
            jobs.push({
              channelId,
              deadline,
              ...(short ?? { method: 'challengeClose', args: [bundle.evidence], sequence: BigInt(state.sequence) }),
            });
        } else if (BigInt(state.sequence) === BigInt(c.closingSequence) && !same(stateHash, c.closingHash))
          this.alerts.push({
            channelId,
            severity: 'critical',
            reason: 'conflicting-sequence',
            remaining,
          });
      } catch (error: any) {
        this.alerts.push({
          channelId,
          severity: 'critical',
          reason: 'channel-defense-failed',
          detail: error.shortMessage || error.message,
        });
      }
    }
    jobs.sort((a, b) => a.deadline - b.deadline);
    try {
      // One bad bundle cannot block another channel, but a changed branch must
      // prevent every transaction based on this observation.
      await this.observer.corroborate('challenge block', async rpc => {
        if ((await rpc.getBlock(observation.block.number))?.hash !== observation.block.hash)
          throw new Error('Chain changed during observation');
        return observation.block.hash;
      });
      if (jobs.length && beforeChallenge) await beforeChallenge();
      const pending = this.outbox.state.pending;
      if (pending) await this.outbox.submit(pending.action, null);
      else
        for (const { channelId, method, args, sequence } of jobs) {
          // Signatures alone do not establish that this contract can settle the evidence: a bundle can come from another
          // deployment, whose channels have the same IDs. The most urgent transaction it can settle goes out; one it
          // cannot is reported and blocks no other.
          try {
            await this.observer.contractRead(this.contract, method, args, observation.block);
          } catch (error: any) {
            this.alerts.push({
              channelId,
              severity: 'critical',
              reason: 'channel-defense-failed',
              detail: error.shortMessage || error.message,
            });
            continue;
          }
          const tx = await this.contract[method].populateTransaction(...args);
          await this.outbox.submit((method === 'dispute' ? 'dispute:' : 'challenge:') + channelId + ':' + sequence, tx);
          break;
        }
    } catch (error: any) {
      this.alerts.push({
        severity: 'critical',
        reason: 'recovery-transaction-failed',
        detail: error.shortMessage || error.message,
      });
    }
    return { alerts: this.alerts, pending: this.outbox.state.pending?.hash || null };
  }
}
