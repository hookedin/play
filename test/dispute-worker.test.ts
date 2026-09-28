import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anvil, deployment, open, step, signedIncrease } from '../testing/contract.ts';
import { verifyEvidence } from '../protocol/protocol.ts';
import { ChainObserver } from '../protocol/chain-observer.ts';
import { DisputeWorker } from '../protocol/dispute-worker.ts';

test("a deposit orphaned by a reorg cannot block another channel's challenge", async t => {
  const env = await anvil();
  t.after(() => env.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hookedin-disputes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = await deployment(env),
    bad = await open(f, env.wallets[1], 100n),
    good = await open(f, env.wallets[2], 100n),
    win = await signedIncrease(f, good, 50n),
    snapshot = await env.provider.send('evm_snapshot', []);
  await (await f.contract.deposit(bad.player.address, { value: 100n })).wait();
  const deposit = await step(f, bad, 4, 100n);
  await env.provider.send('evm_revert', [snapshot]);
  await (await f.contract.startClose(bad.evidence)).wait();
  await (await f.contract.startClose(good.evidence)).wait();
  const bundles = [
    { opening: bad.opening, evidence: deposit.evidence },
    { opening: good.opening, evidence: win.evidence },
  ].map(bundle => ({
    ...bundle,
    chainId: env.chainId,
    casino: String(f.contract.target),
    operator: f.owner.address,
  }));
  // Authentic evidence can become unusable on the canonical chain. It must not monopolize the submission queue.
  assert.equal(verifyEvidence(bundles[0]).signaturesValid, true);
  await assert.rejects(f.contract.challengeClose.staticCall(deposit.evidence));
  const observer = new ChainObserver({ provider: env.provider, chainId: env.chainId }),
    worker = new DisputeWorker({
      contract: f.contract,
      provider: env.provider,
      observer,
      signer: env.wallets[9],
      chainId: env.chainId,
      file: path.join(directory, 'journal.json'),
    }),
    result = await worker.tick(bundles, await observer.observe());
  assert.ok(result.pending, 'the valid challenge must be submitted in this tick');
  await env.provider.waitForTransaction(result.pending);
  assert.equal((await f.contract.channels(good.state.channelId)).closingSequence, 2n);
  assert.equal((await f.contract.channels(bad.state.channelId)).closingSequence, 1n);
  assert.ok(
    result.alerts.some(alert => alert.channelId === bad.state.channelId && alert.reason === 'channel-defense-failed'),
  );
});
