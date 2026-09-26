import test from 'node:test';
import assert from 'node:assert/strict';
import { id, Wallet } from 'ethers';
import { anvil, deployment, signedIncrease, open, step, closeCoop, assessBinary } from '../testing/contract.ts';
import { hashState, checkpointEvidence, STATE_TYPES } from '../protocol/protocol.ts';
import { OUTCOME_SPACE } from '../protocol/risk.ts';
test('shared-pool contract protects principal, retains debts and verifies channel evidence', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [owner, a, b] = env.wallets;
  const ca = await open(f, a, 1000n),
    cb = await open(f, b, 2000n);
  assert.equal(await f.contract.hashState(ca.state), hashState(f.d, ca.state));
  assert.equal(await f.contract.protectedPrincipal(), 3000n);
  await assert.rejects(f.contract.withdrawHouse(id('blocked-withdrawal'), owner.address, 1n));
  const win = await signedIncrease(f, ca, 500n);
  assert.equal((await f.contract.supported(win.evidence)).balance, 1500n);
  await closeCoop(f, ca, win.evidence);
  assert.equal((await f.contract.claims(ca.state.channelId)).paid, 0n);
  await (await f.contract.claim(ca.state.channelId)).wait();
  let claim = await f.contract.claims(ca.state.channelId);
  assert.equal(claim.paid, 1000n);
  assert.equal(claim.winningsRemaining, 500n);
  assert.equal(await f.contract.protectedPrincipal(), 2000n);
  assert.equal(await f.contract.unpaidWinnings(), 500n);
  await assert.rejects(closeCoop(f, ca, win.evidence));
  await (await f.contract.claim(ca.state.channelId)).wait();
  assert.equal((await f.contract.claims(ca.state.channelId)).paid, 1000n);
  await (await f.contract.fundBankroll({ value: 200n })).wait();
  await assert.rejects(f.contract.withdrawHouse(id('blocked-withdrawal'), owner.address, 1n));
  await (await f.contract.claim(ca.state.channelId)).wait();
  assert.equal((await f.contract.claims(ca.state.channelId)).winningsRemaining, 300n);
  const loss = await step(f, cb, 2, 700n);
  await closeCoop(f, cb, loss.evidence);
  await (await f.contract.claim(cb.state.channelId)).wait();
  assert.equal((await f.contract.claims(cb.state.channelId)).paid, 1300n);
  assert.equal(await f.contract.protectedPrincipal(), 0n);
  await (await f.contract.claim(ca.state.channelId)).wait();
  assert.equal((await f.contract.claims(ca.state.channelId)).paid, 1500n);
  assert.equal(await f.contract.unpaidWinnings(), 0n);
  assert.equal(await f.contract.withdrawableHouse(), 400n);
  await (await f.contract.withdrawHouse(id('surplus-withdrawal'), owner.address, 400n)).wait();
  assert.equal(await env.provider.getBalance(await f.contract.getAddress()), 0n);
  const cc = await open(f, a, 10000n);
  const q = assessBinary({
    bankroll: 1000000n,
    stake: 100n,
    netWin: 100n,
    chance: (OUTCOME_SPACE * 49n) / 100n,
  });
  const bet = await step(f, cc, 1, 100n, {
    chance: q.chance,
    prize: q.prize,
    seed: id('fresh'),
  });
  assert.equal((await f.contract.supported(bet.evidence)).balance, BigInt(bet.state.balance));
  const altered = structuredClone(bet.evidence);
  altered.step.operation.amount = '101';
  await assert.rejects(f.contract.supported(altered));
  await (await f.contract.connect(a).startClose(cc.evidence)).wait();
  const deadline = (await f.contract.channels(cc.state.channelId)).deadline;
  await (await f.contract.connect(b).challengeClose(bet.evidence)).wait();
  assert.equal((await f.contract.channels(cc.state.channelId)).deadline, deadline);
  await assert.rejects(f.contract.challengeClose(cc.evidence));
  await assert.rejects(f.contract.finalizeClose(cc.state.channelId));
  await env.provider.send('evm_increaseTime', [86400]);
  await env.provider.send('evm_mine', []);
  await assert.rejects(f.contract.challengeClose(bet.evidence));
  await (await f.contract.finalizeClose(cc.state.channelId)).wait();
  assert.equal((await f.contract.claims(cc.state.channelId)).amount, BigInt(bet.state.balance));
  // A fully signed checkpoint requires no historical replay.
  const cd = await open(f, b, 100n);
  const changed = {
    ...cd.state,
    sequence: '100',
    previousStateHash: id('earlier'),
    balance: '90',
  };
  const jointly = checkpointEvidence(
    changed,
    await new Wallet(cd.key).signTypedData(f.d, STATE_TYPES, changed),
    await owner.signTypedData(f.d, STATE_TYPES, changed),
  );
  assert.equal((await f.contract.supported(jointly)).balance, 90n);
});
test('channel evidence rejects replay across channels and chains', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    a = await open(f, env.wallets[1]),
    b = await open(f, env.wallets[2]);
  const result = await step(f, a, 2, 100n),
    cross = structuredClone(result.evidence);
  cross.base.channelId = b.state.channelId;
  await assert.rejects(f.contract.supported(cross));
  const changed = { ...result.state, balance: '950' },
    bad = checkpointEvidence(
      changed,
      await env.wallets[1].signTypedData({ ...f.d, chainId: 11155111 }, STATE_TYPES, changed),
      await f.owner.signTypedData(f.d, STATE_TYPES, changed),
    );
  await assert.rejects(f.contract.supported(bad));
  // Unresolved authorizations have no result evidence and create no withholding penalty.
  await (await f.contract.connect(env.wallets[1]).startClose(a.evidence)).wait();
  const deadline = (await f.contract.channels(a.state.channelId)).deadline;
  await env.provider.send('evm_setNextBlockTimestamp', [Number(deadline) - 1]);
  await env.provider.send('evm_mine', []);
  await assert.rejects(f.contract.finalizeClose.staticCall(a.state.channelId));
  // Re-submitting the proposed state is not a challenge.
  await assert.rejects(f.contract.challengeClose.staticCall(a.evidence));
  await env.provider.send('evm_setNextBlockTimestamp', [Number(deadline)]);
  await env.provider.send('evm_mine', []);
  await assert.rejects(f.contract.challengeClose.staticCall(result.evidence));
  await (await f.contract.finalizeClose(a.state.channelId)).wait();
  assert.equal((await f.contract.claims(a.state.channelId)).amount, 1000n);
});
test('balances are capped below 2^128 so aggregate debt cannot overflow and block protected-principal finalization', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    a = await open(f, env.wallets[1], 1n),
    b = await open(f, env.wallets[2], 1n),
    c = await open(f, env.wallets[3], 1n),
    max = (1n << 128n) - 1n;
  async function balanceEvidence(ch: any, balance: any) {
    const state = { ...ch.state, sequence: '1', balance: String(balance) };
    return checkpointEvidence(
      state,
      await ch.player.signTypedData(f.d, STATE_TYPES, state),
      await f.owner.signTypedData(f.d, STATE_TYPES, state),
    );
  }
  // A jointly signed balance at or above the cap is not settlement evidence, however it was produced.
  await assert.rejects(f.contract.supported(await balanceEvidence(a, 1n << 128n)));
  await assert.rejects(
    f.contract.connect(env.wallets[4]).openChannel.staticCall(env.wallets[4].address, { value: 1n << 128n }),
  );
  await closeCoop(f, a, await balanceEvidence(a, max));
  await closeCoop(f, b, await balanceEvidence(b, 10n));
  assert.equal(await f.contract.unpaidWinnings(), max - 1n + 9n);
  await closeCoop(f, c);
  await (await f.contract.claim(c.state.channelId)).wait();
  assert.equal((await f.contract.claims(c.state.channelId)).paid, 1n);
  await (await f.contract.fundBankroll({ value: 20n })).wait();
  assert.equal(await f.contract.withdrawableHouse(), 0n);
  await (await f.contract.claim(a.state.channelId)).wait();
  assert.equal(await f.contract.unpaidWinnings(), max - 1n + 9n - 20n);
});

test('packed deadlines cannot wrap and shorten the challenge period', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    ch = await open(f, env.wallets[1]);
  const tooLate = (1n << 64n) - 86400n;
  await env.provider.send('evm_setNextBlockTimestamp', ['0x' + tooLate.toString(16)]);
  await env.provider.send('evm_mine', []);
  await assert.rejects(f.contract.startClose.staticCall(ch.evidence));
  assert.equal((await f.contract.channels(ch.state.channelId)).status, 1n);
});

test('contract check: FIFO accounting survives allocation limits with 20 unpaid claims', async t => {
  const env = await anvil(),
    f = await deployment(env);
  t.after(() => env.close());
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const c = await open(f, env.wallets[1], 1n),
      win = await signedIncrease(f, c, 10n);
    await closeCoop(f, c, win.evidence);
    ids.push(c.state.channelId);
  }
  assert.equal(await f.contract.unpaidWinnings(), 200n);
  await (await f.contract.fundBankroll({ value: 127n })).wait();
  assert.equal(await f.contract.reservedWinnings(), 80n);
  await (await f.contract.claim(ids[19])).wait();
  assert.equal((await f.contract.claims(ids[19])).paid, 1n);
  for (let i = 0; i < 20; i++)
    assert.equal(await f.contract.allocatedWinnings(ids[i]), i < 12 ? 10n : i === 12 ? 7n : 0n);
  assert.equal(await f.contract.reservedWinnings(), 127n);
  assert.equal(await f.contract.withdrawableHouse(), 0n);
  await (await f.contract.fundBankroll({ value: 73n })).wait();
  await (await f.contract.allocateWinnings(64)).wait();
  for (const channelId of [...ids].reverse()) await (await f.contract.claim(channelId)).wait();
  for (const channelId of ids) assert.equal((await f.contract.claims(channelId)).paid, 11n);
  assert.equal(await f.contract.unpaidWinnings(), 0n);
  assert.equal(await f.contract.reservedWinnings(), 0n);
  assert.equal(await f.contract.protectedPrincipal(), 0n);
  assert.equal(await env.provider.getBalance(await f.contract.getAddress()), 0n);
});
