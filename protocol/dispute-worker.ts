import type { Contract } from 'ethers';
import type { ChainObserver, Observation } from './chain-observer.ts';
import type { TransactionJournal } from './transaction-journal.ts';
import type { EvidenceBundle, OnchainChannel } from './types.ts';
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
/** How long before its quote expires the watcher disputes a casino bet the casino has not settled, and before which a
 * deadline is critical, in seconds. */
const DISPUTE_MARGIN = 3600;

/** Evidence-driven watcher: no channel private keys are needed to challenge a close, or to dispute a casino bet the
 * casino leaves unsettled. */
export class DisputeWorker {
  declare contract: Contract;
  declare observer: ChainObserver;
  declare outbox: TransactionJournal;

  constructor({
    contract,
    observer,
    outbox,
  }: {
    contract: Contract;
    observer: ChainObserver;
    outbox: TransactionJournal;
  }) {
    Object.assign(this, { contract, observer, outbox });
  }
  async tick(
    bundles: EvidenceBundle[],
    observation: Observation,
    observedChannels: Map<string, OnchainChannel> | null = null,
    beforeChallenge: (() => Promise<void>) | null = null,
  ) {
    const alerts: DisputeAlert[] = [];
    await this.outbox.reconcile();
    const jobs = [];
    for (const bundle of bundles) {
      let channelId: string | undefined;
      try {
        const { player, index } = bundle.evidence.base;
        channelId = channelOf(player, index);
        const c: OnchainChannel =
          observedChannels?.get(channelId) ||
          (await this.observer.contractRead(this.contract, 'channels', [player, index], observation.block));
        // Read the claimed sequence, a casino bet's when the bundle carries one, before verifying anything: an active
        // channel needs no defense but for a casino bet the casino has not settled, so signature verification runs only
        // for those and for channels that are closing or finalized behind us.
        const claimed =
          bundle.evidence.base.sequence + (bundle.dispute || bundle.evidence.step.operation.kind !== 0n ? 1n : 0n);
        const status = c.status;
        if (
          !(status === STATUS.active && bundle.dispute) &&
          status !== STATUS.closing &&
          !(status === STATUS.finalized && claimed > c.closingSequence)
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
            sequence: state.sequence + 1n,
            expiresAt: Number(bet.quote.message.expiresAt),
          };
        // A casino bet its quote no longer covers cannot be disputed: unless the casino settles it, it ends void.
        if (bundle.dispute && !bet && claimed > c.closingSequence)
          alerts.push({
            channelId,
            severity: status === STATUS.active ? 'warning' : 'critical',
            reason: 'expired-bet',
          });
        if (status === STATUS.active) {
          // Disputing closes the channel, so it waits until the bet's quote is about to expire: the casino may still
          // settle it, and the wallet's newer bundle then has no bet to dispute.
          if (!dispute) continue;
          const remaining = dispute.expiresAt - now;
          alerts.push({
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
            alerts.push({
              channelId,
              severity: 'critical',
              reason: 'finalized-state-differs',
              remaining: 0,
            });
          continue;
        }
        // A disputed casino bet is settled by evidence at its own sequence.
        const disputed = c.disputedPrize > 0n && state.sequence === c.closingSequence,
          // A close that stops short of a casino bet the casino has not settled is challenged by disputing the bet,
          // which counts it as won, while its quote holds.
          short = dispute && dispute.sequence > c.closingSequence ? dispute : null,
          deadline = short ? Math.min(short.expiresAt, Number(c.deadline)) : Number(c.deadline),
          remaining = deadline - observation.block.timestamp;
        if (short || state.sequence > c.closingSequence || disputed) {
          alerts.push({
            channelId,
            severity: remaining < DISPUTE_MARGIN ? 'critical' : 'warning',
            reason:
              remaining <= 0 ? 'missed-deadline' : disputed ? 'disputed-bet' : short ? 'unsettled-bet' : 'stale-close',
            remaining,
          });
          if (remaining > 0)
            jobs.push({
              channelId,
              deadline,
              ...(short ?? { method: 'challengeClose', args: [bundle.evidence], sequence: state.sequence }),
            });
        } else if (state.sequence === c.closingSequence && !same(stateHash, c.closingHash))
          alerts.push({
            channelId,
            severity: 'critical',
            reason: 'conflicting-sequence',
            remaining,
          });
      } catch (error: any) {
        alerts.push({
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
      await this.observer.requireCanonical(observation.block);
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
            alerts.push({
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
      alerts.push({
        severity: 'critical',
        reason: 'recovery-transaction-failed',
        detail: error.shortMessage || error.message,
      });
    }
    return { alerts, pending: this.outbox.state.pending?.hash || null };
  }
}
