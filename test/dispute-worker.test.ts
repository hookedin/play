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

test('a watchtower disputes a casino bet the casino leaves unsettled: an hour before its quote expires, or at once when a close stops short of it', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hookedin-disputes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = await deployment(env),
    [, a, b] = env.wallets,
    terms = { virtualBankroll: 5000n, stake: 100n, chance: OUTCOME_SPACE / 2n, prize: 196n },
    now = async () => (await env.provider.getBlock('latest'))!.timestamp;
  await (await f.contract.fundBankroll({ value: 10000n })).wait();
  const observer = new ChainObserver({ provider: env.provider, chainId: env.chainId }),
    worker = new DisputeWorker({
      contract: f.contract,
      provider: env.provider,
      observer,
      signer: env.wallets[9],
      chainId: env.chainId,
      file: path.join(directory, 'journal.json'),
    }),
    bundleOf = (ch: any, bet: any) => ({
      opening: ch.opening,
      evidence: ch.evidence,
      dispute: { step: bet.evidence.step, quote: bet.quote },
      casino: String(f.contract.target),
      chainId: env.chainId,
      operator: f.owner.address,
    });
  // An open channel's bet waits while its quote holds for more than an hour: the casino may still settle it.
  const open1 = await open(f, a, 1000n),
    bet1 = await disputedBet(f, open1, { ...terms, expiresAt: (await now()) + 2 * 3600 }),
    bundle1 = bundleOf(open1, bet1);
  assert.doesNotThrow(() => verifyEvidence(bundle1));
  let result = await worker.tick([bundle1], await observer.observe());
  assert.deepEqual(
    [result.pending, result.alerts.map(alert => [alert.reason, alert.severity])],
    [null, [['unsettled-bet', 'warning']]],
  );
  await env.provider.send('evm_increaseTime', [3601]);
  await env.provider.send('evm_mine', []);
  result = await worker.tick([bundle1], await observer.observe());
  assert.ok(result.alerts.some(alert => alert.reason === 'unsettled-bet' && alert.severity === 'critical'));
  await env.provider.waitForTransaction(result.pending!);
  let c = await f.contract.channels(open1.state.channelId);
  assert.deepEqual([c.status, c.closingSequence, c.disputedPrize], [2n, BigInt(bet1.op.sequence), 196n]);
  // A close on the very checkpoint the bet follows is challenged by disputing it.
  const [, , , d] = env.wallets,
    open3 = await open(f, d, 1000n),
    bet3 = await disputedBet(f, open3, { ...terms, expiresAt: (await now()) + 86400 });
  await (await f.contract.connect(f.owner).startClose(open3.evidence)).wait();
  result = await worker.tick([bundleOf(open3, bet3)], await observer.observe());
  assert.ok(result.alerts.some(alert => alert.reason === 'stale-close'));
  await env.provider.waitForTransaction(result.pending!);
  c = await f.contract.channels(open3.state.channelId);
  assert.deepEqual([c.closingSequence, c.disputedPrize], [BigInt(bet3.op.sequence), 196n]);
  // A close on an older checkpoint is challenged by disputing the bet, not with the bundle's checkpoint.
  const open2 = await open(f, b, 1000n),
    bet2 = await disputedBet(f, open2, { ...terms, expiresAt: (await now()) + 86400 });
  await (await f.contract.connect(f.owner).startClose(open2.base)).wait();
  result = await worker.tick([bundleOf(open2, bet2)], await observer.observe());
  await env.provider.waitForTransaction(result.pending!);
  c = await f.contract.channels(open2.state.channelId);
  assert.deepEqual([c.closingSequence, c.disputedPrize], [BigInt(bet2.op.sequence), 196n]);
  // A bundle whose bet does not follow its checkpoint is refused.
  assert.throws(() => verifyEvidence({ ...bundleOf(open2, bet2), evidence: open2.base }), /does not follow/);
});
