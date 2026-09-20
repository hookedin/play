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
import { domain, hashState, verifyEvidence, same } from './protocol.ts';
import { TransactionJournal } from './transaction-journal.ts';

/** Evidence-driven watcher: no channel private keys are needed to challenge. */
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
      const channelId = bundle.opening?.channelId;
      try {
        const c =
          observedChannels?.get(channelId) ||
          (await this.observer.contractRead(this.contract, 'channels', [channelId], observation.block));
        // Read the claimed sequence before verifying anything: an open channel needs no defense,
        // so signature verification runs only for channels that are closing or finalized behind us.
        const claimed = Number(bundle.evidence.step.operation.kind)
          ? BigInt(bundle.evidence.base.sequence) + 1n
          : BigInt(bundle.evidence.base.sequence);
        if (Number(c.status) !== 2 && !(Number(c.status) === 3 && claimed > BigInt(c.closingSequence))) continue;
        const { state } = verifyEvidence(bundle);
        const stateHash = hashState(domain(bundle.chainId, bundle.casino), state);
        if (Number(c.status) === 3) {
          const claim = await this.observer.contractRead(this.contract, 'claims', [state.channelId], observation.block);
          if (!same(claim.stateHash, stateHash))
            this.alerts.push({
              channelId: state.channelId,
              severity: 'critical',
              reason: 'finalized-state-differs',
              remaining: 0,
            });
          continue;
        }
        const remaining = Number(c.deadline) - observation.block.timestamp;
        if (BigInt(state.sequence) === BigInt(c.closingSequence) && !same(stateHash, c.closingHash)) {
          this.alerts.push({
            channelId: state.channelId,
            severity: 'critical',
            reason: 'conflicting-sequence',
            remaining,
          });
        } else if (BigInt(state.sequence) > BigInt(c.closingSequence)) {
          this.alerts.push({
            channelId: state.channelId,
            severity: remaining < 3600 ? 'critical' : 'warning',
            reason: remaining <= 0 ? 'missed-deadline' : 'stale-close',
            remaining,
          });
          if (remaining > 0) jobs.push({ bundle, state, deadline: Number(c.deadline) });
        }
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
      if (pending) {
        await this.outbox.submit(pending.action, null);
      } else if (!pending && jobs.length) {
        const { bundle, state } = jobs[0];
        const tx = await this.contract.challengeClose.populateTransaction(bundle.evidence);
        await this.outbox.submit('challenge:' + state.channelId + ':' + state.sequence, tx);
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
