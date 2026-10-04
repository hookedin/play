import test from 'node:test';
import assert from 'node:assert/strict';
import { id, ZeroAddress, ZeroHash } from 'ethers';
import { anvil, deployment, open, step, below } from '../testing/contract.ts';
import {
  deriveState,
  hashState,
  checkpointEvidence,
  operation,
  roundId,
  seedHash,
  STATE_TYPES,
  OP_TYPES,
} from '../protocol/protocol.ts';
import { MAX_BALANCE } from '../protocol/risk.ts';

/** The contract and the TypeScript derivation are hand-mirrored; feed both the same
 * evidence for every kind and every invalid branch and require identical verdicts. */
test('the contract and deriveState agree on every operation kind and invalid encoding', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env);
  const a = await open(f, env.wallets[1], 1000n),
    b = await open(f, env.wallets[2], 1000n);
  const agree = async (ch: any, evidence: any) => {
    const local = deriveState(f.d, evidence.base, evidence.step.operation, evidence.step.secret, evidence.step.seed);
    const onchain = await f.contract.supported(evidence);
    assert.equal(hashState(f.d, onchain.toObject()), hashState(f.d, local));
    ch.state = local;
    ch.evidence = checkpointEvidence(
      local,
      await ch.player.signTypedData(f.d, STATE_TYPES, local),
      await f.owner.signTypedData(f.d, STATE_TYPES, local),
    );
  };
  // Build evidence without deriving locally, so invalid encodings reach both verifiers.
  const craft = async (ch: any, values: any, secret = ZeroHash, seed = ZeroHash) => {
    const op = operation(f.d, ch.state, { memo: id('craft ' + Math.random()), ...values });
    return {
      ...ch.evidence,
      step: {
        operation: op,
        authorization: await ch.player.signTypedData(f.d, OP_TYPES, op),
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
    await assert.rejects(f.contract.supported(evidence));
  };
  // Valid transitions: a bet, a debit, a credit, a deposit, a withdrawal and a lock-in. The memo means nothing to either
  // verifier.
  const bet = await step(f, a, 1, 100n, { ...below(1n << 62n, 150n), seed: id('seed') });
  await agree(a, bet.evidence);
  const debit = await step(f, a, 2, 10n);
  await agree(a, debit.evidence);
  const credit = await step(f, b, 3, 20n, { memo: ZeroHash });
  await agree(b, credit.evidence);
  // A deposit takes money into the balance and counts it as deposited; whether it was is a close's to check.
  const deposit = await step(f, b, 4, 30n);
  await agree(b, deposit.evidence);
  assert.deepEqual([b.state.balance, b.state.deposited], ['1050', '1030']);
  // A withdrawal takes its amount out, and names whom it goes to; a lock-in goes into the account's own channel and
  // names nobody, and each pays the fee it names. There is no other kind.
  const recipient = '0x5555555555555555555555555555555555555555';
  await agree(b, (await step(f, b, 5, 40n, { recipient })).evidence);
  assert.equal(b.state.balance, '1010');
  await disagreeNever(await craft(b, { kind: 5, amount: 1011n, recipient }), /Insufficient balance/);
  await disagreeNever(await craft(b, { kind: 5, amount: 1000n, recipient, fee: 11n }), /Insufficient balance/);
  await agree(b, (await step(f, b, 6, 10n, { fee: 3n })).evidence);
  assert.deepEqual([b.state.balance, b.state.withdrawn], ['997', '50']);
  await disagreeNever(await craft(b, { kind: 7, amount: 10n, recipient }), /Unknown operation/);
  // Every field a kind does not use must be zero; both sides reject the same encodings.
  for (const [kind, reason] of [
    [2, /Invalid debit/],
    [3, /Invalid credit/],
    [4, /Invalid deposit/],
  ] as const)
    await disagreeNever(await craft(a, { kind, amount: 10n, recipient }), reason);
  // A withdrawal names neither nobody nor the contract itself, a lock-in no one at all, and only they pay a fee.
  for (const nobody of [ZeroAddress, await f.contract.getAddress()])
    await disagreeNever(await craft(a, { kind: 5, amount: 10n, recipient: nobody }), /Invalid withdrawal/);
  for (const someone of [recipient, a.player.address, await f.contract.getAddress()])
    await disagreeNever(await craft(a, { kind: 6, amount: 10n, recipient: someone }), /Invalid lock-in/);
  await disagreeNever(await craft(a, { kind: 5, amount: 10n, recipient, fee: MAX_BALANCE }), /Invalid withdrawal/);
  for (const [kind, reason] of [
    [2, /Invalid debit/],
    [3, /Invalid credit/],
    [4, /Invalid deposit/],
  ] as const)
    await disagreeNever(await craft(a, { kind, amount: 10n, fee: 1n }), reason);
  for (const [kind, reason] of [
    [2, /Invalid debit/],
    [3, /Invalid credit/],
    [4, /Invalid deposit/],
    [5, /Invalid withdrawal/],
    [6, /Invalid lock-in/],
  ] as const) {
    const named = kind === 5 ? { recipient } : {};
    const kindOf = (values: Record<string, unknown>) => ({ kind, ...named, ...values });
    await disagreeNever(await craft(a, kindOf({ amount: 10n, round: id('a round') })), reason);
    await disagreeNever(await craft(a, kindOf({ amount: 10n, seedHash: id('entropy') })), reason);
    await disagreeNever(await craft(a, kindOf({ amount: 10n }), id('not zero')), reason);
    await disagreeNever(await craft(a, kindOf({ amount: 10n }), ZeroHash, id('not zero')), reason);
    await disagreeNever(await craft(a, kindOf({ amount: 0n })), reason);
    await disagreeNever(await craft(a, kindOf({ amount: 10n, chance: 1n })), reason);
    await disagreeNever(await craft(a, kindOf({ amount: 10n, prize: 1n })), reason);
  }
  // Only the secret of the round a bet signed, and the seed it named, settle it; its odds are well formed.
  const secret = id('a secret'),
    seed = id('s'),
    casinoBet = { kind: 1, amount: 100n, ...below(1n << 62n, 150n), seedHash: seedHash(seed) };
  const round = { ...casinoBet, round: roundId(secret) };
  await disagreeNever(await craft(a, { ...casinoBet, round: id('another round') }, secret, seed), /Invalid casino bet/);
  await disagreeNever(await craft(a, round, id('another secret'), seed), /Invalid casino bet/);
  await disagreeNever(await craft(a, round, secret, id('another seed')), /Invalid casino bet/);
  await disagreeNever(await craft(a, round, secret), /Invalid casino bet/);
  for (const bad of [{ chance: 0n }, { prize: 0n }, { prize: MAX_BALANCE }])
    await disagreeNever(await craft(a, { ...round, ...bad }, secret, seed), /Invalid casino bet/);
  await disagreeNever(await craft(a, { ...round, seedHash: ZeroHash }, secret, ZeroHash), /Invalid casino bet/);
  await disagreeNever(await craft(a, { ...round, amount: 5000n }, secret, seed), /Invalid casino bet/);
  // A chance counts outcomes out of 2^64 in 64 bits: one past the space cannot even be signed.
  await assert.rejects(craft(a, { ...round, chance: 1n << 64n }, secret, seed));
  // The stake is paid to enter and the prize comes back below the chance: a bet on all but one outcome and a prize
  // below the stake both agree on-chain.
  const before = BigInt(a.state.balance),
    nearlySure = await step(f, a, 1, 100n, { ...below((1n << 64n) - 1n, 3n), seed: id('nearly sure') });
  await agree(a, nearlySure.evidence);
  assert.ok([before - 100n, before - 97n].includes(BigInt(a.state.balance)), 'the stake left, and 3 came back or not');
  // Two channels betting on one round and seed see one outcome: they win or lose together.
  const shared = { seed: id('one seed'), secret: id('one secret') };
  const first = await step(f, a, 1, 100n, { ...shared, ...below(1n << 63n, 150n) }),
    second = await step(f, b, 1, 100n, { ...shared, ...below(1n << 63n, 150n) });
  assert.equal(
    BigInt(first.state.balance) > BigInt(a.state.balance),
    BigInt(second.state.balance) > BigInt(b.state.balance),
    'one outcome settles both',
  );
  for (const bet of [first, second])
    assert.equal(
      (await f.contract.supported(bet.evidence)).balance,
      BigInt(bet.state.balance),
      'one secret settles both',
    );
  await disagreeNever(await craft(a, { kind: 2, amount: 5000n }), /Insufficient balance/);
  await disagreeNever(await craft(a, { kind: 5, amount: 5000n, recipient }), /Insufficient balance/);
  for (const kind of [8, 9, 10]) await disagreeNever(await craft(a, { kind, amount: 1n }), /Unknown operation/);
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
