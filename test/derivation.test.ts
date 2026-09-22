import test from 'node:test';
import assert from 'node:assert/strict';
import { id, ZeroAddress, ZeroHash, Wallet } from 'ethers';
import { anvil, deployment, open, step, below } from '../testing/contract.ts';
import {
  deriveState,
  hashState,
  checkpointEvidence,
  operation,
  roundId,
  seedHash,
  FUND_ID,
  STATE_TYPES,
  OP_TYPES,
} from '../protocol/protocol.ts';

/** The contract and the TypeScript derivation are hand-mirrored; feed both the same
 * evidence for every kind and every invalid branch and require identical verdicts. */
test('contract derive and deriveState agree on every operation kind and invalid encoding', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env);
  const a = await open(f, env.wallets[1], 1000n),
    b = await open(f, env.wallets[2], 1000n);
  const agree = async (ch: any, evidence: any) => {
    const local = deriveState(f.d, evidence.base, evidence.step.operation, evidence.step.secret, evidence.step.seed);
    const onchain = await f.contract.derive(evidence.base, evidence.step);
    assert.equal(hashState(f.d, onchain.toObject()), hashState(f.d, local));
    assert.equal((await f.contract.supported(evidence)).balance, BigInt(local.balance));
    ch.state = local;
    ch.evidence = checkpointEvidence(
      local,
      await new Wallet(ch.key).signTypedData(f.d, STATE_TYPES, local),
      await f.owner.signTypedData(f.d, STATE_TYPES, local),
    );
  };
  // Build evidence without deriving locally, so invalid encodings reach both verifiers.
  const craft = async (ch: any, values: any, secret = ZeroHash, seed = ZeroHash) => {
    const op = operation(f.d, ch.state, { operationId: id('craft ' + Math.random()), ...values });
    return {
      ...ch.evidence,
      step: {
        operation: op,
        authorization: await new Wallet(ch.key).signTypedData(f.d, OP_TYPES, op),
        seed,
        secret,
        casinoSignature: ch.evidence.casinoSignature,
      },
    };
  };
  const disagreeNever = async (evidence: any, reason: RegExp) => {
    assert.throws(
      () => deriveState(f.d, evidence.base, evidence.step.operation, evidence.step.secret, evidence.step.seed),
      reason,
    );
    await assert.rejects(f.contract.derive(evidence.base, evidence.step));
    await assert.rejects(f.contract.supported(evidence));
  };
  // Valid transitions: bet, payment, transfer and receive.
  const bet = await step(f, a, 1, 100n, { prizes: below(1n << 62n, 150n), seed: id('seed') });
  await agree(a, bet.evidence);
  const payment = await step(f, a, 2, 10n);
  await agree(a, payment.evidence);
  const transfer = await step(f, a, 3, 20n, { counterparty: b.state.channelId });
  await agree(a, transfer.evidence);
  const receive = await step(f, b, 4, 20n, {
    counterparty: a.state.channelId,
    operationId: id('outgoing digest'),
  });
  await agree(b, receive.evidence);
  // The bankroll fund is the other side of a transfer too: investing is a transfer that names it,
  // and redeemed money the credit that names it. Neither carries anything of a bet.
  const fund = FUND_ID,
    invested = await step(f, a, 3, 30n, { counterparty: fund });
  await agree(a, invested.evidence);
  const paidOut = await step(f, a, 4, 55n, { counterparty: fund });
  await agree(a, paidOut.evidence);
  for (const kind of [3, 4])
    await disagreeNever(
      await craft(a, { kind, amount: 30n, counterparty: fund, round: id('a round') }),
      /Invalid transfer/,
    );
  await disagreeNever(
    await craft(a, { kind: 4, amount: 30n, counterparty: fund, seedHash: id('entropy') }),
    /Invalid transfer/,
  );
  await disagreeNever(
    await craft(a, { kind: 3, amount: 5n, counterparty: fund, seedHash: id('entropy') }),
    /Invalid transfer/,
  );
  await disagreeNever(await craft(a, { kind: 4, amount: 0n, counterparty: fund }), /Invalid transfer/);
  // A bet and a payment name the game that asked for them; a transfer and a credit never do.
  const GAME = id('https://game.example/manifest.json');
  await disagreeNever(await craft(a, { kind: 2, amount: 10n }), /Invalid payment/);
  for (const kind of [3, 4])
    await disagreeNever(await craft(a, { kind, amount: 30n, counterparty: fund, game: GAME }), /Invalid transfer/);
  // Every field a kind does not use must be zero; both sides reject the same encodings.
  await disagreeNever(
    await craft(a, { kind: 2, amount: 10n, game: GAME, developer: f.owner.address }),
    /Invalid payment/,
  );
  await disagreeNever(await craft(a, { kind: 2, amount: 10n, game: GAME }, id('not zero')), /Invalid payment/);
  await disagreeNever(
    await craft(a, { kind: 2, amount: 10n, game: GAME }, ZeroHash, id('not zero')),
    /Invalid payment/,
  );
  // Only the secret of the round a bet signed, and the seed it named, settle it; every prize is well formed.
  const secret = id('a secret'),
    seed = id('s'),
    prize = { rangeStart: 0n, rangeEnd: 1n << 62n, payout: 150n },
    wager = {
      kind: 1,
      amount: 100n,
      prizes: [prize],
      seedHash: seedHash(seed),
      game: GAME,
      developer: f.owner.address,
    };
  const round = { ...wager, round: roundId(secret) };
  await disagreeNever(await craft(a, { ...wager, round: id('another round') }, secret, seed), /Invalid bet/);
  await disagreeNever(await craft(a, round, id('another secret'), seed), /Invalid bet/);
  await disagreeNever(await craft(a, round, secret, id('another seed')), /Invalid bet/);
  await disagreeNever(await craft(a, round, secret), /Invalid bet/);
  for (const bad of [{ rangeStart: 1n << 62n }, { rangeEnd: (1n << 64n) + 1n }, { payout: 0n }, { payout: 1n << 128n }])
    await disagreeNever(
      await craft(a, { ...round, prizes: [prize, { ...prize, ...bad }] }, secret, seed),
      /Invalid bet/,
    );
  await disagreeNever(await craft(a, { ...round, prizes: [] }, secret, seed), /Invalid bet/);
  await disagreeNever(await craft(a, { ...round, prizes: Array(65).fill(prize) }, secret, seed), /Invalid bet/);
  await disagreeNever(await craft(a, { ...round, seedHash: ZeroHash }, secret, ZeroHash), /Invalid bet/);
  await disagreeNever(await craft(a, { ...round, developer: ZeroAddress }, secret, seed), /Invalid bet/);
  await disagreeNever(await craft(a, { ...round, game: ZeroHash }, secret, seed), /Invalid bet/);
  await disagreeNever(await craft(a, { ...round, amount: 5000n }, secret, seed), /Invalid bet/);
  await disagreeNever(
    await craft(a, { kind: 2, amount: 10n, game: GAME, round: id('stray round') }),
    /Invalid payment/,
  );
  await disagreeNever(await craft(a, { kind: 2, amount: 10n, game: GAME, prizes: [prize] }), /Invalid payment/);
  // The stake is paid to enter and every prize holding the outcome pays: a full table of 64 overlapping
  // prizes, a prize over the whole outcome space and a prize below the stake all agree on-chain.
  const everything = { rangeStart: 0n, rangeEnd: 1n << 64n, payout: 3n };
  const paytable = await step(f, a, 1, 100n, {
    prizes: [
      everything,
      ...Array.from({ length: 63 }, (_, i) => ({
        rangeStart: 0n,
        rangeEnd: (1n << 64n) >> BigInt(i % 8),
        payout: BigInt(i + 1),
      })),
    ],
    seed: id('paytable'),
  });
  const before = BigInt(a.state.balance);
  await agree(a, paytable.evidence);
  assert.ok(
    BigInt(a.state.balance) >= before - 100n + 3n + 8n * 9n,
    'the stake left, and every prize over the whole space came back',
  );
  // Two channels betting complementary ranges on one round and seed: exactly one of them is paid.
  const seat = { seed: id('shared seed'), secret: id('the secret of a shared round') };
  const low = await step(f, a, 1, 100n, { ...seat, prizes: [{ rangeStart: 0n, rangeEnd: 1n << 63n, payout: 150n }] }),
    high = await step(f, b, 1, 100n, {
      ...seat,
      prizes: [{ rangeStart: 1n << 63n, rangeEnd: 1n << 64n, payout: 150n }],
    });
  assert.deepEqual(
    [BigInt(low.state.balance) > BigInt(a.state.balance), BigInt(high.state.balance) > BigInt(b.state.balance)].sort(),
    [false, true],
    'complementary ranges split one outcome',
  );
  for (const bet of [low, high])
    assert.equal(
      (await f.contract.supported(bet.evidence)).balance,
      BigInt(bet.state.balance),
      'one secret settles both',
    );
  await disagreeNever(await craft(a, { kind: 3, amount: 20n, counterparty: a.state.channelId }), /Invalid transfer/);
  await disagreeNever(await craft(a, { kind: 2, amount: 10n, counterparty: b.state.channelId }), /Invalid payment/);
  await disagreeNever(await craft(a, { kind: 2, amount: 5000n }), /Invalid payment/);
  for (const kind of [5, 6, 7, 8])
    await disagreeNever(await craft(a, { kind, amount: 1n, counterparty: fund }), /Unknown operation/);
  // A checkpoint-only proof must carry the canonical empty step.
  const padded = checkpointEvidence(a.state, a.evidence.playerSignature, a.evidence.casinoSignature);
  padded.step.secret = id('stray secret');
  await assert.rejects(f.contract.supported(padded));
  padded.step.secret = ZeroHash;
  padded.step.seed = id('stray seed');
  await assert.rejects(f.contract.supported(padded));
  assert.ok((await f.contract.supported(a.evidence)).balance === BigInt(a.state.balance));
  assert.equal(padded.step.operation.seedHash, ZeroHash);
});
