import fs from 'node:fs';
import path from 'node:path';
import { Contract, Wallet } from 'ethers';
import { createRpcProvider } from '../protocol/chain-observer.ts';
import { json, verifyEvidence, hashState, domain, same } from '../protocol/protocol.ts';
import { inspectEvidence } from '../protocol/recovery.ts';
import { TransactionJournal } from '../protocol/transaction-journal.ts';
import { acquireServerLock } from '../protocol/file-lock.ts';
import artifact from '../client/contract-artifact.ts';
const args = process.argv.slice(2),
  file = args[0];
const option = (name: string, fallback: string | undefined = undefined) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
let provider, unlock;
try {
  if (!file)
    throw new Error(
      'Usage: npm run recover -- bundle.json --rpc URL --action inspect|start|challenge|finalize|claim [--to ADDRESS]',
    );
  if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('Use a minimal settlement bundle smaller than 16 MiB');
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8')),
    rpc = option('--rpc');
  const action = option('--action', 'inspect')!;
  if (!rpc) {
    if (action !== 'inspect') throw new Error('Recovery transactions require --rpc');
    console.log(json(verifyEvidence(bundle)));
  } else {
    provider = createRpcProvider(rpc);
    const { abi } = artifact;
    let observed = await inspectEvidence(
      bundle,
      provider,
      abi,
      action === 'inspect' && option('--block', 'latest') !== 'latest' ? Number(option('--block')) : 'latest',
    );
    if (action !== 'inspect') {
      const methods: Record<string, string> = {
        start: 'startClose',
        challenge: 'challengeClose',
        finalize: 'finalizeClose',
        claim: option('--to') ? 'claimTo' : 'claim',
      };
      if (!methods[action]) throw new Error('Unknown recovery action');
      const walletFile = option('--wallet-file');
      const key = walletFile
        ? JSON.parse(fs.readFileSync(walletFile, 'utf8')).wallets[option('--role', 'player')!].privateKey
        : process.env.HOOKEDIN_RECOVERY_KEY;
      if (!key) throw new Error('Set HOOKEDIN_RECOVERY_KEY or supply a private wallet configuration file');
      const signer = new Wallet(key, provider),
        contract = new Contract(bundle.casino, abi, signer);
      const journalFile = option('--journal', path.resolve('.private', 'recovery-' + observed.channelId + '.json'));
      unlock = acquireServerLock(journalFile + '.lock');
      const outbox = new TransactionJournal({
        file: journalFile,
        signer,
        provider,
        chainId: bundle.chainId,
        confirmations: BigInt(bundle.chainId) === 11155111n ? 2 : 1,
        replaceAfterMs: args.includes('--replace') ? 0 : 45000,
      });
      if (outbox.state.casino && outbox.state.casino.toLowerCase() !== bundle.casino.toLowerCase())
        throw new Error('Recovery journal belongs to another contract');
      outbox.state.casino = bundle.casino;
      await outbox.reconcile(); // Terminal failures are archived before considering another action.
      if (
        action === 'challenge' &&
        Number(observed.channelStatus) === 2 &&
        BigInt(observed.closingSequence) === BigInt(observed.state.sequence) &&
        !same(observed.closingStateHash, hashState(domain(bundle.chainId, bundle.casino), observed.state))
      )
        throw new Error('Conflicting signed states at the same sequence require incident review');
      const achieved =
        (action === 'start' && Number(observed.channelStatus) >= 2) ||
        (action === 'finalize' && Number(observed.channelStatus) === 3) ||
        (action === 'claim' && Number(observed.channelStatus) === 3 && observed.remaining === '0') ||
        (action === 'challenge' &&
          Number(observed.channelStatus) === 2 &&
          BigInt(observed.closingSequence) >= BigInt(observed.state.sequence));
      if (!achieved || outbox.state.pending) {
        const params = ['start', 'challenge'].includes(action) ? [bundle.evidence] : [observed.channelId];
        if (action === 'claim' && option('--to')) params.push(option('--to')!);
        const tx = await contract[methods[action]].populateTransaction(...params);
        const pending = await outbox.submit(action, tx);
        if (pending.status === 'pending') {
          console.log(json({ submitted: pending.hash, action }));
          await provider.waitForTransaction(pending.hash!, outbox.confirmations, 45000);
          const result = await outbox.reconcile();
          if (!result) throw new Error('Transaction pending; rerun or use --replace to raise its fee');
          if (result.status !== 'confirmed')
            throw new Error('Recovery transaction ' + result.status + '; journal released for a fresh action');
        }
      }
      observed = await inspectEvidence(bundle, provider, abi);
    }
    console.log(json(observed));
  }
} catch (error: any) {
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
} finally {
  unlock?.();
  provider?.destroy();
}
