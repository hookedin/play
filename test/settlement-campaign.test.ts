import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ContractFactory, Wallet, id, ZeroHash } from 'ethers';
import { anvil, deployment, signedIncrease, open, step, closeCoop, assessBinary } from '../testing/contract.ts';
import { initialState, checkpointEvidence, channelId, STATE_TYPES, hashState } from '../protocol/protocol.ts';
import { OUTCOME_SPACE } from '../protocol/risk.ts';
import release from '../client/contract-artifact.ts';
import { verifyDeployment, loadArtifact } from '../protocol/deployment.ts';
import { ChainObserver } from '../protocol/chain-observer.ts';

async function channel(f: any, player: any, deposit = 100n) {
  const ch = await open(f, player, deposit);
  const genesis = ch.evidence;
  const state = { ...ch.state, sequence: '1' };
  const evidence = checkpointEvidence(
    state,
    await new Wallet(ch.key).signTypedData(f.d, STATE_TYPES, state),
    await f.owner.signTypedData(f.d, STATE_TYPES, state),
  );
  return { ...ch, state, evidence, genesis };
}
async function transition(f: any, ch: any, kind: any, amount: any, extra = {}) {
  const result = kind === 'checkpoint' ? await signedIncrease(f, ch, amount) : await step(f, ch, kind, amount, extra);
  ch.state = result.state;
  ch.evidence = checkpointEvidence(
    result.state,
    await new Wallet(ch.key).signTypedData(f.d, STATE_TYPES, result.state),
    kind === 'checkpoint' ? result.evidence.casinoSignature : result.evidence.step.casinoSignature,
  );
  return result.evidence;
}
async function invariants(env: any, f: any, records: any) {
  let principal = 0n,
    debt = 0n,
    allocated = 0n;
  const rows = await Promise.all(
    records.map(async (ch: any) => {
      const channelId = ch.state.channelId;
      const [c, claim, reserved] = await Promise.all([
        f.contract.channels(channelId),
        f.contract.claims(channelId),
        f.contract.allocatedWinnings(channelId),
      ]);
      principal += c.status < 3n ? c.deposit : claim.protectedRemaining;
      debt += claim.winningsRemaining;
      allocated += reserved;
      assert.ok(reserved <= claim.winningsRemaining);
      if (c.status === 3n) assert.equal(claim.amount, claim.paid + claim.protectedRemaining + claim.winningsRemaining);
      return { ch, c, claim };
    }),
  );
  const [p, unpaid, reserved, cash, free, withdrawal] = await Promise.all([
    f.contract.protectedPrincipal(),
    f.contract.unpaidWinnings(),
    f.contract.reservedWinnings(),
    env.provider.getBalance(await f.contract.getAddress()),
    f.contract.houseCash(),
    f.contract.withdrawableHouse(),
  ]);
  assert.equal(p, principal);
  assert.equal(unpaid, debt);
  assert.equal(reserved, allocated);
  assert.ok(cash >= principal + allocated);
  assert.equal(free, cash - principal - allocated);
  assert.equal(withdrawal, cash > principal + debt ? cash - principal - debt : 0n);
  return rows;
}

for (const initialSeed of [1, 17, 913, 9127, 65537, 741231, 123456789, 4294967295])
  test('settlement invariants across 96 mixed actions, seed ' + initialSeed, async t => {
    const env = await anvil();
    t.after(() => env.close());
    const f = await deployment(env);
    const records = [],
      active = new Map();
    let seed = initialSeed;
    const random = (n: any) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 96; i++) {
      const who = 1 + random(6),
        player = env.wallets[who],
        ch = active.get(who),
        choice = random(9);
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
            // Only strictly newer evidence is accepted; re-submitting the proposed state reverts.
            if (BigInt(ch.state.sequence) > c.closingSequence) {
              await (await f.contract.challengeClose(ch.evidence)).wait();
              assert.equal((await f.contract.channels(ch.state.channelId)).deadline, c.deadline);
            } else await assert.rejects(f.contract.challengeClose(ch.evidence));
          } else if (choice < 6) await closeCoop(f, ch);
          else {
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
        } else if (choice === 3) await (await f.contract.connect(player).startClose(ch.genesis)).wait();
        else if (choice === 4) await closeCoop(f, ch);
        else if (choice === 5) await (await f.contract.fundBankroll({ value: BigInt(1 + random(500)) })).wait();
        else if (choice === 6) {
          const cash = await f.contract.withdrawableHouse();
          if (cash)
            await (
              await f.contract.withdrawHouse(id('withdraw:' + initialSeed + ':' + i), f.owner.address, cash)
            ).wait();
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
      const rows = await invariants(env, f, records);
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
  await transition(f, a, 'checkpoint', (1n << 128n) - 2n);
  await closeCoop(f, a);
  await transition(f, b, 'checkpoint', 10n);
  await closeCoop(f, b);
  assert.equal(await f.contract.unpaidWinnings(), (1n << 128n) - 2n + 10n);
  await (await f.contract.fundBankroll({ value: 20n })).wait();
  await (await f.contract.claim(a.state.channelId)).wait();
  await invariants(env, f, [a, b, protectedChannel]);
});

test('v1 requires its pinned runtime and signing domain', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env);
  const observer = new ChainObserver({ provider: env.provider, chainId: 31337 });
  const args = { observer, provider: env.provider, address: f.contract.target, chainId: 31337 };
  assert.equal((await verifyDeployment(args)).operator, f.owner.address);
  const ch = await channel(f, env.wallets[1]);
  const changed = { ...ch.state, sequence: '1', balance: '200' };
  const wrongDomain = { ...f.d, version: 'unsupported' };
  const evidence = checkpointEvidence(
    changed,
    await new Wallet(ch.key).signTypedData(wrongDomain, STATE_TYPES, changed),
    await f.owner.signTypedData(wrongDomain, STATE_TYPES, changed),
  );
  await assert.rejects(f.contract.supported(evidence));
  await env.provider.send('anvil_setCode', [f.contract.target, '0x00']);
  await assert.rejects(verifyDeployment(args));
});

test('gas profile covers full-width evidence, bounded queues, forced ETH and exhausted recipient gas', async t => {
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
    await closeCoop(f, ch);
    records.push(ch);
  }
  await (await force(72n)).waitForDeployment();
  (gas as any).allocate64 = String((await (await f.contract.allocateWinnings(64)).wait()).gasUsed);
  (gas as any).claimAllocating8 = String(
    (await (await f.contract.claim(records.at(-1)!.state.channelId)).wait()).gasUsed,
  );
  await invariants(env, f, records);
  // A fresh queue makes fundBankroll exercise its automatic eight-entry bound.
  for (let i = 0; i < 8; i++) {
    const ch = await channel(f, env.wallets[2], 1n);
    await transition(f, ch, 'checkpoint', 1n);
    await closeCoop(f, ch);
    records.push(ch);
  }
  (gas as any).fundAllocating8 = String((await (await f.contract.fundBankroll({ value: 8n })).wait()).gasUsed);
  const ch = await channel(f, env.wallets[3], 1n),
    max = (1n << 128n) - 1n;
  const base = { ...ch.state, sequence: '1', balance: String(max / 8n) };
  ch.state = base;
  ch.evidence = checkpointEvidence(
    base,
    await new Wallet(ch.key).signTypedData(f.d, STATE_TYPES, base),
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
      authorization: await new Wallet(ch.key).signTypedData(f.d, OP_TYPES, op),
      seed,
      secret,
      casinoSignature: await f.owner.signTypedData(f.d, STATE_TYPES, next),
    },
  };
  await (await f.contract.connect(ch.player).startClose(ch.genesis)).wait();
  (gas as any).challengeWide = String((await (await f.contract.challengeClose(evidence)).wait()).gasUsed);
  const receiverArtifact = loadArtifact('contracts/test/ClaimReceiver.sol', 'ClaimReceiver');
  const receiver = await new ContractFactory(
    receiverArtifact.abi,
    receiverArtifact.evm.bytecode.object,
    env.wallets[4],
  ).deploy(f.contract.target);
  await receiver.waitForDeployment();
  const message = {
    channelId: channelId(String(receiver.target), env.wallets[4].address, 100n),
    player: receiver.target,
    signer: env.wallets[4].address,
    deposit: '100',
  };
  await (await (receiver as any).open(message.signer, { value: 100n })).wait();
  await (await (receiver as any).setMode(3)).wait();
  await (await (receiver as any).close(checkpointEvidence(initialState(message)))).wait();
  await env.provider.send('evm_increaseTime', [86401]);
  await env.provider.send('evm_mine', []);
  (gas as any).finalizeGasBurner = String(
    (await (await f.contract.finalizeClose(message.channelId, { gasLimit: 2000000n })).wait()).gasUsed,
  );
  assert.equal((await f.contract.claims(message.channelId)).protectedRemaining, 100n);
  await (await (receiver as any).redirect(message.channelId, env.wallets[5].address)).wait();
  assert.equal((await f.contract.claims(message.channelId)).paid, 100n);
  for (const name of ['claimAllocating8', 'challengeWide', 'finalizeGasBurner'])
    assert.ok((BigInt((gas as any)[name]) * 12n) / 10n < 2000000n, name + ' exceeds operational gas budget');
  assert.ok(BigInt((gas as any).allocate64) < 16000000n);
  fs.mkdirSync('build', { recursive: true });
  fs.writeFileSync(
    'build/settlement-gas.json',
    JSON.stringify({ measuredAt: new Date().toISOString(), compiler: release.compiler, gas }, null, 2) + '\n',
  );
  t.diagnostic('Measured gas: ' + JSON.stringify(gas));
});
