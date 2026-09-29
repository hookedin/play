import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anvil, deployment, open, signedIncrease } from '../testing/contract.ts';
import { verifyEvidence } from '../protocol/protocol.ts';
import { ChainObserver } from '../protocol/chain-observer.ts';
import { DisputeWorker } from '../protocol/dispute-worker.ts';

test("evidence this contract cannot settle blocks no other channel's challenge", async t => {
  const env = await anvil();
  t.after(() => env.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hookedin-disputes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = await deployment(env),
    other = await deployment(env),
    bad = await open(f, env.wallets[1], 100n),
    good = await open(f, env.wallets[2], 100n),
    win = await signedIncrease(f, good, 50n);
  // The same account's channel on another deployment has the same ID, and evidence signed for that contract.
  const elsewhere = await open(other, env.wallets[1], 100n),
    stale = await signedIncrease(other, elsewhere, 10n);
  await (await f.contract.startClose(bad.evidence)).wait();
  await (await f.contract.startClose(good.evidence)).wait();
  const bundles = [
    { opening: bad.opening, evidence: stale.evidence, casino: String(other.contract.target) },
    { opening: good.opening, evidence: win.evidence, casino: String(f.contract.target) },
  ].map(bundle => ({ ...bundle, chainId: env.chainId, operator: f.owner.address }));
  // Signed as it says, and not this contract's: it must not monopolize the submission queue.
  assert.equal(elsewhere.opening.channelId, bad.opening.channelId);
  assert.equal(verifyEvidence(bundles[0]).signaturesValid, true);
  await assert.rejects(f.contract.challengeClose.staticCall(stale.evidence));
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
