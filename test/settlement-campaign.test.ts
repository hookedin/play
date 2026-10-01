import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractFactory, id, Wallet } from 'ethers';
import {
  anvil,
  deployment,
  signedIncrease,
  open,
  step,
  assessBinary,
  claimOf,
  disputedBet,
  offered,
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
/** A close without the casino, finalized once its challenge period is over. */
async function settle(f: any, env: any, ch: any) {
  await (await f.contract.connect(ch.player).startClose(ch.evidence)).wait();
  await env.provider.send('evm_increaseTime', [86401]);
  await env.provider.send('evm_mine', []);
  await (await f.contract.finalizeClose(ch.opening.channelId)).wait();
}
async function invariants(env: any, f: any, records: any, withdrawals: string[] = []) {
  let principal = 0n,
    debt = 0n,
    covered = 0n;
  const rows = await Promise.all(
    records.map(async (ch: any) => {
      const channelId = ch.state.channelId;
      const [c, claim, collectable] = await Promise.all([
        f.contract.channels(channelId),
        claimOf(f, channelId),
        f.contract.collectable(channelId),
      ]);
      principal += c.status < 3n ? c.principal + c.collateral : claim.protectedRemaining;
      debt += claim.winningsRemaining;
      // Collecting pays the claim's principal, and no more winnings than it is owed.
      assert.ok(collectable >= claim.protectedRemaining);
      assert.ok(collectable <= claim.protectedRemaining + claim.winningsRemaining);
      covered += BigInt(collectable) - BigInt(claim.protectedRemaining);
      if (c.status === 3n) assert.equal(claim.amount, claim.paid + claim.protectedRemaining + claim.winningsRemaining);
      // Only a closing channel disputes a bet, and a finalized one keeps the prize its close paid as won.
      if (c.disputedPrize) assert.ok(c.status >= 2n);
      return { ch, c, claim };
    }),
  );
  // A withdrawal is a claim too, under its operation's hash.
  for (const id of withdrawals) {
    const [claim, collectable] = await Promise.all([f.contract.claims(id), f.contract.collectable(id)]);
    principal += claim.protectedRemaining;
    debt += claim.winningsRemaining;
    assert.ok(collectable >= claim.protectedRemaining);
    assert.ok(collectable <= claim.protectedRemaining + claim.winningsRemaining);
    covered += BigInt(collectable) - BigInt(claim.protectedRemaining);
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
  return rows;
}

for (const initialSeed of [1, 4294967295])
  test('settlement invariants across 96 mixed actions, seed ' + initialSeed, async t => {
    const env = await anvil();
    t.after(() => env.close());
    const f = await deployment(env);
    const records = [],
      withdrawals: string[] = [],
      active = new Map();
    let seed = initialSeed,
      sales = 0n;
    const random = (n: any) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      // The high bits: a power-of-two modulus leaves the low ones cycling.
      return Math.floor((seed / 2 ** 32) * n);
    };
    for (let i = 0; i < 96; i++) {
      const who = 1 + random(6),
        player = env.wallets[who],
        ch = active.get(who),
        choice = random(10);
      if (!ch) {
        const next = await channel(f, player, BigInt(10 + random(1000)));
        records.push(next);
        active.set(who, next);
      } else {
        const c = await f.contract.channels(ch.state.channelId);
        if (c.status === 2n) {
          const timestamp = (await env.provider.getBlock('latest'))!.timestamp;
          if (BigInt(timestamp) >= c.deadline) await (await f.contract.finalizeClose(ch.state.channelId)).wait();
          else if (choice < 3) {
            // The casino settles a disputed bet with its result at the bet's sequence, which leaves the deadline as it is.
            // Otherwise only strictly newer evidence is accepted; re-submitting the proposed state reverts.
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
          } else {
            await env.provider.send('evm_increaseTime', [86401]);
            await env.provider.send('evm_mine', []);
            await (await f.contract.finalizeClose(ch.state.channelId)).wait();
          }
        } else if (choice < 3) {
          if (choice === 0 && BigInt(ch.state.balance) > 0n)
            await transition(f, ch, 2, BigInt(1 + random(Number(ch.state.balance))));
          else if (choice === 1 && BigInt(ch.state.balance) > 0n) {
            const amount = BigInt(ch.state.balance) < 10n ? 1n : 10n;
            const q = assessBinary({
              bankroll: 1000000n,
              stake: amount,
              netWin: amount,
              chance: OUTCOME_SPACE / 4n,
            });
            await transition(f, ch, 1, amount, {
              chance: q.chance,
              prize: q.prize,
              seed: id('seed:' + initialSeed + ':' + i),
            });
          } else await transition(f, ch, 'checkpoint', BigInt(1 + random(500)));
        } else if (choice === 3) {
          if (random(3) && BigInt(ch.state.balance) >= 10n) {
            // A casino bet its quote covers that the casino leaves unsettled: anyone disputes it, which closes the
            // channel with it counted as won.
            const q = assessBinary({ bankroll: 1000000n, stake: 10n, netWin: 10n, chance: OUTCOME_SPACE / 4n });
            ch.bet = await disputedBet(f, ch, {
              virtualBankroll: 1000000n,
              expiresAt: (await env.provider.getBlock('latest'))!.timestamp + 86400,
              stake: q.stake,
              chance: q.chance,
              prize: q.prize,
              seed: id('dispute:' + initialSeed + ':' + i),
            });
            await (await f.contract.connect(env.wallets[8]).dispute(ch.bet.evidence, ch.bet.terms)).wait();
            assert.equal((await f.contract.channels(ch.state.channelId)).disputedPrize, q.prize);
          } else await (await f.contract.connect(player).startClose(ch.base)).wait();
        } else if (choice === 9 && BigInt(ch.state.balance) > 0n) {
          // A withdrawal, to the account's address, another, or the contract itself as a lock-in, which anyone has
          // made a claim: paid at once out of the channel's deposits and as far as house cash goes, the rest owed in
          // the winnings queue. It at times waits, while deposits arrive and are taken in, and as withdrawals record in
          // the order they were signed, so do those after it; one still waiting when the channel closes comes back
          // with the close.
          const amount = BigInt(1 + random(Number(ch.state.balance))),
            contract = await f.contract.getAddress(),
            recipient = [player.address, Wallet.createRandom().address, contract][random(3)],
            sent = await transition(f, ch, 5, amount, { recipient });
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
              if (owed.step.operation.recipient === contract)
                locked += BigInt(owed.step.operation.amount) - claim.protectedRemaining - claim.winningsRemaining;
            }
            const after = await f.contract.channels(ch.state.channelId);
            assert.deepEqual([after.principal - locked, after.collateral], [predicted.principal, predicted.collateral]);
          }
        } else if (choice === 4) {
          // Somebody else deposits into the open channel, which its balance at times takes in.
          await (
            await f.contract.connect(env.wallets[8]).deposit(player.address, { value: BigInt(1 + random(500)) })
          ).wait();
          const { deposited } = await f.contract.channels(ch.state.channelId);
          if (random(2)) await transition(f, ch, 4, deposited - BigInt(ch.state.deposited));
        } else if (choice === 5) {
          await (await f.contract.fundBankroll({ value: BigInt(1 + random(500)) })).wait();
          if (random(3)) {
            // Somebody buys collateral the casino offers for the channel, as far as house cash goes.
            const amount = BigInt(1 + random(300)),
              price = BigInt(random(3)),
              expiresAt = BigInt((await env.provider.getBlock('latest'))!.timestamp + 3600),
              offer = await offered(f, ch.state.channelId, amount, price, expiresAt);
            if (amount > (await f.contract.withdrawableHouse())) await assert.rejects(offer.attempt(env.wallets[8]));
            else {
              await offer.buy(env.wallets[8]);
              sales += price;
            }
          }
        } else if (choice === 6) {
          const cash = await f.contract.withdrawableHouse();
          if (cash) await (await f.contract.withdrawHouse(f.owner.address, cash)).wait();
        } else {
          const closed = records.filter(record => ![...active.values()].includes(record));
          if (closed.length) {
            const target = closed[random(closed.length)];
            if (choice === 7)
              await (
                await f.contract.connect(target.player).claimTo(target.state.channelId, env.wallets[9].address)
              ).wait();
            else await (await f.contract.claim(target.state.channelId)).wait();
          }
        }
      }
      const rows = await invariants(env, f, records, withdrawals);
      assert.equal(await f.contract.collateralSales(), sales);
      for (const [who, ch] of active) if (rows.find(row => row.ch === ch).c.status === 3n) active.delete(who);
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
  await settle(f, env, a);
  await transition(f, b, 'checkpoint', 10n);
  await settle(f, env, b);
  assert.equal(await f.contract.unpaidWinnings(), MAX_BALANCE - 2n + 10n);
  await (await f.contract.fundBankroll({ value: 20n })).wait();
  await (await f.contract.claim(a.state.channelId)).wait();
  await invariants(env, f, [a, b, protectedChannel]);
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
    gas = {};
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
    await settle(f, env, ch);
    records.push(ch);
  }
  await (await force(72n)).waitForDeployment();
  // The last claim in the queue collects at once, at the cost of the first.
  (gas as any).claimFirst = String((await (await f.contract.claim(records[0].state.channelId)).wait()).gasUsed);
  (gas as any).claimBehind71 = String((await (await f.contract.claim(records.at(-1)!.state.channelId)).wait()).gasUsed);
  assert.equal((await f.contract.claims(records.at(-1)!.state.channelId)).winningsRemaining, 0n);
  assert.ok(BigInt((gas as any).claimBehind71) <= (BigInt((gas as any).claimFirst) * 11n) / 10n);
  await invariants(env, f, records);
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
  (gas as any).challengeWide = String((await (await f.contract.challengeClose(evidence)).wait()).gasUsed);
  const receiverArtifact = loadArtifact('contracts/test/ClaimReceiver.sol', 'ClaimReceiver');
  const receiver = await new ContractFactory(
    receiverArtifact.abi,
    receiverArtifact.evm.bytecode.object,
    env.wallets[4],
  ).deploy(f.contract.target);
  await receiver.waitForDeployment();
  // A contract account signs nothing, but anyone funds its channel and it closes from its base.
  const message = { channelId: channelId(String(receiver.target), 0) };
  await (await f.contract.connect(env.wallets[4]).deposit(receiver.target, { value: 100n })).wait();
  await (await (receiver as any).setMode(3)).wait();
  await (await (receiver as any).close(checkpointEvidence(baseState(message.channelId)))).wait();
  await env.provider.send('evm_increaseTime', [86401]);
  await env.provider.send('evm_mine', []);
  (gas as any).finalizeGasBurner = String(
    (await (await f.contract.finalizeClose(message.channelId, { gasLimit: 2000000n })).wait()).gasUsed,
  );
  assert.equal((await f.contract.claims(message.channelId)).protectedRemaining, 100n);
  await (await (receiver as any).redirect(message.channelId, env.wallets[5].address)).wait();
  assert.equal((await claimOf(f, message.channelId)).paid, 100n);
  for (const name of ['claimBehind71', 'challengeWide', 'finalizeGasBurner'])
    assert.ok((BigInt((gas as any)[name]) * 12n) / 10n < 2000000n, name + ' exceeds operational gas budget');
  t.diagnostic('Measured gas: ' + JSON.stringify(gas));
});
