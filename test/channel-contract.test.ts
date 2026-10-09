import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContractFactory,
  id,
  Signature,
  solidityPackedKeccak256,
  TypedDataEncoder,
  verifyTypedData,
  Wallet,
  ZeroAddress,
  ZeroHash,
} from 'ethers';
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
  claimOf,
  channelAt,
  current,
  disputedBet,
  offered,
  reverts,
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
  owed,
  hashState,
  QUOTE_TYPES,
  OFFER_TYPES,
  protection,
  recordWithdrawals,
} from '../protocol/protocol.ts';
import { admits, MAX_BALANCE, OUTCOME_SPACE } from '../protocol/risk.ts';

test('a channel is its account and index: active from the start with nothing to open, anyone deposits into it, and a close moves the account to its next one', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, b, c] = env.wallets;
  // Someone else's deposit goes into the account's current channel; the account's own adds to the same one.
  const ch = await fund(f, a, 500n, b);
  assert.deepEqual([ch.opening.channelId, await f.contract.channelIndex(a.address)], [channelId(a.address, 0n), 0n]);
  await (await f.contract.connect(a).deposit(a.address, { value: 300n })).wait();
  const onchain = await channelAt(f, ch.opening);
  assert.deepEqual([onchain.status, onchain.deposited, onchain.principal], [0n, 800n, 800n]);
  assert.equal(await f.contract.protectedFunds(), 800n);
  // A deposit is of something, into an account.
  for (const to of [ZeroAddress, await f.contract.getAddress()])
    await assert.rejects(f.contract.connect(b).deposit.staticCall(to, { value: 1n }), reverts('InvalidTerms'));
  await assert.rejects(f.contract.connect(b).deposit.staticCall(a.address), reverts('InvalidTerms'));
  // An account the chain holds nothing for has its channel all the same: it closes on its base, owed nothing.
  const d = await current(f, env.wallets[4]);
  await (await f.contract.connect(env.wallets[4]).startClose(d.base)).wait();
  const untouched = await channelAt(f, d.opening);
  assert.deepEqual([untouched.status, untouched.closingBalance], [1n, 0n]);
  assert.equal(await f.contract.channelIndex(d.opening.player), 1n);
  // The base needs no signature, and is owed every deposit it has not taken in; any other checkpoint needs both.
  assert.equal((await f.contract.supported(ch.base)).balance, 0n);
  await assert.rejects(f.contract.supported(checkpointEvidence({ ...ch.state, balance: '1' })));
  // A checkpoint that took in more than the chain holds pays no withdrawal.
  const over = await step(f, ch, 4, 801n),
    overdrawn = await step(f, { ...ch, state: over.state, evidence: await countersigned(f, ch, over) }, 5, 801n, {
      recipient: c.address,
    });
  await assert.rejects(f.contract.withdraw.staticCall(overdrawn.evidence), reverts('InvalidState'));
  const taken = await step(f, ch, 4, 800n);
  assert.equal((await f.contract.supported(taken.evidence)).deposited, 800n);
  // Only the account, or the casino, starts a close.
  await assert.rejects(f.contract.connect(c).startClose.staticCall(ch.base));
  await (await f.contract.connect(a).startClose(ch.base)).wait();
  assert.equal((await channelAt(f, ch.opening)).closingBalance, 800n);
  // A close that starts ends the channel for the account: its next one takes play and money, where nothing of the first
  // settles, while the first closes.
  assert.equal(await f.contract.channelIndex(a.address), 1n);
  const next = await open(f, a, 100n, b);
  await env.provider.send('evm_increaseTime', [7 * 86400 + 1]);
  await env.provider.send('evm_mine', []);
  await (await f.contract.finalizeClose(ch.opening.player, ch.opening.index)).wait();
  assert.equal((await claimOf(f, ch.opening)).protectedRemaining, 800n);
  assert.equal(next.opening.channelId, channelId(a.address, 1n));
  await assert.rejects(f.contract.connect(a).startClose.staticCall(taken.evidence));
  const cross = structuredClone(taken.evidence);
  cross.base.index = '1';
  await assert.rejects(f.contract.supported(cross));
  await (await f.contract.claim(ch.opening.channelId)).wait();
  assert.equal((await claimOf(f, ch.opening)).paid, 800n);
});

test('anyone has a withdrawal made a claim, once: paid at once as far as deposits and house cash go, the rest in turn', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, stranger] = env.wallets,
    recipient = Wallet.createRandom().address,
    ch = await open(f, a, 1000n);
  await (await f.contract.fundBankroll({ value: 100n })).wait();
  const won = await signedIncrease(f, ch, 300n),
    all = await step(f, { ...ch, ...won }, 5, 1300n, { recipient }),
    claimId = hashOperation(f.d, all.evidence.step.operation);
  // Short of house cash for its winnings, it pays the deposits and the house cash there is, and owes the rest.
  await (await f.contract.connect(stranger).withdraw(all.evidence)).wait();
  assert.equal(await env.provider.getBalance(recipient), 1100n);
  let claim = await f.contract.claims(claimId);
  assert.deepEqual(
    [claim.beneficiary, claim.recipient, claim.protectedRemaining, claim.winningsRemaining],
    [a.address, recipient, 0n, 200n],
  );
  const c = await channelAt(f, ch.opening);
  assert.deepEqual([c.principal, c.claimed], [0n, 1300n]);
  assert.deepEqual(
    [await f.contract.protectedFunds(), await f.contract.unpaidWinnings(), await f.contract.withdrawableHouse()],
    [0n, 200n, 0n],
  );
  // The rest once there is cash, collected by anyone.
  assert.equal(await f.contract.collectable(claimId), 0n);
  await (await f.contract.fundBankroll({ value: 200n })).wait();
  assert.equal(await f.contract.collectable(claimId), 200n);
  await (await f.contract.connect(stranger).claim(claimId)).wait();
  assert.equal(await env.provider.getBalance(recipient), 1300n);
  claim = await f.contract.claims(claimId);
  assert.deepEqual([claim.protectedRemaining, claim.winningsRemaining], [0n, 0n]);
  // Once only. A close on the state before it is owed what that state held less what became claims since: nothing.
  await assert.rejects(f.contract.withdraw.staticCall(all.evidence), reverts('InvalidState'));
  await (await f.contract.connect(a).startClose(won.evidence)).wait();
  assert.equal((await channelAt(f, ch.opening)).closingBalance, 0n);
  // Only a withdrawal names a recipient, never nobody and never the contract: the contract refuses any other, a lock-in
  // among them, before it looks at the casino's signature. There is no other kind.
  const naming = async (kind: number, to: string) => {
    const op = operation(f.d, won.state, { kind, amount: 1n, recipient: to, memo: id('names a recipient') });
    const authorization = await a.signTypedData(f.d, OP_TYPES, op);
    return {
      ...won.evidence,
      step: { operation: op, authorization, seed: ZeroHash, secret: ZeroHash, casinoSignature: '0x' },
    };
  };
  for (const kind of [2, 6])
    for (const to of [recipient, a.address, await f.contract.getAddress()])
      await assert.rejects(f.contract.supported(await naming(kind, to)), reverts('InvalidTerms'));
  for (const nobody of [ZeroAddress, await f.contract.getAddress()])
    await assert.rejects(f.contract.supported(await naming(5, nobody)), reverts('InvalidTerms'));
  await assert.rejects(f.contract.supported(await naming(8, recipient)), reverts('InvalidTerms'));
});

test('a withdrawal to a recipient that refuses payment is still a claim, owed in full, which its account redirects', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, other] = env.wallets,
    to = Wallet.createRandom().address,
    ch = await open(f, a, 1000n),
    artifact = loadArtifact('contracts/test/ClaimReceiver.sol', 'ClaimReceiver'),
    receiver: any = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, f.owner).deploy(
      f.contract.target,
    );
  await receiver.waitForDeployment();
  await (await f.contract.fundBankroll({ value: 100n })).wait();
  const won = await signedIncrease(f, ch, 100n),
    out = await step(f, { ...ch, ...won }, 5, 1100n, { recipient: String(receiver.target) }),
    claimId = hashOperation(f.d, out.evidence.step.operation);
  // Sent once, and recorded although the recipient refuses: nobody has to send it again.
  await (await f.contract.withdraw(out.evidence)).wait();
  const claim = await f.contract.claims(claimId);
  assert.deepEqual(
    [claim.beneficiary, claim.recipient, claim.protectedRemaining, claim.winningsRemaining],
    [a.address, String(receiver.target), 1000n, 100n],
  );
  assert.deepEqual([await f.contract.protectedFunds(), await f.contract.unpaidWinnings()], [1000n, 100n]);
  await assert.rejects(f.contract.withdraw.staticCall(out.evidence), reverts('InvalidState'));
  await assert.rejects(f.contract.claim.staticCall(claimId), reverts('TransferFailed'));
  // Only the account redirects it, and the claim pays in full there.
  await assert.rejects(f.contract.connect(other).claimTo.staticCall(claimId, to), reverts('Unauthorized'));
  await (await f.contract.connect(a).claimTo(claimId, to)).wait();
  assert.equal(await env.provider.getBalance(to), 1100n);
  assert.deepEqual([await f.contract.protectedFunds(), await f.contract.unpaidWinnings()], [0n, 0n]);
});

test("a withdrawal pays any address, a friend's HookedIn address among them, and a lock-in puts the balance into the account's channel", async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a] = env.wallets,
    friend = Wallet.createRandom().address,
    ch = await open(f, a, 1000n);
  // A friend's HookedIn address: the friend's wallet puts what arrives there into the friend's balance.
  const sent = await step(f, ch, 5, 400n, { recipient: friend });
  await (await f.contract.withdraw(sent.evidence)).wait();
  assert.equal(await env.provider.getBalance(friend), 400n);
  assert.deepEqual([(await channelAt(f, ch.opening)).principal, await f.contract.protectedFunds()], [600n, 600n]);
  // Winnings above the deposits are locked in with the whole balance: its deposits pay what they cover, house cash the
  // rest, and all of it goes into the account's current channel as deposits. No ETH moves.
  await (await f.contract.fundBankroll({ value: 500n })).wait();
  const contract = await f.contract.getAddress(),
    won = await signedIncrease(f, { ...ch, state: sent.state }, 300n),
    locked = await step(f, { ...ch, ...won }, 6, 900n),
    held = await env.provider.getBalance(contract);
  await (await f.contract.withdraw(locked.evidence)).wait();
  assert.equal(await env.provider.getBalance(contract), held);
  const mine = await channelAt(f, ch.opening),
    claim = await f.contract.claims(hashOperation(f.d, locked.evidence.step.operation));
  assert.deepEqual([mine.deposited, mine.principal], [1900n, 900n]);
  // Paid in full at once, it leaves no claim: the channel's `claimed` records it.
  assert.deepEqual([claim.beneficiary, mine.claimed], [ZeroAddress, 1300n]);
  assert.deepEqual([await f.contract.protectedFunds(), await f.contract.unpaidWinnings()], [900n, 0n]);
  assert.equal(await f.contract.withdrawableHouse(), 200n);
});

test('a lock-in house cash cannot cover yet goes in as far as it reaches, and the rest once anyone collects it', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    ch = await open(f, env.wallets[1], 1000n),
    won = { ...ch, ...(await signedIncrease(f, ch, 500n)) },
    locked = await step(f, won, 6, 1500n),
    claimId = hashOperation(f.d, locked.evidence.step.operation),
    mine = async () => {
      const c = await channelAt(f, ch.opening);
      return [c.deposited, c.principal];
    };
  // With no house cash, the deposits go back in at once and the 500 of winnings wait in the queue.
  await (await f.contract.withdraw(locked.evidence)).wait();
  assert.deepEqual(await mine(), [2000n, 1000n]);
  assert.equal((await f.contract.claims(claimId)).winningsRemaining, 500n);
  await (await f.contract.fundBankroll({ value: 500n })).wait();
  await (await f.contract.connect(env.wallets[8]).claim(claimId)).wait();
  assert.deepEqual(await mine(), [2500n, 1500n]);
  assert.deepEqual([await f.contract.protectedFunds(), await f.contract.unpaidWinnings()], [1500n, 0n]);
});

test('a lock-in records after the withdrawals signed before it, so it locks in all that is left', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    ch = await open(f, env.wallets[1], 1000n);
  await (await f.contract.fundBankroll({ value: 1000n })).wait();
  // 500 won; 500 withdrawn to someone, then the other 1000 locked in.
  const won = { ...ch, ...(await signedIncrease(f, ch, 500n)) },
    out = await step(f, won, 5, 500n, { recipient: Wallet.createRandom().address }),
    lock = await step(f, { ...ch, state: out.state, evidence: await countersigned(f, won, out) }, 6, 1000n);
  // Sent first, the lock-in would leave half of what it locks in unprotected: it waits for the withdrawal.
  await assert.rejects(f.contract.withdraw.staticCall(lock.evidence), reverts('InvalidState'));
  await (await f.contract.withdraw(out.evidence)).wait();
  await (await f.contract.withdraw(lock.evidence)).wait();
  const c = await channelAt(f, ch.opening);
  assert.deepEqual([c.principal, c.deposited, c.claimed], [1000n, 2000n, 1500n]);
  // Once only.
  await assert.rejects(f.contract.withdraw.staticCall(out.evidence), reverts('InvalidState'));
});

test("a withdrawal pays the casino its fee out of the balance, and a deposit's fee the casino paid into it comes out of house cash", async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a] = env.wallets,
    recipient = Wallet.createRandom().address;
  await (await f.contract.fundBankroll({ value: 1000n })).wait();
  // 1000 deposited and its network fee of 10 paid by the casino, a credit: the balance holds 1010, and a withdrawal of
  // 600 with a fee of 5 takes 605 of it. The recipient is paid the 600, and the close is owed the 405 left.
  const deposited = await open(f, a, 1000n),
    paid = await step(f, deposited, 3, 10n),
    ch = { ...deposited, state: paid.state, evidence: await countersigned(f, deposited, paid) },
    out = await step(f, ch, 5, 600n, { recipient, fee: 5n });
  assert.deepEqual([out.state.balance, out.state.withdrawn], ['405', '600']);
  await (await f.contract.withdraw(out.evidence)).wait();
  assert.equal(await env.provider.getBalance(recipient), 600n);
  await forceClose(f, env, ch, await countersigned(f, ch, out), a);
  assert.equal((await claimOf(f, ch.opening)).amount, 405n);
  // House cash pays what the deposits do not: the 10 the casino paid, less the 5 fee it kept.
  assert.equal(await f.contract.withdrawableHouse(), 995n);
});

test('a withdrawal draws only on the deposits its checkpoint took in, so a deposit that lands before it is recorded stays protected', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, b] = env.wallets,
    recipient = Wallet.createRandom().address;
  await (await f.contract.fundBankroll({ value: 1000n })).wait();
  // 1000 deposited and 500 won, all 1500 withdrawn; the account deposits 500 more before anyone sends it.
  const ch = await open(f, a, 1000n),
    won = { ...ch, ...(await signedIncrease(f, ch, 500n)) },
    out = await step(f, won, 5, 1500n, { recipient });
  await (await f.contract.connect(a).deposit(a.address, { value: 500n })).wait();
  await (await f.contract.withdraw(out.evidence)).wait();
  // House cash pays the winnings, and the late deposit stays the channel's: its close is owed it, all protected.
  assert.equal(await env.provider.getBalance(recipient), 1500n);
  assert.equal((await channelAt(f, ch.opening)).principal, 500n);
  assert.equal(await f.contract.withdrawableHouse(), 500n);
  await forceClose(f, env, ch, await countersigned(f, won, out), a);
  const close = await claimOf(f, ch.opening);
  assert.deepEqual([close.amount, close.protectedRemaining, close.winningsRemaining], [500n, 500n, 0n]);
  // A lock-in the same: 1500 locked in beside a late deposit of 500 leaves all 2000 protected.
  const other = await open(f, b, 1000n),
    lock = await step(f, { ...other, ...(await signedIncrease(f, other, 500n)) }, 6, 1500n);
  await (await f.contract.connect(b).deposit(b.address, { value: 500n })).wait();
  await (await f.contract.withdraw(lock.evidence)).wait();
  const c = await channelAt(f, other.opening);
  assert.deepEqual([c.deposited, c.principal], [3000n, 2000n]);
  assert.equal(await f.contract.withdrawableHouse(), 0n);
});

test('what the wallet shows protecting a balance is what the close protects once the withdrawals it owes are recorded', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, buyer] = env.wallets,
    recipient = Wallet.createRandom().address,
    now = BigInt((await env.provider.getBlock('latest'))!.timestamp),
    after = async (ch: any, result: any) => ({
      ...ch,
      state: result.state,
      evidence: await countersigned(f, ch, result),
    });
  await (await f.contract.fundBankroll({ value: 1000n })).wait();
  // 100 deposited, 50 of collateral bought and 200 won; 250 withdrawn, then 100 more deposited and taken in, 20
  // withdrawn, 30 more deposited and not taken in, and 100 more won. Neither withdrawal is recorded yet.
  let ch: any = await open(f, a, 100n);
  await (await offered(f, ch.opening, 50n, 0n, now + 3600n)).buy(buyer);
  ch = { ...ch, ...(await signedIncrease(f, ch, 200n)) };
  const first = await step(f, ch, 5, 250n, { recipient });
  ch = await after(ch, first);
  await (await f.contract.connect(a).deposit(a.address, { value: 100n })).wait();
  ch = await after(ch, await step(f, ch, 4, 100n));
  const second = await step(f, ch, 5, 20n, { recipient });
  ch = await after(ch, second);
  await (await f.contract.connect(a).deposit(a.address, { value: 30n })).wait();
  ch = { ...ch, ...(await signedIncrease(f, ch, 100n)) };
  const shown = protection(
    ch.state,
    await channelAt(f, ch.opening),
    [first, second].map(({ evidence }) => ({
      amount: evidence.step.operation.amount,
      deposited: evidence.base.deposited,
    })),
  );
  // The first is paid out of the 100 its checkpoint took in and the collateral, the second out of the later deposit,
  // and the rest of the deposits protect the balance of 260.
  assert.deepEqual([shown.covered, shown.uncovered, shown.missing, shown.spare], [110n, 150n, 0n, 0n]);
  for (const { evidence } of [first, second]) await (await f.contract.withdraw(evidence)).wait();
  await forceClose(f, env, ch);
  const close = await claimOf(f, ch.opening);
  assert.deepEqual([close.protectedRemaining, close.winningsRemaining], [shown.covered, shown.uncovered]);
});

test("anyone buys the casino's collateral offer for a channel, once and before it expires, and it pays the channel's winnings before house cash", async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, buyer] = env.wallets,
    recipient = Wallet.createRandom().address,
    ch = await open(f, a, 1000n),
    now = BigInt((await env.provider.getBlock('latest'))!.timestamp);
  await (await f.contract.fundBankroll({ value: 1000n })).wait();
  const { offer, buy, attempt } = await offered(f, ch.opening, 600n, 6n, now + 3600n);
  // The buyer pays the price the casino signed, no other.
  await assert.rejects(attempt(buyer, 5n), reverts('Unauthorized'));
  await buy(buyer);
  const c = await channelAt(f, ch.opening);
  assert.deepEqual([c.principal, c.collateral, c.deposited], [1000n, 600n, 1000n]);
  assert.deepEqual(
    [await f.contract.protectedFunds(), await f.contract.collateralSales(), await f.contract.withdrawableHouse()],
    [1600n, 6n, 406n],
  );
  assert.equal(await f.contract.offersBought(TypedDataEncoder.hash(f.d, OFFER_TYPES, offer.message)), true);
  // The owner cannot take it back, and nobody buys an offer twice.
  await assert.rejects(f.contract.withdrawHouse.staticCall(f.owner.address, 407n), reverts('InsufficientBalance'));
  await assert.rejects(attempt(buyer), reverts('InvalidState'));
  // Nor beyond house cash, for a channel that is not its account's current one or closing, or once the offer has
  // expired.
  await assert.rejects(
    (await offered(f, ch.opening, 407n, 0n, now + 3600n)).attempt(buyer),
    reverts('InsufficientBalance'),
  );
  await assert.rejects(
    (await offered(f, { player: buyer.address, index: 1 }, 1n, 0n, now + 3600n)).attempt(buyer),
    reverts('InvalidState'),
  );
  const late = await offered(f, ch.opening, 1n, 0n, now + 60n);
  await env.provider.send('evm_increaseTime', [120]);
  await env.provider.send('evm_mine', []);
  await assert.rejects(late.attempt(buyer), reverts('InvalidState'));
  // 800 won, and all 1800 withdrawn: the deposits pay 1000, the collateral 600 and house cash only the last 200.
  const won = { ...ch, ...(await signedIncrease(f, ch, 800n)) },
    out = await step(f, won, 5, 1800n, { recipient });
  await (await f.contract.withdraw(out.evidence)).wait();
  assert.equal(await env.provider.getBalance(recipient), 1800n);
  const after = await channelAt(f, ch.opening);
  assert.deepEqual([after.principal, after.collateral], [0n, 0n]);
  assert.deepEqual([await f.contract.protectedFunds(), await f.contract.withdrawableHouse()], [0n, 206n]);
});

test('a close is paid out of the collateral what its deposits do not cover, a lock-in makes it deposits, and what the account lost returns to house cash', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, b] = env.wallets,
    now = BigInt((await env.provider.getBlock('latest'))!.timestamp);
  await (await f.contract.fundBankroll({ value: 2000n })).wait();
  // An offer at no price is collateral the casino gives. 300 won: the close is owed 1300, all of it protected.
  const ch = await open(f, a, 1000n),
    later = now + 30n * 86400n;
  await (await offered(f, ch.opening, 500n, 0n, later)).buy(a);
  await forceClose(f, env, { ...ch, ...(await signedIncrease(f, ch, 300n)) }, undefined, a);
  const close = await claimOf(f, ch.opening);
  assert.deepEqual([close.amount, close.protectedRemaining, close.winningsRemaining], [1300n, 1300n, 0n]);
  assert.equal((await channelAt(f, ch.opening)).collateral, 0n);
  assert.deepEqual([await f.contract.protectedFunds(), await f.contract.withdrawableHouse()], [1300n, 1700n]);
  // A lock-in draws the deposits, then the collateral, and puts all of it back as deposits.
  const other = await open(f, b, 1000n);
  await (await offered(f, other.opening, 500n, 0n, later)).buy(b);
  const won = { ...other, ...(await signedIncrease(f, other, 300n)) },
    lock = await step(f, won, 6, 1300n);
  await (await f.contract.withdraw(lock.evidence)).wait();
  let c = await channelAt(f, other.opening);
  assert.deepEqual([c.deposited, c.principal, c.collateral], [2300n, 1300n, 200n]);
  // 900 lost after it: the close is owed 400, and the other 900 of deposits and the 200 of collateral return to house
  // cash.
  const taken = await step(f, { ...other, state: lock.state, evidence: await countersigned(f, won, lock) }, 4, 1300n),
    lost = await step(
      f,
      { ...other, state: taken.state, evidence: await countersigned(f, { ...other, state: lock.state }, taken) },
      2,
      900n,
    );
  await forceClose(
    f,
    env,
    { ...other, evidence: await countersigned(f, { ...other, state: taken.state }, lost) },
    undefined,
    b,
  );
  c = await channelAt(f, other.opening);
  assert.deepEqual([c.closingBalance, c.principal, c.collateral], [400n, 0n, 0n]);
  assert.equal((await claimOf(f, other.opening)).protectedRemaining, 400n);
  assert.equal(await f.contract.protectedFunds(), 1700n);
});

test('a close nets out what a checkpoint took in that the chain does not hold, so every signed checkpoint closes', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    ch = await open(f, env.wallets[1], 1000n);
  // A take-in of 500 the chain does not hold (a reorganisation took the deposit back), then 300 won.
  const phantom = await step(f, ch, 4, 500n),
    taken = { ...ch, state: phantom.state, evidence: await countersigned(f, ch, phantom) },
    won = await signedIncrease(f, taken, 300n);
  // A stale close on the base is challenged with the latest checkpoint: owed its 1800 less the 500 never deposited.
  await (await f.contract.connect(env.wallets[1]).startClose(ch.base)).wait();
  assert.equal((await channelAt(f, ch.opening)).closingBalance, 1000n);
  await (await f.contract.challengeClose(won.evidence)).wait();
  assert.equal((await channelAt(f, ch.opening)).closingBalance, 1300n);
});

test('a recipient that needs more gas than recording gives its payment is paid by collecting the claim, with all the gas sent', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    artifact = loadArtifact('contracts/test/ClaimReceiver.sol', 'ClaimReceiver'),
    heavy: any = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, f.owner).deploy(
      f.contract.target,
    );
  await heavy.waitForDeployment();
  await (await heavy.setMode(6)).wait();
  const ch = await open(f, env.wallets[1], 1000n),
    out = await step(f, ch, 5, 500n, { recipient: String(heavy.target) }),
    id = hashOperation(f.d, out.evidence.step.operation);
  // Recording gives the payment too little for it: all of it stays owed, to the same recipient.
  await (await f.contract.withdraw(out.evidence)).wait();
  assert.equal((await f.contract.claims(id)).protectedRemaining, 500n);
  assert.equal(await env.provider.getBalance(String(heavy.target)), 0n);
  // Anyone collects it there, sending it all the gas they give.
  await (await f.contract.connect(env.wallets[2]).claim(id)).wait();
  assert.equal(await env.provider.getBalance(String(heavy.target)), 500n);
  assert.equal((await f.contract.claims(id)).protectedRemaining, 0n);
});

test('a recipient pays for what it returns, and a close owed nothing, or with no winnings, stores only what it needs', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    artifact = loadArtifact('contracts/test/ClaimReceiver.sol', 'ClaimReceiver'),
    chatty: any = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, f.owner).deploy(
      f.contract.target,
    );
  await chatty.waitForDeployment();
  await (await chatty.setMode(4)).wait();
  // Whatever a recipient returns is not copied: it costs the sender no more than the recipient's own gas.
  const a = await open(f, env.wallets[1], 1000n),
    b = await open(f, env.wallets[2], 1000n),
    plain = await step(f, a, 5, 500n, { recipient: Wallet.createRandom().address }),
    returning = await step(f, b, 5, 500n, { recipient: String(chatty.target) });
  const gas = async (evidence: any) => (await (await f.contract.withdraw(evidence)).wait()).gasUsed;
  const extra = (await gas(returning.evidence)) - (await gas(plain.evidence));
  assert.ok(extra < 100000n, `a returning recipient cost ${extra} gas more`);
  assert.equal(await env.provider.getBalance(String(chatty.target)), 500n);
  // A close owed nothing leaves no claim; one owed only principal keeps no place in the winnings queue.
  const lost = await open(f, env.wallets[4], 100n),
    gone = await step(f, lost, 2, 100n);
  await forceClose(f, env, { ...lost, evidence: await countersigned(f, lost, gone) });
  assert.equal((await f.contract.claims(lost.opening.channelId)).beneficiary, ZeroAddress);
  await assert.rejects(f.contract.claim.staticCall(lost.opening.channelId), reverts('InvalidState'));
  const kept = await open(f, env.wallets[5], 100n);
  await forceClose(f, env, kept);
  const claim = await f.contract.claims(kept.opening.channelId);
  assert.deepEqual([claim.protectedRemaining, claim.winningsRemaining, claim.queueEnd], [100n, 0n, 0n]);
  // A close starts only on an active channel, and only its account or the owner starts one.
  await assert.rejects(f.contract.startClose.staticCall(kept.evidence), reverts('InvalidState'));
  await assert.rejects(f.contract.connect(env.wallets[6]).startClose.staticCall(a.evidence), reverts('Unauthorized'));
  // The contract takes no payment of its own house cash.
  await (await f.contract.fundBankroll({ value: 10n })).wait();
  await assert.rejects(f.contract.withdrawHouse.staticCall(f.contract.target, 10n), reverts('TransferFailed'));
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
    closing = () => channelAt(f, ch.opening);
  // The closing state withdrew 300 that is not yet a claim: until it is, the close is owed it back.
  await (await f.contract.connect(a).startClose(after)).wait();
  assert.equal((await closing()).closingBalance, 1000n);
  assert.equal(await f.contract.channelIndex(a.address), 1n);
  // The account deposits into its next channel while this one closes.
  await (await f.contract.connect(a).deposit(a.address, { value: 50n })).wait();
  assert.equal((await channelAt(f, { player: a.address, index: 1 })).deposited, 50n);
  // Each withdrawal paid during the close, the one it includes and one after it, lowers what the close is owed.
  await (await f.contract.withdraw(out.evidence)).wait();
  assert.equal((await closing()).closingBalance, 700n);
  await (await f.contract.withdraw(later.evidence)).wait();
  assert.equal((await closing()).closingBalance, 600n);
  assert.equal(await env.provider.getBalance(recipient), 400n);
  await env.provider.send('evm_increaseTime', [7 * 86400 + 1]);
  await env.provider.send('evm_mine', []);
  await (await f.contract.finalizeClose(ch.opening.player, ch.opening.index)).wait();
  assert.equal((await claimOf(f, ch.opening)).protectedRemaining, 600n);
  const last = await step(f, { ...ch, state: later.state, evidence: await countersigned(f, ch, later) }, 5, 1n, {
    recipient,
  });
  await assert.rejects(f.contract.withdraw.staticCall(last.evidence), reverts('InvalidState'));
});

test('a withdrawal nobody sent comes back with the close, its deposits protected', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a] = env.wallets,
    ch = await open(f, a, 1000n);
  // All of a winning balance, withdrawn and never sent to the contract, and the channel closes first.
  const won = await signedIncrease(f, ch, 500n),
    all = await step(f, { ...ch, ...won }, 5, 1500n, { recipient: Wallet.createRandom().address });
  await forceClose(f, env, ch, all.evidence);
  // The close is owed what the state withdrew and never made a claim: its deposits in full, the rest as winnings.
  const claim = await claimOf(f, ch.opening);
  assert.deepEqual([claim.amount, claim.protectedRemaining, claim.winningsRemaining], [1500n, 1000n, 500n]);
  await (await f.contract.fundBankroll({ value: 500n })).wait();
  await (await f.contract.claim(ch.opening.channelId)).wait();
  assert.equal((await claimOf(f, ch.opening)).paid, 1500n);
});

test('withdrawals are recorded in the order the account signed them, and with a newer challenge settle exactly', async t => {
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
  // A withdrawal records only once every earlier one of its channel has.
  await assert.rejects(f.contract.withdraw.staticCall(second.evidence), reverts('InvalidState'));
  const permutations = (items: string[]): string[][] =>
    items.length
      ? items.flatMap(item => permutations(items.filter(other => other !== item)).map(rest => [item, ...rest]))
      : [[]];
  const orders = permutations(['first', 'second', 'close', 'challenge']).filter(
    order => order.indexOf('close') < order.indexOf('challenge') && order.indexOf('first') < order.indexOf('second'),
  );
  assert.equal(orders.length, 6);
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
      const c = await channelAt(f, ch.opening);
      assert.equal(c.claimed, paid, order.join(', '));
      assert.equal(c.principal, 120n - paid);
      if (closing) {
        // Economic oracle: deposits 120, loss 60, win 100, minus actual payments. The stale close omits the win.
        const due: bigint = 120n - 60n + (challenged ? 100n : 0n) - paid;
        assert.equal(c.closingBalance, due > 0n ? due : 0n, order.join(', '));
      }
    }
    await env.provider.send('evm_increaseTime', [7 * 86400 + 1]);
    await env.provider.send('evm_mine', []);
    await (await f.contract.finalizeClose(ch.opening.player, ch.opening.index)).wait();
    const claim = await claimOf(f, ch.opening);
    assert.deepEqual([claim.amount, claim.protectedRemaining, claim.winningsRemaining], [70n, 30n, 40n]);
    await (await f.contract.claim(ch.opening.channelId)).wait();
    assert.equal((await claimOf(f, ch.opening)).paid + paid, 160n);
    assert.equal(await f.contract.withdrawableHouse(), 60n);
    assert.equal(await env.provider.send('evm_revert', [snapshot]), true);
  }
});

test('a withdrawal on a second history the owner signed draws none of the deposits the first one paid out', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    recipient = Wallet.createRandom().address;
  await (await f.contract.fundBankroll({ value: 1000n })).wait();
  // One history takes in the 10 deposited and withdraws all of it.
  const ch = await open(f, env.wallets[1], 10n);
  await (await f.contract.withdraw((await step(f, ch, 5, 10n, { recipient })).evidence)).wait();
  // Another, from the channel's base, takes in nothing: credited 20, it withdraws 10, then 5, which the contract records
  // after the first history's withdrawal, as the wallet predicts: out of house cash.
  const base = { ...ch, state: ch.base.base, evidence: ch.base },
    credited = { ...base, ...(await signedIncrease(f, base, 20n)) },
    first = await step(f, credited, 5, 10n, { recipient }),
    second = await step(
      f,
      { ...credited, state: first.state, evidence: await countersigned(f, credited, first) },
      5,
      5n,
      { recipient },
    ),
    predicted = recordWithdrawals(await channelAt(f, ch.opening), [{ amount: '5', deposited: '0' }]);
  await (await f.contract.withdraw(second.evidence)).wait();
  const c = await channelAt(f, ch.opening);
  assert.deepEqual([c.principal, c.collateral, predicted.cash], [predicted.principal, predicted.collateral, 5n]);
  assert.equal(await env.provider.getBalance(recipient), 15n);
});

test("a lock-in during a close goes into the account's next channel, and so does a claim collected into the contract", async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    contract = await f.contract.getAddress(),
    ch = await open(f, env.wallets[1], 100n),
    win = await signedIncrease(f, ch, 50n),
    lockIn = await step(f, { ...ch, ...win }, 6, 100n);
  await (await f.contract.fundBankroll({ value: 50n })).wait();
  await (await f.contract.startClose(lockIn.evidence)).wait();
  await (await f.contract.withdraw(lockIn.evidence)).wait();
  assert.equal((await channelAt(f, ch.opening)).closingBalance, 50n);
  // The close moved the account to its next channel: the lock-in goes into it, all of it deposits.
  assert.equal(await f.contract.channelIndex(ch.player.address), 1n);
  const next = async () => {
    const c = await channelAt(f, { player: ch.player.address, index: 1 });
    return [c.status, c.deposited, c.principal];
  };
  assert.deepEqual(await next(), [0n, 100n, 100n]);
  await env.provider.send('evm_increaseTime', [7 * 86400 + 1]);
  await env.provider.send('evm_mine', []);
  await (await f.contract.finalizeClose(ch.opening.player, ch.opening.index)).wait();
  // The close is owed 50 of winnings, which house cash covers: collected into the contract, it joins them.
  await (await f.contract.connect(ch.player).claimTo(ch.opening.channelId, contract)).wait();
  assert.deepEqual(await next(), [0n, 150n, 150n]);
  assert.equal((await claimOf(f, ch.opening)).paid, 50n);
  assert.deepEqual([await f.contract.protectedFunds(), await f.contract.withdrawableHouse()], [150n, 0n]);
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
  const deadline = (await channelAt(f, ch.opening)).deadline;
  await (await f.contract.connect(b).challengeClose(bet.evidence)).wait();
  assert.equal((await channelAt(f, ch.opening)).deadline, deadline);
  await assert.rejects(f.contract.challengeClose(ch.evidence));
  await assert.rejects(f.contract.finalizeClose(ch.opening.player, ch.opening.index));
  await env.provider.send('evm_increaseTime', [7 * 86400]);
  await env.provider.send('evm_mine', []);
  await assert.rejects(f.contract.challengeClose(bet.evidence));
  await (await f.contract.finalizeClose(ch.opening.player, ch.opening.index)).wait();
  assert.equal((await claimOf(f, ch.opening)).amount, BigInt(bet.state.balance));
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

const now = async (env: any) => (await env.provider.getBlock('latest')).timestamp;

test("a casino bet its quote covers is disputed by anyone, closing with it: won until the casino's result at its sequence settles it", async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, stranger] = env.wallets,
    ch = await open(f, a, 1000n);
  await (await f.contract.fundBankroll({ value: 10000n })).wait();
  // A coin flip that pays 1.96 times its stake nets 96, which a virtual bankroll of 5000 admits: 2% of it is 100.
  const terms = {
    virtualBankroll: 5000n,
    expiresAt: (await now(env)) + 86400,
    stake: 100n,
    chance: OUTCOME_SPACE / 2n,
  };
  const bet = await disputedBet(f, ch, { ...terms, prize: 196n });
  assert.ok(admits(5000n, { stake: 100n, chance: OUTCOME_SPACE / 2n, prize: 196n }));
  // Only a bet its quote covers is disputed, and only with the casino's own quote.
  const large = await disputedBet(f, ch, { ...terms, prize: 300n });
  assert.ok(!admits(5000n, { stake: 100n, chance: OUTCOME_SPACE / 2n, prize: 300n }));
  await assert.rejects(f.contract.connect(a).dispute.staticCall(large.evidence, large.terms), reverts('InvalidTerms'));
  const expired = await disputedBet(f, ch, { ...terms, prize: 196n, expiresAt: (await now(env)) - 1 });
  await assert.rejects(
    f.contract.connect(a).dispute.staticCall(expired.evidence, expired.terms),
    reverts('InvalidTerms'),
  );
  const forged = { ...bet.terms, signature: await stranger.signTypedData(f.d, QUOTE_TYPES, bet.quote.message) };
  for (const quote of [forged, { ...bet.terms, virtualBankroll: '5001' }])
    await assert.rejects(f.contract.connect(a).dispute.staticCall(bet.evidence, quote), reverts('Unauthorized'));
  // A settled bet is not a dispute: it has the round's secret and the casino's signature, which a dispute leaves out.
  const settled = await bet.settled();
  for (const step of [
    settled.evidence.step,
    { ...bet.evidence.step, casinoSignature: settled.evidence.step.casinoSignature },
  ])
    await assert.rejects(
      f.contract.connect(a).dispute.staticCall({ ...bet.evidence, step }, bet.terms),
      reverts('InvalidTerms'),
    );
  const house = await f.contract.withdrawableHouse();
  // Anyone sends it for the account, a watchtower among them.
  const tx = await (await f.contract.connect(stranger).dispute(bet.evidence, bet.terms)).wait();
  const events = tx.logs.map((log: any) => f.contract.interface.parseLog(log)),
    event = events.find((e: any) => e?.name === 'BetDisputed'),
    changed = events.find((e: any) => e?.name === 'ChannelChanged');
  const brought = event.args.evidence.toObject(true);
  assert.equal(hashOperation(f.d, brought.step.operation), hashOperation(f.d, bet.op));
  assert.deepEqual(
    [brought.playerSignature, brought.step.authorization, brought.step.seed],
    [bet.evidence.playerSignature, bet.evidence.step.authorization, bet.seed],
  );
  // Counted as won, the checkpoint it leads to proposed, and the account moved on to its next channel. The 96 winning it
  // adds above the deposits moves out of house cash into the channel's collateral.
  const sequence = BigInt(ch.state.sequence) + 1n,
    won = {
      ...ch.state,
      sequence: String(sequence),
      previousStateHash: hashState(f.d, ch.state),
      transitionHash: solidityPackedKeccak256(['bytes32', 'bytes32'], [hashOperation(f.d, bet.op), ZeroHash]),
      balance: '1096',
    };
  let c = await channelAt(f, ch.opening);
  assert.deepEqual(
    [c.status, c.closingSequence, c.closingHash, c.closingBalance, c.disputedPrize],
    [1n, sequence, hashState(f.d, won), 1096n, 196n],
  );
  const disputedUntil = c.deadline;
  assert.deepEqual(
    [disputedUntil, changed.args.channel.deadline],
    [BigInt((await now(env)) + 7 * 86400), disputedUntil],
  );
  assert.deepEqual([c.collateral, c.disputeHold, await f.contract.withdrawableHouse()], [96n, 96n, house - 96n]);
  assert.equal(await f.contract.channelIndex(a.address), 1n);
  // Nothing older settles it, nor another bet the account disputes at its sequence: only the casino's result there.
  await assert.rejects(f.contract.challengeClose.staticCall(ch.evidence), reverts('InvalidState'));
  const again = await disputedBet(f, ch, { ...terms, prize: 196n });
  await assert.rejects(f.contract.dispute.staticCall(again.evidence, again.terms), reverts('InvalidState'));
  await (await f.contract.connect(stranger).challengeClose(settled.evidence)).wait();
  c = await channelAt(f, ch.opening);
  assert.deepEqual(
    [c.closingSequence, c.closingHash, c.closingBalance, c.disputedPrize],
    [sequence, hashState(f.d, settled.state), owed(settled.state, 1000n, 0n), 0n],
  );
  // Settled, the close keeps its deadline, and takes only strictly newer evidence again.
  assert.equal(c.deadline, disputedUntil);
  await assert.rejects(f.contract.challengeClose.staticCall(settled.evidence), reverts('InvalidState'));
});

test('a dispute nobody settles within its 7 days pays the bet as won, and a dispute challenging a close gives the casino a full week', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, b] = env.wallets,
    ch = await open(f, a, 1000n);
  await (await f.contract.fundBankroll({ value: 10000n })).wait();
  const terms = { virtualBankroll: 5000n, stake: 100n, chance: OUTCOME_SPACE / 2n, prize: 196n };
  const bet = await disputedBet(f, ch, { ...terms, expiresAt: (await now(env)) + 3 * 86400 });
  await (await f.contract.connect(a).dispute(bet.evidence, bet.terms)).wait();
  for (const days of [1, 6]) {
    await assert.rejects(
      f.contract.finalizeClose.staticCall(ch.opening.player, ch.opening.index),
      reverts('InvalidState'),
    );
    await env.provider.send('evm_increaseTime', [days * 86400]);
    await env.provider.send('evm_mine', []);
  }
  await assert.rejects(f.contract.challengeClose.staticCall((await bet.settled()).evidence), reverts('InvalidState'));
  await (await f.contract.finalizeClose(ch.opening.player, ch.opening.index)).wait();
  // The finalized channel keeps the prize its close paid as won.
  assert.deepEqual(
    [(await claimOf(f, ch.opening)).amount, (await channelAt(f, ch.opening)).disputedPrize],
    [1096n, 196n],
  );
  // The casino closes b's channel on its base; b disputes its bet two days in, as a challenge, and the casino has a week
  // from then to settle it. Settled half a day before that, the close still ends then.
  const other = await open(f, b, 1000n),
    late = await disputedBet(f, other, { ...terms, expiresAt: (await now(env)) + 3 * 86400 });
  await (await f.contract.connect(f.owner).startClose(other.base)).wait();
  await env.provider.send('evm_increaseTime', [2 * 86400]);
  await env.provider.send('evm_mine', []);
  await (await f.contract.connect(a).dispute(late.evidence, late.terms)).wait();
  const c = await channelAt(f, other.opening);
  assert.equal(c.deadline, BigInt((await now(env)) + 7 * 86400));
  assert.equal(c.disputedPrize, 196n);
  await env.provider.send('evm_increaseTime', [6 * 86400 + 12 * 3600]);
  await env.provider.send('evm_mine', []);
  await (await f.contract.challengeClose((await late.settled()).evidence)).wait();
  const settled = await channelAt(f, other.opening);
  assert.deepEqual([settled.disputedPrize, settled.deadline], [0n, c.deadline]);
});

test("a dispute holds what the bet would win out of free house cash until the casino settles it, and the close's part until it is final", async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a, b, c, d, e] = env.wallets,
    house = () => f.contract.withdrawableHouse(),
    held = async (ch: any) => {
      const channel = await channelAt(f, ch.opening);
      return [channel.collateral, channel.disputeHold];
    },
    later = async (days: number) => {
      await env.provider.send('evm_increaseTime', [days * 86400]);
      await env.provider.send('evm_mine', []);
    };
  // A coin flip that nets 96, or a lottery ticket of 1 wei that nets 3999: a virtual bankroll of 5000 admits both.
  const flip = async () => ({
      virtualBankroll: 5000n,
      expiresAt: (await now(env)) + 86400,
      stake: 100n,
      chance: OUTCOME_SPACE / 2n,
      prize: 196n,
    }),
    ticket = async () => ({ ...(await flip()), stake: 1n, chance: OUTCOME_SPACE >> 32n, prize: 4000n });
  const settledAt = async (ch: any, terms: any, balance: string) => {
    let bet;
    do bet = await disputedBet(f, ch, terms);
    while ((await bet.settled()).state.balance !== balance);
    return bet;
  };
  await (await f.contract.fundBankroll({ value: 10000n })).wait();
  // The owner cannot take the 96 a's flip would win, and a close nobody settles pays it out of the hold.
  const won = await open(f, a, 1000n),
    unsettled = await disputedBet(f, won, await flip());
  await (await f.contract.dispute(unsettled.evidence, unsettled.terms)).wait();
  assert.deepEqual([...(await held(won)), await house()], [96n, 96n, 10000n - 96n]);
  await assert.rejects(f.contract.withdrawHouse.staticCall(f.owner.address, 10000n), reverts('InsufficientBalance'));
  await (await f.contract.withdrawHouse(f.owner.address, 10000n - 96n)).wait();
  await later(7);
  await (await f.contract.finalizeClose(won.opening.player, won.opening.index)).wait();
  assert.deepEqual([...(await held(won)), (await claimOf(f, won.opening)).protectedRemaining], [0n, 0n, 1096n]);
  await (await f.contract.claim(won.opening.channelId)).wait();
  assert.equal((await claimOf(f, won.opening)).paid, 1096n);
  // e's flip the casino settles won: the close keeps what it is owed until it is final.
  await (await f.contract.fundBankroll({ value: 1000n })).wait();
  const kept = await open(f, e, 1000n),
    winning = await settledAt(kept, await flip(), '1096');
  await (await f.contract.dispute(winning.evidence, winning.terms)).wait();
  await (await f.contract.challengeClose((await winning.settled()).evidence)).wait();
  assert.deepEqual([...(await held(kept)), await house()], [96n, 0n, 1000n - 96n]);
  // b's ticket would take all the free house cash, but only until the casino settles it lost.
  const lost = await open(f, b, 1000n),
    ticketBet = await settledAt(lost, await ticket(), '999');
  await (await f.contract.dispute(ticketBet.evidence, ticketBet.terms)).wait();
  assert.deepEqual([...(await held(lost)), await house()], [904n, 904n, 0n]);
  await (await f.contract.challengeClose((await ticketBet.settled()).evidence)).wait();
  assert.deepEqual([...(await held(lost)), await house()], [0n, 0n, 904n]);
  await later(7);
  for (const ch of [kept, lost]) await (await f.contract.finalizeClose(ch.opening.player, ch.opening.index)).wait();
  assert.deepEqual(
    [
      (await claimOf(f, kept.opening)).protectedRemaining,
      (await claimOf(f, lost.opening)).protectedRemaining,
      await house(),
    ],
    [1096n, 999n, 905n],
  );
  // It holds only what the win adds above the deposits, and never more house cash than is free.
  await (await f.contract.withdrawHouse(f.owner.address, 905n - 50n)).wait();
  const opened = await open(f, c, 1000n),
    debit = await step(f, opened, 2, 50n),
    spent = { ...opened, state: debit.state, evidence: await countersigned(f, opened, debit) },
    above = await disputedBet(f, spent, await flip());
  await (await f.contract.dispute(above.evidence, above.terms)).wait();
  assert.deepEqual([...(await held(spent)), await house()], [46n, 46n, 4n]);
  const short = await open(f, d, 1000n),
    capped = await disputedBet(f, short, await flip());
  await (await f.contract.dispute(capped.evidence, capped.terms)).wait();
  assert.deepEqual([...(await held(short)), await house()], [4n, 4n, 0n]);
  // A withdrawal signed before the bet and recorded during the dispute takes the deposits, then the collateral: the hold
  // is no more than what is left of it. 10 deposited and 40 won, 45 withdrawn, then a bet of 5 that would win 95.
  await (await f.contract.fundBankroll({ value: 1000n })).wait();
  const deposited = await open(f, env.wallets[6], 10n),
    up = { ...deposited, ...(await signedIncrease(f, deposited, 40n)) },
    out = await step(f, up, 5, 45n, { recipient: Wallet.createRandom().address }),
    left = { ...up, state: out.state, evidence: await countersigned(f, up, out) },
    drawn = await disputedBet(f, left, { ...(await flip()), stake: 5n, chance: OUTCOME_SPACE / 40n, prize: 100n });
  await (await f.contract.dispute(drawn.evidence, drawn.terms)).wait();
  assert.deepEqual(await held(left), [95n, 95n]);
  await (await f.contract.withdraw(out.evidence)).wait();
  assert.deepEqual(await held(left), [60n, 60n]);
});

test("the contract admits a disputed bet exactly as the casino's Kelly rule does", async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    [, a] = env.wallets,
    opened = await open(f, a, 1000n),
    // A balance both sides signed, large enough for every stake here: the products reach 2^253.
    ch = { ...opened, ...(await signedIncrease(f, opened, 1n << 94n)) },
    expiresAt = (await now(env)) + 86400;
  const agrees = async (virtualBankroll: bigint, stake: bigint, chance: bigint, prize: bigint) => {
    const bet = await disputedBet(f, ch, { virtualBankroll, expiresAt, stake, chance, prize });
    const taken = await f.contract
      .connect(a)
      .dispute.staticCall(bet.evidence, bet.terms)
      .then(
        () => true,
        (error: any) => (error.revert?.name === 'InvalidTerms' ? false : Promise.reject(error)),
      );
    assert.equal(
      taken,
      admits(virtualBankroll, { stake, chance, prize }),
      `${virtualBankroll} ${stake} ${chance} ${prize}`,
    );
    return taken;
  };
  // At the edge of the rule, whatever the stake: the largest prize admitted, and one more.
  for (const [bankroll, stake, chance] of [
    [5000n, 100n, OUTCOME_SPACE / 2n],
    [MAX_BALANCE - 1n, 1n << 93n, OUTCOME_SPACE / 2n],
    [MAX_BALANCE - 1n, 1n, 1n],
    [10n ** 21n, 10n ** 15n, (OUTCOME_SPACE * 99n) / 100n],
    [1n, 1n, OUTCOME_SPACE - 1n],
  ]) {
    let low = stake,
      high = MAX_BALANCE - 1n;
    while (low < high) {
      const middle = (low + high + 1n) / 2n;
      if (admits(bankroll, { stake, chance, prize: middle })) low = middle;
      else high = middle - 1n;
    }
    assert.ok(await agrees(bankroll, stake, chance, low));
    if (low + 1n < MAX_BALANCE) assert.ok(!(await agrees(bankroll, stake, chance, low + 1n)));
  }
  // A bet that pays at most its stake costs a bankroll nothing, but a bankroll of nothing takes only one paying less.
  assert.ok(await agrees(0n, 100n, OUTCOME_SPACE - 1n, 99n));
  assert.ok(!(await agrees(0n, 100n, OUTCOME_SPACE - 1n, 100n)));
  assert.ok(await agrees(1n, 100n, OUTCOME_SPACE - 1n, 100n));
});

test('channel evidence rejects replay across channels and chains', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    a = await open(f, env.wallets[1]),
    b = await open(f, env.wallets[2]);
  const result = await step(f, a, 2, 100n);
  for (const other of [{ player: b.opening.player }, { index: '1' }]) {
    const cross = structuredClone(result.evidence);
    Object.assign(cross.base, other);
    await assert.rejects(f.contract.supported(cross));
  }
  const changed = { ...result.state, balance: '950' },
    bad = checkpointEvidence(
      changed,
      await env.wallets[1].signTypedData({ ...f.d, chainId: 11155111 }, STATE_TYPES, changed),
      await f.owner.signTypedData(f.d, STATE_TYPES, changed),
    );
  await assert.rejects(f.contract.supported(bad));
  // Unresolved authorizations have no result evidence and create no withholding penalty.
  await (await f.contract.connect(env.wallets[1]).startClose(a.evidence)).wait();
  const deadline = (await channelAt(f, a.opening)).deadline;
  await env.provider.send('evm_setNextBlockTimestamp', [Number(deadline) - 1]);
  await env.provider.send('evm_mine', []);
  await assert.rejects(f.contract.finalizeClose.staticCall(a.opening.player, a.opening.index));
  // Re-submitting the proposed state is not a challenge.
  await assert.rejects(f.contract.challengeClose.staticCall(a.evidence));
  await env.provider.send('evm_setNextBlockTimestamp', [Number(deadline)]);
  await env.provider.send('evm_mine', []);
  await assert.rejects(f.contract.challengeClose.staticCall(result.evidence));
  await (await f.contract.finalizeClose(a.opening.player, a.opening.index)).wait();
  assert.equal((await claimOf(f, a.opening)).amount, 1000n);
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
  // A channel's base carries no signature: one given anyway is refused.
  const { base } = await fund(f, env.wallets[2]);
  await f.contract.supported(base);
  for (const signatures of [{ playerSignature: evidence.casinoSignature }, { casinoSignature: '0x00' }])
    await assert.rejects(f.contract.supported({ ...base, ...signatures }), reverts('InvalidTerms'));
});

test('balances are capped below MAX_BALANCE so aggregate debt cannot overflow and block protected-principal finalization', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    a = await open(f, env.wallets[1], 1n),
    b = await open(f, env.wallets[2], 1n),
    c = await open(f, env.wallets[3], 1n),
    max = MAX_BALANCE - 1n;
  async function balanceEvidence(ch: any, balance: any) {
    const state = { ...ch.state, sequence: '2', balance: String(balance) };
    return checkpointEvidence(
      state,
      await ch.player.signTypedData(f.d, STATE_TYPES, state),
      await f.owner.signTypedData(f.d, STATE_TYPES, state),
    );
  }
  // A jointly signed balance at or above the cap is not settlement evidence, however it was produced.
  await assert.rejects(f.contract.supported(await balanceEvidence(a, MAX_BALANCE)));
  await forceClose(f, env, a, await balanceEvidence(a, max));
  await forceClose(f, env, b, await balanceEvidence(b, 10n));
  assert.equal(await f.contract.unpaidWinnings(), max - 1n + 9n);
  await forceClose(f, env, c);
  await (await f.contract.claim(c.opening.channelId)).wait();
  assert.equal((await claimOf(f, c.opening)).paid, 1n);
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
    cap = MAX_BALANCE;
  for (const field of ['balance', 'deposited', 'withdrawn']) {
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
          evidence,
        };
      if (amount < cap) {
        assert.equal((await f.contract.supported(evidence))[field], amount);
        assert.equal(verifyEvidence(bundle).state[field as 'balance' | 'deposited' | 'withdrawn'], String(amount));
      } else {
        await assert.rejects(f.contract.supported(evidence), reverts('InvalidState'));
        assert.throws(() => verifyEvidence(bundle), /Balance exceeds the protocol maximum/);
      }
    }
  }
});

test('evidence is taken in the one form it was signed in, though the contract reads other spellings alike', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    ch = await open(f, env.wallets[1], 1n),
    state = { ...ch.state, balance: '100' },
    signed = async (base: any) =>
      checkpointEvidence(
        base,
        await ch.player.signTypedData(f.d, STATE_TYPES, base),
        await f.owner.signTypedData(f.d, STATE_TYPES, base),
      ),
    bundle = (evidence: any) => ({
      chainId: env.chainId,
      casino: String(f.contract.target),
      operator: f.owner.address,
      evidence,
    });
  const evidence = await signed(state);
  assert.equal(verifyEvidence(bundle(evidence)).state.balance, '100');
  // Each is the same checkpoint to ethers and to the contract, so the signatures on it hold: none is kept.
  for (const base of [
    { ...state, balance: '0x64' },
    { ...state, balance: '0100' },
    { ...state, sequence: ' ' + state.sequence },
    { ...state, player: state.player.toLowerCase() },
    { ...state, previousStateHash: '0x' + state.previousStateHash.slice(2).toUpperCase() },
    { ...state, note: 'riding along' },
  ])
    assert.throws(() => verifyEvidence(bundle({ ...evidence, base })), /one form/);
  for (const step of [
    { ...evidence.step, operation: { ...evidence.step.operation, kind: 0 } },
    { ...evidence.step, seed: '0X' + evidence.step.seed.slice(2) },
    { ...evidence.step, note: 'riding along' },
  ])
    assert.throws(() => verifyEvidence(bundle({ ...evidence, step })));
  assert.throws(
    () => verifyEvidence(bundle({ ...evidence, casinoSignature: '0X' + evidence.casinoSignature.slice(2) })),
    /Invalid signature/,
  );
});

test('the winnings queue pays in finalization order, and any claim collects what house cash reaches at once', async t => {
  const env = await anvil(),
    f = await deployment(env);
  t.after(() => env.close());
  const openings = [];
  for (let i = 0; i < 20; i++) {
    const c = await open(f, env.wallets[1], 1n),
      win = await signedIncrease(f, c, 10n);
    await forceClose(f, env, c, win.evidence);
    openings.push(c.opening);
  }
  const ids = openings.map(opening => opening.channelId);
  assert.equal(await f.contract.unpaidWinnings(), 200n);
  assert.equal(await f.contract.queuedWinnings(), 200n);
  // 127 of house cash covers the first twelve claims' winnings and 7 of the thirteenth's, oldest first.
  await (await f.contract.fundBankroll({ value: 127n })).wait();
  for (let i = 0; i < 20; i++)
    assert.equal(await f.contract.collectable(ids[i]), 1n + (i < 12 ? 10n : i === 12 ? 7n : 0n));
  // The last claim collects its principal, and the thirteenth what is covered of it, each in one call.
  await (await f.contract.claim(ids[19])).wait();
  assert.equal((await claimOf(f, openings[19])).paid, 1n);
  await (await f.contract.claim(ids[12])).wait();
  assert.equal((await claimOf(f, openings[12])).paid, 8n);
  assert.equal(await f.contract.collectable(ids[12]), 0n);
  for (let i = 0; i < 12; i++) assert.equal(await f.contract.collectable(ids[i]), 11n);
  assert.equal(await f.contract.withdrawableHouse(), 0n);
  await (await f.contract.fundBankroll({ value: 73n })).wait();
  for (const channelId of [...ids].reverse()) await (await f.contract.claim(channelId)).wait();
  for (const opening of openings) assert.equal((await claimOf(f, opening)).paid, 11n);
  assert.equal(await f.contract.unpaidWinnings(), 0n);
  assert.equal(await f.contract.protectedFunds(), 0n);
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
  await (await f.contract.claim(senior.opening.channelId)).wait();
  // With no house cash to reach its winnings, the beneficiary can name a recipient before any ETH is sent to it.
  await (await f.contract.connect(senior.player).claimTo(senior.opening.channelId, receiver.target)).wait();
  const junior = await open(f, env.wallets[2], 1n),
    juniorWin = await signedIncrease(f, junior, 10n);
  await forceClose(f, env, junior, juniorWin.evidence);
  await (await f.contract.fundBankroll({ value: 20n })).wait();
  assert.equal(await f.contract.collectable(senior.opening.channelId), 10n);
  const before = await claimOf(f, senior.opening);
  const rejected = await f.contract.claim(senior.opening.channelId, { gasLimit: 500000n });
  await assert.rejects(rejected.wait());
  assert.deepEqual(await claimOf(f, senior.opening), before);
  assert.equal(await f.contract.collectable(senior.opening.channelId), 10n);
  assert.equal(await f.contract.unpaidWinnings(), 20n);
  await (await f.contract.claim(junior.opening.channelId)).wait();
  assert.equal((await claimOf(f, junior.opening)).paid, 11n);
  // The senior's share stays covered: nothing is left for the house.
  assert.equal(await f.contract.collectable(senior.opening.channelId), 10n);
  assert.equal(await f.contract.withdrawableHouse(), 0n);
  await assert.rejects(
    f.contract.claimTo.staticCall(senior.opening.channelId, f.owner.address),
    reverts('Unauthorized'),
  );
  await (await f.contract.connect(senior.player).claimTo(senior.opening.channelId, senior.player.address)).wait();
  assert.equal((await claimOf(f, senior.opening)).paid, 11n);
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
