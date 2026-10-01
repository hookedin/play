import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anvil, deployment, disputedBet, open, signedIncrease } from '../testing/contract.ts';
import { hashState, verifyEvidence } from '../protocol/protocol.ts';
import { OUTCOME_SPACE } from '../protocol/risk.ts';
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
  assert.doesNotThrow(() => verifyEvidence(bundles[0]));
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

test('a disputed casino bet is settled by the evidence at its own sequence', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hookedin-disputes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = await deployment(env),
    ch = await open(f, env.wallets[1], 1000n),
    expiresAt = (await env.provider.getBlock('latest'))!.timestamp + 86400,
    bet = await disputedBet(f, ch, {
      virtualBankroll: 5000n,
      expiresAt,
      stake: 100n,
      chance: OUTCOME_SPACE / 2n,
      prize: 196n,
    });
  await (await f.contract.connect(env.wallets[1]).dispute(bet.evidence, bet.terms)).wait();
  const settled = await bet.settled(),
    observer = new ChainObserver({ provider: env.provider, chainId: env.chainId }),
    worker = new DisputeWorker({
      contract: f.contract,
      provider: env.provider,
      observer,
      signer: env.wallets[9],
      chainId: env.chainId,
      file: path.join(directory, 'journal.json'),
    }),
    bundle = {
      opening: ch.opening,
      evidence: settled.evidence,
      casino: String(f.contract.target),
      chainId: env.chainId,
      operator: f.owner.address,
    },
    result = await worker.tick([bundle], await observer.observe());
  assert.ok(result.alerts.some(alert => alert.reason === 'disputed-bet'));
  await env.provider.waitForTransaction(result.pending!);
  const c = await f.contract.channels(ch.state.channelId);
  assert.deepEqual([c.closingHash, c.disputedPrize], [hashState(f.d, settled.state), 0n]);
});
