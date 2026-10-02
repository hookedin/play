import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractFactory, id, Wallet, ZeroAddress } from 'ethers';
import {
  anvil,
  deployment,
  signedIncrease,
  open,
  step,
  assessBinary,
  claimOf,
  disputedBet,
  forceClose,
  offered,
  reverts,
} from '../testing/contract.ts';
import {
  baseState,
  checkpointEvidence,
  channelId,
  hashOperation,
  hashState,
  recordWithdrawals,
  STATE_TYPES,
} from '../protocol/protocol.ts';
import { MAX_BALANCE, OUTCOME_SPACE } from '../protocol/risk.ts';
import { verifyDeployment, loadArtifact } from '../protocol/deployment.ts';
import { ChainObserver } from '../protocol/chain-observer.ts';

/** An account's channel with its deposit taken in, and its base: the state a stale close can still name. */
const channel = (f: any, player: any, deposit = 100n) => open(f, player, deposit);
async function transition(f: any, ch: any, kind: any, amount: any, extra = {}) {
  const result = kind === 'checkpoint' ? await signedIncrease(f, ch, amount) : await step(f, ch, kind, amount, extra);
  ch.state = result.state;
  ch.evidence = checkpointEvidence(
    result.state,
    await ch.player.signTypedData(f.d, STATE_TYPES, result.state),
    kind === 'checkpoint' ? result.evidence.casinoSignature : result.evidence.step.casinoSignature,
  );
  return result.evidence;
}
/** What the contract holds and owes adds up to every channel of every account, those a claim's payment opened
 * included, and every withdrawal's claim. Returns each channel as the contract holds it. */
async function invariants(env: any, f: any, withdrawals: string[] = []) {
  let principal = 0n,
    debt = 0n,
    covered = 0n;
  // Collecting pays the claim's principal, and no more winnings than it is owed.
  const owes = (claim: any, collectable: bigint) => {
    assert.ok(collectable >= claim.protectedRemaining);
    assert.ok(collectable <= claim.protectedRemaining + claim.winningsRemaining);
    covered += collectable - claim.protectedRemaining;
  };
  const ids = (
    await Promise.all(
      env.wallets.map(async (wallet: any) => {
        const index = Number(await f.contract.channelIndex(wallet.address));
        return Array.from({ length: index + 1 }, (_, k) => channelId(wallet.address, k));
      }),
    )
  ).flat();
  const channels = new Map();
  await Promise.all(
    ids.map(async id => {
      const [c, claim, collectable] = await Promise.all([
        f.contract.channels(id),
        f.contract.claims(id),
        f.contract.collectable(id),
      ]);
      channels.set(id, c);
      principal += c.status < 3n ? c.principal + c.collateral : claim.protectedRemaining;
      debt += claim.winningsRemaining;
      owes(claim, collectable);
      // Only a closing channel disputes a bet, and a finalized one keeps the prize its close paid as won. A hold lasts
      // only while the bet is disputed.
      if (c.disputedPrize) assert.ok(c.status >= 2n);
      if (c.disputeHold) assert.ok(c.status === 2n && c.disputedPrize && c.disputeHold <= c.collateral);
    }),
  );
  // A withdrawal is a claim too, under its operation's hash.
  for (const id of withdrawals) {
    const [claim, collectable] = await Promise.all([f.contract.claims(id), f.contract.collectable(id)]);
    principal += claim.protectedRemaining;
    debt += claim.winningsRemaining;
    owes(claim, collectable);
  }
  const [p, unpaid, cash, withdrawal] = await Promise.all([
    f.contract.protectedFunds(),
    f.contract.unpaidWinnings(),
    env.provider.getBalance(await f.contract.getAddress()),
    f.contract.withdrawableHouse(),
  ]);
  assert.equal(p, principal);
  assert.equal(unpaid, debt);
  assert.ok(cash >= principal);
  // House cash covers the winnings owed as far as it goes, and the claims collect exactly what it covers.
  assert.equal(covered, debt < cash - principal ? debt : cash - principal);
  assert.equal(withdrawal, cash > principal + debt ? cash - principal - debt : 0n);
  return channels;
}

for (let initialSeed = 1; initialSeed <= 16; initialSeed++)
  test('settlement invariants across 96 mixed actions, seed ' + initialSeed, async t => {
    const env = await anvil();
    t.after(() => env.close());
    const f = await deployment(env);
    // Each block a second after the last, whatever the clock says, so a seed takes the same path every time.
    await env.provider.send('anvil_setBlockTimestampInterval', [1]);
    const records: any[] = [],
      withdrawals: string[] = [],
      active = new Map();
    let seed = initialSeed,
      sales = 0n;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      // The high bits: a power-of-two modulus leaves the low ones cycling.
      return Math.floor((seed / 2 ** 32) * n);
    };
    // Below `n`, however large; up to `n`, and at times exactly `n`, where the contract's arithmetic turns. Each channel
    // counts in a unit of its own, from a wei to a thousandth of an ether, so claims of every size share the queue.
    const below = (n: bigint) => (n * BigInt(random(2 ** 32))) >> 32n,
      upTo = (n: bigint) => (random(4) ? 1n + below(n) : n),
      unit = () => 10n ** BigInt(3 * random(6));
    for (let i = 0; i < 96; i++) {
      const who = 1 + random(6),
        player = env.wallets[who],
        ch = active.get(who),
        choice = random(10);
      if (!ch) {
        const scale = unit(),
          next = await channel(f, player, BigInt(10 + random(1000)) * scale);
        records.push(Object.assign(next, { unit: scale }));
        active.set(who, next);
      } else {
        const c = await f.contract.channels(ch.state.channelId),
          balance = BigInt(ch.state.balance);
        if (c.status === 2n) {
          // The next block is a second after the latest.
          const timestamp = (await env.provider.getBlock('latest'))!.timestamp + 1;
          if (BigInt(timestamp) >= c.deadline) await (await f.contract.finalizeClose(ch.state.channelId)).wait();
          else if (choice < 3) {
            // The casino settles a disputed bet with its result at the bet's sequence, which leaves the close's deadline
            // as it was. Otherwise only strictly newer evidence is accepted; re-submitting the proposed state reverts.
            if (c.disputedPrize) {
              const settled = await ch.bet.settled();
              await (await f.contract.challengeClose(settled.evidence)).wait();
              const after = await f.contract.channels(ch.state.channelId);
              assert.deepEqual(
                [after.disputedPrize, after.closingHash, after.deadline],
                [0n, hashState(f.d, settled.state), c.deadline],
              );
            } else if (BigInt(ch.state.sequence) > c.closingSequence) {
              await (await f.contract.challengeClose(ch.evidence)).wait();
              assert.equal((await f.contract.channels(ch.state.channelId)).deadline, c.deadline);
            } else await assert.rejects(f.contract.challengeClose(ch.evidence));
          } else if (choice < 6 && ch.owing?.length) {
            // Withdrawals signed before the close are recorded while it runs, in the order they were signed, before or
            // after a challenge: the close owes that much less.
            for (const owed of ch.owing.splice(0)) {
              const before = (await f.contract.channels(ch.state.channelId)).closingBalance,
                amount = BigInt(owed.step.operation.amount);
              await (await f.contract.connect(env.wallets[8]).withdraw(owed)).wait();
              withdrawals.push(hashOperation(f.d, owed.step.operation));
              assert.equal(
                (await f.contract.channels(ch.state.channelId)).closingBalance,
                amount < before ? before - amount : 0n,
              );
            }
          } else {
            await env.provider.send('evm_setNextBlockTimestamp', [Number(c.deadline)]);
            await (await f.contract.finalizeClose(ch.state.channelId)).wait();
          }
        } else if (choice < 3) {
          if (choice === 0 && balance > 0n) await transition(f, ch, 2, upTo(balance));
          else if (choice === 1 && balance > 0n) {
            const amount = balance < 10n * ch.unit ? balance : 10n * ch.unit;
            const q = assessBinary({
              bankroll: 1000000n * ch.unit,
              stake: amount,
              netWin: amount,
              chance: OUTCOME_SPACE / 4n,
            });
            await transition(f, ch, 1, amount, {
              chance: q.chance,
              prize: q.prize,
              secret: id('secret:' + initialSeed + ':' + i),
              seed: id('seed:' + initialSeed + ':' + i),
            });
          } else await transition(f, ch, 'checkpoint', BigInt(1 + random(500)) * ch.unit);
        } else if (choice === 3) {
          if (random(3) && balance >= 10n * ch.unit) {
            // A casino bet its quote covers that the casino leaves unsettled: anyone disputes it, which closes the
            // channel with it counted as won.
            const q = assessBinary({
              bankroll: 1000000n * ch.unit,
              stake: 10n * ch.unit,
              netWin: 10n * ch.unit,
              chance: OUTCOME_SPACE / 4n,
            });
            ch.bet = await disputedBet(f, ch, {
              virtualBankroll: 1000000n * ch.unit,
              expiresAt: (await env.provider.getBlock('latest'))!.timestamp + 86400,
              stake: q.stake,
              chance: q.chance,
              prize: q.prize,
              secret: id('dispute secret:' + initialSeed + ':' + i),
              seed: id('dispute:' + initialSeed + ':' + i),
            });
            await (await f.contract.connect(env.wallets[8]).dispute(ch.bet.evidence, ch.bet.terms)).wait();
            assert.equal((await f.contract.channels(ch.state.channelId)).disputedPrize, q.prize);
          } else await (await f.contract.connect(player).startClose(ch.base)).wait();
        } else if (choice === 9 && balance > 0n) {
          // At times the casino lends the balance something first, which the withdrawal pays back, or a close if none
          // does.
          if (!random(4)) await transition(f, ch, 7, BigInt(1 + random(50)) * ch.unit);
          // It pays the loan back, and at times the casino a fee for sending it.
          const fee = BigInt(random(3)),
            free = BigInt(ch.state.balance) - BigInt(ch.state.loan) - fee;
          if (free <= 0n) continue;
          // A withdrawal, to the account's address or another, or a transfer to the account itself as a lock-in, which
          // anyone has made a claim: paid at once out of the channel's deposits and as far as house cash goes, the rest
          // owed in the winnings queue. It at times waits, while deposits arrive and are taken in, and as withdrawals
          // record in the order they were signed, so do those after it; one still waiting when the channel closes is
          // recorded during the close, or comes back with it. At times it takes exactly the deposits, or the deposits and
          // collateral, where its payment turns from one source to the next.
          const edge = [c.principal, c.principal + c.collateral][random(2)],
            amount = random(3) || edge < 1n || edge > free ? upTo(free) : edge,
            pick = random(3),
            recipient = pick === 1 ? Wallet.createRandom().address : player.address,
            sent = await transition(f, ch, pick === 2 ? 6 : 5, amount, { recipient, fee });
          (ch.owing ??= []).push(sent);
          if (ch.owing.length > 1) await assert.rejects(f.contract.withdraw.staticCall(sent));
          if (random(2)) {
            // Recorded, they leave the deposits and collateral the wallet's prediction says, by the contract's rule:
            // what a lock-in was paid goes back into the channel as deposits.
            const before = await f.contract.channels(ch.state.channelId),
              predicted = recordWithdrawals(
                before,
                ch.owing.map((owed: any) => ({ amount: owed.step.operation.amount, deposited: owed.base.deposited })),
              );
            let locked = 0n;
            for (const owed of ch.owing.splice(0)) {
              await (await f.contract.connect(env.wallets[8]).withdraw(owed)).wait();
              const claimId = hashOperation(f.d, owed.step.operation),
                claim = await f.contract.claims(claimId);
              withdrawals.push(claimId);
              if (Number(owed.step.operation.kind) === 6)
                locked += BigInt(owed.step.operation.amount) - claim.protectedRemaining - claim.winningsRemaining;
            }
            const after = await f.contract.channels(ch.state.channelId);
            assert.deepEqual([after.principal - locked, after.collateral], [predicted.principal, predicted.collateral]);
          }
        } else if (choice === 4) {
          // Somebody else deposits into the open channel, which its balance at times takes in.
          await (
            await f.contract
              .connect(env.wallets[8])
              .deposit(player.address, { value: BigInt(1 + random(500)) * ch.unit })
          ).wait();
          const { deposited } = await f.contract.channels(ch.state.channelId);
          if (random(2)) await transition(f, ch, 4, deposited - BigInt(ch.state.deposited));
        } else if (choice === 5) {
          await (await f.contract.fundBankroll({ value: BigInt(1 + random(500)) * unit() })).wait();
          if (random(3)) {
            // Somebody buys collateral the casino offers for the channel, as far as house cash, with the price joining
            // it, goes: at times exactly that far, or a wei beyond.
            const price = BigInt(random(3)),
              [cash, held, owed] = await Promise.all([
                env.provider.getBalance(f.contract.target),
                f.contract.protectedFunds(),
                f.contract.unpaidWinnings(),
              ]),
              reach = cash + price > held + owed ? cash + price - held - owed : 0n,
              amount = random(4) || !reach ? BigInt(1 + random(300)) * ch.unit : reach + BigInt(random(2)),
              expiresAt = BigInt((await env.provider.getBlock('latest'))!.timestamp + 3600),
              offer = await offered(f, ch.state.channelId, amount, price, expiresAt);
            if (amount > reach) await assert.rejects(offer.attempt(env.wallets[8]), reverts('InsufficientBalance'));
            else {
              await offer.buy(env.wallets[8]);
              sales += price;
            }
          }
        } else if (choice === 6) {
          const cash = await f.contract.withdrawableHouse();
          if (cash) await (await f.contract.withdrawHouse(f.owner.address, upTo(cash))).wait();
        } else {
          // Anyone collects a claim, a closed channel's or a withdrawal's, mostly one still owed, or its beneficiary has
          // it paid somewhere else. Where there is no claim, collecting reverts.
          const ids = [
              ...records.filter(record => ![...active.values()].includes(record)).map(record => record.state.channelId),
              ...withdrawals,
            ],
            owed = (
              await Promise.all(
                ids.map(async id => {
                  const claim = await f.contract.claims(id);
                  return claim.protectedRemaining + claim.winningsRemaining > 0n ? id : [];
                }),
              )
            ).flat(),
            pool = owed.length && random(4) ? owed : ids;
          if (pool.length) {
            const claimId = pool[random(pool.length)],
              { beneficiary } = await f.contract.claims(claimId);
            if (beneficiary === ZeroAddress)
              await assert.rejects(f.contract.claim.staticCall(claimId), reverts('InvalidState'));
            else if (choice === 7)
              await (
                await f.contract
                  .connect(env.wallets.find((wallet: any) => wallet.address === beneficiary))
                  .claimTo(claimId, env.wallets[9].address)
              ).wait();
            else await (await f.contract.claim(claimId)).wait();
          }
        }
      }
      const channels = await invariants(env, f, withdrawals);
      assert.equal(await f.contract.collateralSales(), sales);
      for (const [who, ch] of active)
        if (channels.get(ch.state.channelId).status === 3n) {
          // A withdrawal never recorded came back with the close, and can no longer be.
          if (ch.owing?.length)
            await assert.rejects(f.contract.withdraw.staticCall(ch.owing[0]), reverts('InvalidState'));
          active.delete(who);
        }
    }
  });

test('maximal winnings debt never consumes another channel principal', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env);
  const a = await channel(f, env.wallets[1], 1n),
    b = await channel(f, env.wallets[2], 1n),
    protectedChannel = await channel(f, env.wallets[3], 100n);
  await transition(f, a, 'checkpoint', MAX_BALANCE - 2n);
  await forceClose(f, env, a);
  await transition(f, b, 'checkpoint', 10n);
  await forceClose(f, env, b);
  assert.equal(await f.contract.unpaidWinnings(), MAX_BALANCE - 2n + 10n);
  await (await f.contract.fundBankroll({ value: 20n })).wait();
  await (await f.contract.claim(a.state.channelId)).wait();
  assert.equal((await f.contract.channels(protectedChannel.state.channelId)).principal, 100n);
  await invariants(env, f);
});

test('the wallet requires its pinned runtime and signing domain', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env);
  const observer = new ChainObserver({ provider: env.provider, chainId: 31337 });
  const args = { observer, provider: env.provider, address: f.contract.target, chainId: 31337 };
  assert.equal((await verifyDeployment(args)).operator, f.owner.address);
  const ch = await channel(f, env.wallets[1]);
  const changed = { ...ch.state, sequence: '2', balance: '200' };
  const wrongDomain = { ...f.d, version: 'unsupported' };
  const evidence = checkpointEvidence(
    changed,
    await ch.player.signTypedData(wrongDomain, STATE_TYPES, changed),
    await f.owner.signTypedData(wrongDomain, STATE_TYPES, changed),
  );
  await assert.rejects(f.contract.supported(evidence));
  await env.provider.send('anvil_setCode', [f.contract.target, '0x00']);
  await assert.rejects(verifyDeployment(args));
});

test('gas profile covers full-width evidence, a long winnings queue, forced ETH and exhausted recipient gas', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    gas: Record<string, bigint> = {};
  const forceArtifact = loadArtifact('contracts/test/ForceFunding.sol', 'ForceFunding');
  const force = (value: any) =>
    new ContractFactory(forceArtifact.abi, forceArtifact.evm.bytecode.object, f.owner).deploy(f.contract.target, {
      value,
    });
  const records = [];
  // Empty house: finalization queues debt and leaves principal for explicit collection.
  for (let i = 0; i < 72; i++) {
    const ch = await channel(f, env.wallets[1], 1n);
    await transition(f, ch, 'checkpoint', 1n);
    await forceClose(f, env, ch);
    records.push(ch);
  }
  await (await force(72n)).waitForDeployment();
  // The last claim in the queue collects at once, at the cost of the first.
  gas.claimFirst = (await (await f.contract.claim(records[0].state.channelId)).wait()).gasUsed;
  gas.claimBehind71 = (await (await f.contract.claim(records.at(-1)!.state.channelId)).wait()).gasUsed;
  assert.equal((await f.contract.claims(records.at(-1)!.state.channelId)).winningsRemaining, 0n);
  assert.ok(gas.claimBehind71 <= (gas.claimFirst * 11n) / 10n);
  await invariants(env, f);
  const ch = await channel(f, env.wallets[3], 1n),
    max = MAX_BALANCE - 1n;
  const base = { ...ch.state, sequence: '2', balance: String(max / 8n) };
  ch.state = base;
  ch.evidence = checkpointEvidence(
    base,
    await ch.player.signTypedData(f.d, STATE_TYPES, base),
    await f.owner.signTypedData(f.d, STATE_TYPES, base),
  );
  // Exercise full-width casino bet terms.
  const { operation, OP_TYPES, deriveState, roundId, seedHash } = await import('../protocol/protocol.ts');
  const secret = id('wide secret'),
    seed = id('wide entropy');
  const q = assessBinary({ bankroll: max / 2n, stake: max / 8n, netWin: max / 64n, chance: OUTCOME_SPACE / 4n });
  const op = operation(f.d, base, {
    kind: 1,
    amount: q.stake,
    chance: q.chance,
    prize: q.prize,
    seedHash: seedHash(seed),
    round: roundId(secret),
    memo: id('wide operation'),
  });
  const next = deriveState(f.d, base, op, secret, seed);
  const evidence = {
    ...ch.evidence,
    step: {
      operation: op,
      authorization: await ch.player.signTypedData(f.d, OP_TYPES, op),
      seed,
      secret,
      casinoSignature: await f.owner.signTypedData(f.d, STATE_TYPES, next),
    },
  };
  await (await f.contract.connect(ch.player).startClose(ch.base)).wait();
  gas.challengeWide = (await (await f.contract.challengeClose(evidence)).wait()).gasUsed;
  const receiverArtifact = loadArtifact('contracts/test/ClaimReceiver.sol', 'ClaimReceiver');
  const receiver: any = await new ContractFactory(
    receiverArtifact.abi,
    receiverArtifact.evm.bytecode.object,
    env.wallets[4],
  ).deploy(f.contract.target);
  await receiver.waitForDeployment();
  // A contract account signs nothing, but anyone funds its channel and it closes from its base.
  const message = { channelId: channelId(String(receiver.target), 0) };
  await (await f.contract.connect(env.wallets[4]).deposit(receiver.target, { value: 100n })).wait();
  await (await receiver.close(checkpointEvidence(baseState(message.channelId)))).wait();
  await env.provider.send('evm_increaseTime', [7 * 86400 + 1]);
  await env.provider.send('evm_mine', []);
  gas.finalize = (await (await f.contract.finalizeClose(message.channelId)).wait()).gasUsed;
  // A recipient that burns all the gas it is sent: collecting to it reverts and leaves the claim whole, and its
  // beneficiary has it paid elsewhere.
  await (await receiver.setMode(3)).wait();
  await assert.rejects(f.contract.claim.staticCall(message.channelId), reverts('TransferFailed'));
  assert.equal((await f.contract.claims(message.channelId)).protectedRemaining, 100n);
  await (await receiver.redirect(message.channelId, env.wallets[5].address)).wait();
  assert.equal((await claimOf(f, message.channelId)).paid, 100n);
  // A withdrawal to it is still recorded, all of it owed, and costs whoever sends it the 100,000 gas it burns and no
  // more.
  const payer = await channel(f, env.wallets[6], 1000n),
    sent = await transition(f, payer, 5, 400n, { recipient: receiver.target, fee: 0n });
  gas.withdrawToBurner = (await (await f.contract.withdraw(sent, { gasLimit: 1000000n })).wait()).gasUsed;
  assert.equal((await f.contract.claims(hashOperation(f.d, sent.step.operation))).protectedRemaining, 400n);
  // Each operation within its budget: about half again what it measures, so that a substantial rise fails.
  const budgets: Record<string, bigint> = {
    claimFirst: 80000n,
    claimBehind71: 80000n,
    challengeWide: 160000n,
    finalize: 175000n,
    withdrawToBurner: 430000n,
  };
  t.diagnostic(
    'Measured gas: ' + JSON.stringify(gas, (_, value) => (typeof value === 'bigint' ? String(value) : value)),
  );
  for (const [name, budget] of Object.entries(budgets))
    assert.ok(gas[name] <= budget, `${name} used ${gas[name]} gas, over its budget of ${budget}`);
});
