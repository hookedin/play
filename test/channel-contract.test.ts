import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractFactory, id, Signature, verifyTypedData, Wallet, ZeroAddress, ZeroHash } from 'ethers';
import { loadArtifact } from '../protocol/deployment.ts';
import {
  anvil,
  deployment,
  signedIncrease,
  fund,
  open,
  step,
  forceClose,
  countersigned,
  assessBinary,
} from '../testing/contract.ts';
import {
  assertSignature,
  checkpointEvidence,
  channelId,
  hashOperation,
  operation,
  OP_TYPES,
  STATE_TYPES,
  verifyEvidence,
} from '../protocol/protocol.ts';
import { OUTCOME_SPACE } from '../protocol/risk.ts';

test('a channel is its account: anyone deposits into it, the first deposit opens it, and a close ends it', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, b, c] = env.wallets;
  // Someone else's deposit opens the account's channel; the account's own adds to the same one.
  const ch = await fund(f, a, 500n, b);
  assert.equal(ch.opening.channelId, channelId(a.address, 0));
  assert.equal(await f.contract.channelOf(a.address), ch.opening.channelId);
  await (await f.contract.connect(a).deposit(a.address, { value: 300n })).wait();
  const onchain = await f.contract.channels(ch.opening.channelId);
  assert.deepEqual([onchain.player, onchain.status, onchain.deposited, onchain.principal], [a.address, 1n, 800n, 800n]);
  assert.equal(await f.contract.protectedPrincipal(), 800n);
  for (const [to, value] of [
    [a.address, 0n],
    [ZeroAddress, 1n],
    [await f.contract.getAddress(), 1n],
  ] as const)
    await assert.rejects(f.contract.connect(b).deposit.staticCall(to, { value }));
  // The base needs no signature, and is owed every deposit it has not taken in; any other checkpoint needs both.
  assert.equal((await f.contract.supported(ch.base)).balance, 0n);
  await assert.rejects(f.contract.supported(checkpointEvidence({ ...ch.state, balance: '1' })));
  const over = await step(f, ch, 4, 801n);
  await assert.rejects(f.contract.connect(a).startClose.staticCall(over.evidence));
  const taken = await step(f, ch, 4, 800n);
  assert.equal((await f.contract.supported(taken.evidence)).deposited, 800n);
  // Only the account, or the casino, starts a close.
  await assert.rejects(f.contract.connect(c).startClose.staticCall(ch.base));
  await (await f.contract.connect(a).startClose(ch.base)).wait();
  assert.equal((await f.contract.channels(ch.opening.channelId)).closingBalance, 800n);
  // A close that starts ends the channel for the account: its next deposit opens its next one, where nothing of the
  // first settles, while the first closes.
  assert.equal(await f.contract.channelOf(a.address), channelId(a.address, 1));
  const next = await open(f, a, 100n, b);
  await env.provider.send('evm_increaseTime', [86401]);
  await env.provider.send('evm_mine', []);
  await (await f.contract.finalizeClose(ch.opening.channelId)).wait();
  assert.equal((await f.contract.claims(ch.opening.channelId)).protectedRemaining, 800n);
  assert.equal(next.opening.channelId, channelId(a.address, 1));
  await assert.rejects(f.contract.connect(a).startClose.staticCall(taken.evidence));
  const cross = structuredClone(taken.evidence);
  cross.base.channelId = next.opening.channelId;
  await assert.rejects(f.contract.supported(cross));
  await (await f.contract.claim(ch.opening.channelId)).wait();
  assert.equal((await f.contract.claims(ch.opening.channelId)).paid, 800n);
});

const reverts = (name: string) => (error: any) => error.revert?.name === name;

test("anyone has a withdrawal paid, once, out of its channel's deposits first and house cash for the rest", async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, stranger] = env.wallets,
    recipient = Wallet.createRandom().address,
    ch = await open(f, a, 1000n);
  await (await f.contract.fundBankroll({ value: 100n })).wait();
  const won = await signedIncrease(f, ch, 300n),
    all = await step(f, { ...ch, ...won }, 5, 1300n, { recipient });
  // Short of house cash for its winnings, it pays nothing and can be sent again once there is cash.
  await assert.rejects(f.contract.connect(stranger).withdraw.staticCall(all.evidence), reverts('InsufficientBalance'));
  await (await f.contract.fundBankroll({ value: 200n })).wait();
  await (await f.contract.connect(stranger).withdraw(all.evidence)).wait();
  assert.equal(await env.provider.getBalance(recipient), 1300n);
  const c = await f.contract.channels(ch.opening.channelId);
  assert.deepEqual([c.principal, c.paidOut], [0n, 1300n]);
  assert.deepEqual([await f.contract.protectedPrincipal(), await f.contract.withdrawableHouse()], [0n, 0n]);
  assert.equal(await f.contract.withdrawals(hashOperation(f.d, all.evidence.step.operation)), true);
  // Once only. A close on the state before it is owed what that state held less what was paid out since: nothing.
  await assert.rejects(f.contract.withdraw.staticCall(all.evidence), reverts('InvalidState'));
  await (await f.contract.connect(a).startClose(won.evidence)).wait();
  assert.equal((await f.contract.channels(ch.opening.channelId)).closingBalance, 0n);
  // Only a withdrawal or a transfer names a recipient, and none pays the contract: the contract refuses either before
  // it looks at the casino's signature.
  const naming = async (kind: number, to: string) => {
    const op = operation(f.d, won.state, { kind, amount: 1n, recipient: to, memo: id('names a recipient') });
    const authorization = await a.signTypedData(f.d, OP_TYPES, op);
    return {
      ...won.evidence,
      step: { operation: op, authorization, seed: ZeroHash, secret: ZeroHash, casinoSignature: '0x' },
    };
  };
  await assert.rejects(f.contract.supported(await naming(2, recipient)), reverts('InvalidTerms'));
  await assert.rejects(f.contract.supported(await naming(5, await f.contract.getAddress())), reverts('InvalidTerms'));
});

test("a transfer deposits into another account's current channel, and locking in is one into the account's own", async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, friend] = env.wallets,
    ch = await open(f, a, 1000n);
  // A friend with no channel yet: the transfer opens one.
  const sent = await step(f, ch, 6, 400n, { recipient: friend.address });
  await (await f.contract.withdraw(sent.evidence)).wait();
  const theirs = await f.contract.channels(channelId(friend.address, 0));
  assert.deepEqual(
    [theirs.player, theirs.status, theirs.deposited, theirs.principal],
    [friend.address, 1n, 400n, 400n],
  );
  assert.equal((await f.contract.channels(ch.opening.channelId)).principal, 600n);
  assert.equal(await f.contract.protectedPrincipal(), 1000n);
  // Winnings above the deposits are locked in by transferring the whole balance to the account itself: its deposits
  // pay back what they cover, house cash the rest, and all of it comes back in as deposits.
  await (await f.contract.fundBankroll({ value: 500n })).wait();
  const won = await signedIncrease(f, { ...ch, state: sent.state }, 300n),
    locked = await step(f, { ...ch, ...won }, 6, 900n, { recipient: a.address });
  await (await f.contract.withdraw(locked.evidence)).wait();
  const mine = await f.contract.channels(ch.opening.channelId);
  assert.deepEqual([mine.deposited, mine.principal], [1900n, 900n]);
  assert.equal(await f.contract.withdrawableHouse(), 200n);
});

test('a close moves the account to its next channel at once, and withdrawals are paid until it is final', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a] = env.wallets,
    recipient = Wallet.createRandom().address,
    ch = await open(f, a, 1000n);
  const out = await step(f, ch, 5, 300n, { recipient }),
    after = await countersigned(f, ch, out),
    later = await step(f, { ...ch, state: out.state, evidence: after }, 5, 100n, { recipient }),
    closing = () => f.contract.channels(ch.opening.channelId);
  // The closing state withdrew 300 the contract has not paid: until it does, the close is owed it back.
  await (await f.contract.connect(a).startClose(after)).wait();
  assert.equal((await closing()).closingBalance, 1000n);
  assert.equal(await f.contract.channelIndex(a.address), 1n);
  // The account deposits into its next channel while this one closes.
  await (await f.contract.connect(a).deposit(a.address, { value: 50n })).wait();
  assert.equal((await f.contract.channels(channelId(a.address, 1))).deposited, 50n);
  // Each withdrawal paid during the close, the one it includes and one after it, lowers what the close is owed.
  await (await f.contract.withdraw(out.evidence)).wait();
  assert.equal((await closing()).closingBalance, 700n);
  await (await f.contract.withdraw(later.evidence)).wait();
  assert.equal((await closing()).closingBalance, 600n);
  assert.equal(await env.provider.getBalance(recipient), 400n);
  await env.provider.send('evm_increaseTime', [86401]);
  await env.provider.send('evm_mine', []);
  await (await f.contract.finalizeClose(ch.opening.channelId)).wait();
  assert.equal((await f.contract.claims(ch.opening.channelId)).protectedRemaining, 600n);
  const last = await step(f, { ...ch, state: later.state, evidence: await countersigned(f, ch, later) }, 5, 1n, {
    recipient,
  });
  await assert.rejects(f.contract.withdraw.staticCall(last.evidence), reverts('InvalidState'));
});

test('a withdrawal the contract never paid comes back with the close, its deposits protected', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a] = env.wallets,
    ch = await open(f, a, 1000n);
  // All of a winning balance, which house cash cannot pay: the withdrawal waits, and the channel closes first.
  const won = await signedIncrease(f, ch, 500n),
    all = await step(f, { ...ch, ...won }, 5, 1500n, { recipient: Wallet.createRandom().address });
  await assert.rejects(f.contract.withdraw.staticCall(all.evidence), reverts('InsufficientBalance'));
  await forceClose(f, env, ch, all.evidence);
  // The close is owed what the state withdrew and the contract never paid: its deposits in full, the rest as winnings.
  const claim = await f.contract.claims(ch.opening.channelId);
  assert.deepEqual([claim.amount, claim.protectedRemaining, claim.winningsRemaining], [1500n, 1000n, 500n]);
  await (await f.contract.fundBankroll({ value: 500n })).wait();
  await (await f.contract.claim(ch.opening.channelId)).wait();
  assert.equal((await f.contract.claims(ch.opening.channelId)).paid, 1500n);
});

test('withdrawal ordering and a newer challenge preserve the exact settlement entitlement', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    ch = await open(f, env.wallets[1], 100n),
    recipient = env.wallets[2].address,
    loss = await step(f, ch, 2, 60n),
    lossEvidence = await countersigned(f, ch, loss),
    win = await signedIncrease(f, { ...ch, ...loss }, 100n),
    first = await step(f, { ...ch, ...win }, 5, 30n, { recipient }),
    second = await step(f, { ...ch, state: first.state, evidence: await countersigned(f, ch, first) }, 5, 60n, {
      recipient,
    });
  await (await f.contract.deposit(ch.player.address, { value: 20n })).wait();
  await (await f.contract.fundBankroll({ value: 100n })).wait();
  const permutations = (items: string[]): string[][] =>
    items.length
      ? items.flatMap(item => permutations(items.filter(other => other !== item)).map(rest => [item, ...rest]))
      : [[]];
  const orders = permutations(['first', 'second', 'close', 'challenge']).filter(
    order => order.indexOf('close') < order.indexOf('challenge'),
  );
  assert.equal(orders.length, 12);
  for (const order of orders) {
    const snapshot = await env.provider.send('evm_snapshot', []);
    let paid = 0n,
      closing = false,
      challenged = false;
    for (const action of order) {
      if (action === 'close') {
        await (await f.contract.startClose(lossEvidence)).wait();
        closing = true;
      } else if (action === 'challenge') {
        await (await f.contract.challengeClose(second.evidence)).wait();
        challenged = true;
      } else {
        await (await f.contract.withdraw(action === 'first' ? first.evidence : second.evidence)).wait();
        paid += action === 'first' ? 30n : 60n;
      }
      const c = await f.contract.channels(ch.state.channelId);
      assert.equal(c.paidOut, paid, order.join(', '));
      assert.equal(c.principal, 120n - paid);
      if (closing) {
        // Economic oracle: deposits 120, loss 60, win 100, minus actual payments. The stale close omits the win.
        const due: bigint = 120n - 60n + (challenged ? 100n : 0n) - paid;
        assert.equal(c.closingBalance, due > 0n ? due : 0n, order.join(', '));
      }
    }
    await env.provider.send('evm_increaseTime', [86401]);
    await env.provider.send('evm_mine', []);
    await (await f.contract.finalizeClose(ch.state.channelId)).wait();
    const claim = await f.contract.claims(ch.state.channelId);
    assert.deepEqual([claim.amount, claim.protectedRemaining, claim.winningsRemaining], [70n, 30n, 40n]);
    await (await f.contract.claim(ch.state.channelId)).wait();
    assert.equal((await f.contract.claims(ch.state.channelId)).paid + paid, 160n);
    assert.equal(await f.contract.withdrawableHouse(), 60n);
    assert.equal(await env.provider.send('evm_revert', [snapshot]), true);
  }
});

test("a self-transfer paid during closing protects its funds in the account's next channel", async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    ch = await open(f, env.wallets[1], 100n),
    win = await signedIncrease(f, ch, 50n),
    transfer = await step(f, { ...ch, ...win }, 6, 150n, { recipient: ch.player.address });
  await (await f.contract.fundBankroll({ value: 50n })).wait();
  await (await f.contract.startClose(transfer.evidence)).wait();
  await (await f.contract.withdraw(transfer.evidence)).wait();
  const nextId = await f.contract.channelOf(ch.player.address),
    next = await f.contract.channels(nextId),
    closing = await f.contract.channels(ch.state.channelId);
  assert.notEqual(nextId, ch.state.channelId);
  assert.deepEqual([next.deposited, next.principal, closing.principal, closing.closingBalance], [150n, 150n, 0n, 0n]);
  await env.provider.send('evm_increaseTime', [86401]);
  await env.provider.send('evm_mine', []);
  await (await f.contract.finalizeClose(ch.state.channelId)).wait();
  assert.equal((await f.contract.claims(ch.state.channelId)).amount, 0n);
  assert.equal(await f.contract.protectedPrincipal(), 150n);
  assert.equal(await f.contract.withdrawableHouse(), 0n);
});

test('a bet settles on-chain, and only strictly newer evidence challenges a close', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, b] = env.wallets,
    ch = await open(f, a, 10000n);
  const q = assessBinary({
    bankroll: 1000000n,
    stake: 100n,
    netWin: 100n,
    chance: (OUTCOME_SPACE * 49n) / 100n,
  });
  const bet = await step(f, ch, 1, 100n, { chance: q.chance, prize: q.prize, seed: id('fresh') });
  assert.equal((await f.contract.supported(bet.evidence)).balance, BigInt(bet.state.balance));
  const altered = structuredClone(bet.evidence);
  altered.step.operation.amount = '101';
  await assert.rejects(f.contract.supported(altered));
  await (await f.contract.connect(a).startClose(ch.evidence)).wait();
  const deadline = (await f.contract.channels(ch.opening.channelId)).deadline;
  await (await f.contract.connect(b).challengeClose(bet.evidence)).wait();
  assert.equal((await f.contract.channels(ch.opening.channelId)).deadline, deadline);
  await assert.rejects(f.contract.challengeClose(ch.evidence));
  await assert.rejects(f.contract.finalizeClose(ch.opening.channelId));
  await env.provider.send('evm_increaseTime', [86400]);
  await env.provider.send('evm_mine', []);
  await assert.rejects(f.contract.challengeClose(bet.evidence));
  await (await f.contract.finalizeClose(ch.opening.channelId)).wait();
  assert.equal((await f.contract.claims(ch.opening.channelId)).amount, BigInt(bet.state.balance));
  // A fully signed checkpoint requires no historical replay.
  const cd = await open(f, b, 100n);
  const changed = { ...cd.state, sequence: '100', previousStateHash: id('earlier'), balance: '90' };
  const jointly = checkpointEvidence(
    changed,
    await b.signTypedData(f.d, STATE_TYPES, changed),
    await f.owner.signTypedData(f.d, STATE_TYPES, changed),
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
  cross.base.channelId = b.opening.channelId;
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
  const deadline = (await f.contract.channels(a.opening.channelId)).deadline;
  await env.provider.send('evm_setNextBlockTimestamp', [Number(deadline) - 1]);
  await env.provider.send('evm_mine', []);
  await assert.rejects(f.contract.finalizeClose.staticCall(a.opening.channelId));
  // Re-submitting the proposed state is not a challenge.
  await assert.rejects(f.contract.challengeClose.staticCall(a.evidence));
  await env.provider.send('evm_setNextBlockTimestamp', [Number(deadline)]);
  await env.provider.send('evm_mine', []);
  await assert.rejects(f.contract.challengeClose.staticCall(result.evidence));
  await (await f.contract.finalizeClose(a.opening.channelId)).wait();
  assert.equal((await f.contract.claims(a.opening.channelId)).amount, 1000n);
});

test('a signature is taken only in the form the contract recovers', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    { state, evidence } = await signedIncrease(f, await open(f, env.wallets[1]), 100n),
    owner = await f.owner.getAddress(),
    v = parseInt(evidence.casinoSignature.slice(130), 16);
  await f.contract.supported(evidence);
  assertSignature(f.d, STATE_TYPES, state, evidence.casinoSignature, owner);
  // ethers recovers the owner from the compact form and from a v of 0 or 1; the contract recovers nobody.
  for (const signature of [
    Signature.from(evidence.casinoSignature).compactSerialized,
    evidence.casinoSignature.slice(0, 130) + (v - 27).toString(16).padStart(2, '0'),
  ]) {
    assert.equal(verifyTypedData(f.d, STATE_TYPES, state, signature), owner);
    await assert.rejects(f.contract.supported({ ...evidence, casinoSignature: signature }));
    assert.throws(() => assertSignature(f.d, STATE_TYPES, state, signature, owner), /Invalid signature/);
  }
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
    const state = { ...ch.state, sequence: '2', balance: String(balance) };
    return checkpointEvidence(
      state,
      await ch.player.signTypedData(f.d, STATE_TYPES, state),
      await f.owner.signTypedData(f.d, STATE_TYPES, state),
    );
  }
  // A jointly signed balance at or above the cap is not settlement evidence, however it was produced.
  await assert.rejects(f.contract.supported(await balanceEvidence(a, 1n << 128n)));
  await forceClose(f, env, a, await balanceEvidence(a, max));
  await forceClose(f, env, b, await balanceEvidence(b, 10n));
  assert.equal(await f.contract.unpaidWinnings(), max - 1n + 9n);
  await forceClose(f, env, c);
  await (await f.contract.claim(c.opening.channelId)).wait();
  assert.equal((await f.contract.claims(c.opening.channelId)).paid, 1n);
  await (await f.contract.fundBankroll({ value: 20n })).wait();
  assert.equal(await f.contract.withdrawableHouse(), 0n);
  await (await f.contract.claim(a.opening.channelId)).wait();
  assert.equal(await f.contract.unpaidWinnings(), max - 1n + 9n - 20n);
});

test('offline evidence and the contract enforce the same checkpoint amount bounds', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    ch = await open(f, env.wallets[1], 1n),
    cap = 1n << 128n;
  for (const field of ['balance', 'withdrawn']) {
    for (const amount of [cap - 1n, cap, (1n << 256n) - 1n]) {
      const state = { ...ch.state, [field]: String(amount) },
        evidence = checkpointEvidence(
          state,
          await ch.player.signTypedData(f.d, STATE_TYPES, state),
          await f.owner.signTypedData(f.d, STATE_TYPES, state),
        ),
        bundle = {
          chainId: env.chainId,
          casino: String(f.contract.target),
          operator: f.owner.address,
          opening: ch.opening,
          evidence,
        };
      if (amount < cap) {
        assert.equal((await f.contract.supported(evidence))[field], amount);
        assert.equal(verifyEvidence(bundle).state[field as 'balance' | 'withdrawn'], String(amount));
      } else {
        await assert.rejects(f.contract.supported(evidence), reverts('InvalidState'));
        assert.throws(() => verifyEvidence(bundle), /Balance exceeds the protocol maximum/);
      }
    }
  }
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
  assert.equal((await f.contract.channels(ch.opening.channelId)).status, 1n);
});

test('the winnings queue pays in finalization order, and any claim collects what house cash reaches at once', async t => {
  const env = await anvil(),
    f = await deployment(env);
  t.after(() => env.close());
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const c = await open(f, env.wallets[1], 1n),
      win = await signedIncrease(f, c, 10n);
    await forceClose(f, env, c, win.evidence);
    ids.push(c.opening.channelId);
  }
  assert.equal(await f.contract.unpaidWinnings(), 200n);
  assert.equal(await f.contract.queuedWinnings(), 200n);
  // 127 of house cash covers the first twelve claims' winnings and 7 of the thirteenth's, oldest first.
  await (await f.contract.fundBankroll({ value: 127n })).wait();
  for (let i = 0; i < 20; i++)
    assert.equal(await f.contract.collectable(ids[i]), 1n + (i < 12 ? 10n : i === 12 ? 7n : 0n));
  // The last claim collects its principal, and the thirteenth what is covered of it, each in one call.
  await (await f.contract.claim(ids[19])).wait();
  assert.equal((await f.contract.claims(ids[19])).paid, 1n);
  await (await f.contract.claim(ids[12])).wait();
  assert.equal((await f.contract.claims(ids[12])).paid, 8n);
  assert.equal(await f.contract.collectable(ids[12]), 0n);
  for (let i = 0; i < 12; i++) assert.equal(await f.contract.collectable(ids[i]), 11n);
  assert.equal(await f.contract.withdrawableHouse(), 0n);
  await (await f.contract.fundBankroll({ value: 73n })).wait();
  for (const channelId of [...ids].reverse()) await (await f.contract.claim(channelId)).wait();
  for (const channelId of ids) assert.equal((await f.contract.claims(channelId)).paid, 11n);
  assert.equal(await f.contract.unpaidWinnings(), 0n);
  assert.equal(await f.contract.protectedPrincipal(), 0n);
  assert.equal(await env.provider.getBalance(await f.contract.getAddress()), 0n);
});

test('a rejecting winnings recipient keeps its share while junior claims collect', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    senior = await open(f, env.wallets[1], 1n),
    win = await signedIncrease(f, senior, 10n),
    artifact = loadArtifact('contracts/test/ClaimReceiver.sol', 'ClaimReceiver'),
    receiver: any = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, f.owner).deploy(
      f.contract.target,
    );
  await receiver.waitForDeployment();
  await forceClose(f, env, senior, win.evidence);
  await (await f.contract.claim(senior.state.channelId)).wait();
  // With no house cash to reach its winnings, the beneficiary can name a recipient before any ETH is sent to it.
  await (await f.contract.connect(senior.player).claimTo(senior.state.channelId, receiver.target)).wait();
  const junior = await open(f, env.wallets[2], 1n),
    juniorWin = await signedIncrease(f, junior, 10n);
  await forceClose(f, env, junior, juniorWin.evidence);
  await (await f.contract.fundBankroll({ value: 20n })).wait();
  assert.equal(await f.contract.collectable(senior.state.channelId), 10n);
  const before = await f.contract.claims(senior.state.channelId);
  const rejected = await f.contract.claim(senior.state.channelId, { gasLimit: 500000n });
  await assert.rejects(rejected.wait());
  assert.deepEqual((await f.contract.claims(senior.state.channelId)).toArray(), before.toArray());
  assert.equal(await f.contract.collectable(senior.state.channelId), 10n);
  assert.equal(await f.contract.unpaidWinnings(), 20n);
  await (await f.contract.claim(junior.state.channelId)).wait();
  assert.equal((await f.contract.claims(junior.state.channelId)).paid, 11n);
  // The senior's share stays covered: nothing is left for the house.
  assert.equal(await f.contract.collectable(senior.state.channelId), 10n);
  assert.equal(await f.contract.withdrawableHouse(), 0n);
  await assert.rejects(f.contract.claimTo.staticCall(senior.state.channelId, f.owner.address), reverts('Unauthorized'));
  await (await f.contract.connect(senior.player).claimTo(senior.state.channelId, senior.player.address)).wait();
  assert.equal((await f.contract.claims(senior.state.channelId)).paid, 11n);
  assert.equal(await f.contract.unpaidWinnings(), 0n);
});

test('the account countersigns the checkpoint a step reached', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    ch = await open(f, env.wallets[1], 50n),
    spent = await step(f, ch, 2, 20n);
  assert.equal((await f.contract.supported(await countersigned(f, ch, spent))).balance, 30n);
});
