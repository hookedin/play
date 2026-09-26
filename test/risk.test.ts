import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, id, keccak256 } from 'ethers';
import { betPayout, domain, hashOperation, outcome, seedHash } from '../protocol/protocol.ts';
import { buildVectors } from '../scripts/vectors.ts';
import { OUTCOME_SPACE, UINT256_MAX, assessBet, describeBet } from '../protocol/risk.ts';

const secret0 = `0x${'cd'.repeat(32)}`;
const player = '0x0000000000000000000000000000000000000002';
const units = 1_000_000n;
const terms = { bankroll: 10_000n * units, stake: 1_000n * units, netWin: 100n * units };
/** A stake that wins `netWin` when the outcome falls below `winThreshold`: the casino bet, whose Kelly condition is
 * (B-W-F)(S-F)Q >= B*t*(S+W). */
const assessBinary = ({
  bankroll,
  stake,
  netWin,
  winThreshold,
}: Record<'bankroll' | 'stake' | 'netWin' | 'winThreshold', bigint>) => {
  const risk = assessBet({ bankroll, bet: { stake, chance: winThreshold, prize: stake + netWin } });
  return {
    ...risk,
    stake,
    netWin,
    winThreshold,
    grossPayout: stake + netWin,
    developerFee: risk.fee / 2n,
    casinoFee: risk.fee / 2n,
  };
};
/** The largest integer threshold whose edge is at least `edgeBps`. */
const thresholdForEdge = ({ stake, netWin, edgeBps }: Record<'stake' | 'netWin' | 'edgeBps', bigint>) =>
  (OUTCOME_SPACE * stake * (10_000n - edgeBps)) / (10_000n * (stake + netWin));
const riskAtEdge = (edgeBps: any, input = terms) =>
  assessBinary({ ...input, winThreshold: thresholdForEdge({ ...input, edgeBps: edgeBps as bigint }) });
const safe = (
  q: Pick<ReturnType<typeof assessBinary>, 'bankroll' | 'stake' | 'netWin' | 'winThreshold' | 'grossPayout'>,
  fee: bigint,
) =>
  fee < q.stake &&
  q.netWin + fee < q.bankroll &&
  (q.bankroll - q.netWin - fee) * (q.stake - fee) * OUTCOME_SPACE >= q.bankroll * q.winThreshold * q.grossPayout;

test('a bet exactly at the stated Kelly edge pays no material commission', () => {
  const q = riskAtEdge(100n);
  assert.equal(q.fee, 0n);
  assert.equal(q.liability, q.netWin);
  assert.ok(safe(q, q.fee));
});

test('extra edge funds equal fixed fees while preserving exact bankroll Kelly', () => {
  const q = riskAtEdge(200n);
  assert.equal(q.developerFee, q.casinoFee);
  assert.equal(q.fee, q.developerFee * 2n);
  assert.ok(q.fee > 0n);
  assert.ok(q.maxFee - q.fee <= 1n);
  assert.ok(safe(q, q.maxFee));
  assert.ok(!safe(q, q.maxFee + 1n));
  assert.equal(q.liability, q.netWin + q.fee);
  assert.equal(q.grossPayout, q.stake + q.netWin);
  assert.ok(!safe(q, 10n * units), 'a naive stake times excess-edge fee overbets this risk');
});

test('paying developers never relies on the expected profit as collateral', () => {
  const q = riskAtEdge(200n);
  assert.equal(q.stake + q.liability, q.grossPayout + q.developerFee + q.casinoFee);
  const onWin = q.bankroll - q.liability;
  const onLoss = q.bankroll + q.stake - q.fee;
  assert.ok(onWin > 0n);
  assert.equal(onLoss - q.bankroll, q.stake - q.fee);
});

test('a self-referring player receives only their funded half of commission', () => {
  const q = riskAtEdge(200n);
  const expectedPlayerLossNumerator = q.stake * OUTCOME_SPACE - q.winThreshold * q.grossPayout;
  assert.ok(expectedPlayerLossNumerator > q.developerFee * OUTCOME_SPACE);
});

test('the closed-form fee matches exhaustive fee enumeration on small bankrolls', () => {
  for (let bankroll = 3n; bankroll <= 12n; bankroll += 1n) {
    for (let stake = 1n; stake <= 8n; stake += 1n) {
      for (let netWin = 1n; netWin < bankroll; netWin += 1n) {
        for (const winThreshold of [1n, OUTCOME_SPACE / 8n, OUTCOME_SPACE / 2n, OUTCOME_SPACE - 1n]) {
          const input = { bankroll, stake, netWin, winThreshold, grossPayout: stake + netWin };
          const fees = [];
          for (let fee = 0n; fee < stake && fee + netWin < bankroll; fee += 1n) {
            if (safe(input, fee)) fees.push(fee);
          }
          if (fees.length === 0) assert.throws(() => assessBinary(input), /Kelly/);
          else assert.equal(assessBinary(input).maxFee, fees.at(-1));
        }
      }
    }
  }
});

test('more available bankroll cannot reduce the safe commission', () => {
  const winThreshold = thresholdForEdge({ ...terms, edgeBps: 200n });
  let previous = 0n;
  for (const multiple of [1n, 2n, 5n, 10n, 100n]) {
    const q = assessBinary({ ...terms, bankroll: terms.bankroll * multiple, winThreshold });
    assert.ok(q.maxFee >= previous);
    previous = q.maxFee;
  }
});

test('there is no percentage cap apart from Kelly and bankroll backing', () => {
  const q = assessBinary({ bankroll: 1_000_000n, stake: 100n, netWin: 999_999n, winThreshold: 1n });
  assert.equal(q.netWin, q.bankroll - 1n);
  assert.equal(q.fee, 0n);
});

test('large intermediate products stay exact near uint256 limits', () => {
  const q = assessBinary({
    bankroll: UINT256_MAX - UINT256_MAX / 4n,
    stake: UINT256_MAX / 4n,
    netWin: UINT256_MAX / 2n,
    winThreshold: 1n,
  });
  assert.ok(q.bankroll * q.winThreshold * q.grossPayout > UINT256_MAX);
  assert.ok(safe(q, q.fee));
  assert.ok(!safe(q, q.maxFee + 1n));
  assert.equal(q.developerFee, q.casinoFee);
});

test('invalid odds, unbacked bets, excessive fees, and uint256 overflow are rejected', () => {
  const good = { ...terms, winThreshold: OUTCOME_SPACE / 2n };
  for (const field of ['bankroll', 'stake']) {
    for (const value of [0n, -1n, UINT256_MAX + 1n, 100])
      assert.throws(() => assessBinary({ ...good, [field]: value }));
  }
  for (const prize of [0n, -1n, UINT256_MAX + 1n, 100])
    assert.throws(() =>
      assessBet({ bankroll: good.bankroll, bet: { stake: good.stake, chance: 1n, prize: prize as bigint } }),
    );
  // A bet that cannot lose or cannot win is no bet; a chance past the outcome space is malformed.
  for (const winThreshold of [0n, -1n, OUTCOME_SPACE, OUTCOME_SPACE + 1n, 0.5])
    assert.throws(() => assessBinary({ ...good, winThreshold: winThreshold as bigint }), /chance/);
  assert.throws(() => assessBinary({ ...good, netWin: terms.bankroll }), /available bankroll/);
  assert.throws(() => riskAtEdge(99n), /Kelly/);
  assert.throws(() => assessBinary({ ...good, stake: UINT256_MAX }), /prize/);
  assert.throws(
    () => assessBinary({ bankroll: UINT256_MAX, stake: 2n, netWin: 1n, winThreshold: 1n }),
    /bankroll after player loss/,
  );
});

test('signed operation binds every field and deployment domain', () => {
  const v = buildVectors(),
    d = domain(v.identity.chainId, v.identity.casino),
    request = v.operations[0].operation,
    digest = hashOperation(d, request);
  for (const [field, value] of Object.entries(request)) {
    const changed =
      typeof value === 'string' && value.startsWith('0x') ? secret0 : String(BigInt(value as string) + 1n);
    assert.notEqual(hashOperation(d, { ...request, [field]: changed }), digest, field);
  }
  // A chance is 64 bits: one past the outcome space cannot even be signed.
  assert.throws(() => hashOperation(d, { ...request, chance: String(OUTCOME_SPACE) }));
  assert.notEqual(hashOperation({ ...d, chainId: '1' }, request), digest);
  assert.notEqual(hashOperation({ ...d, verifyingContract: player }, request), digest);
});
test('outcome depends only on the round, and a bet pays its prize exactly when the outcome is below its chance', () => {
  const { operation: request, seed } = buildVectors().operations[0],
    result = outcome(seed, secret0);
  const expected = keccak256(
    AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'bytes32'], [id('HOOKEDIN/OUTCOME'), seed, secret0]),
  );
  assert.equal(result.randomHash, expected);
  assert.equal(result.value, BigInt(expected) & (OUTCOME_SPACE - 1n));
  // Another channel's bet on the same round and seed sees the same outcome; another seed does not.
  assert.notEqual(outcome(id('other'), secret0).randomHash, expected);
  assert.equal(seedHash(seed), request.seedHash, 'the bet names its seed by its hash');
  for (const secret of [1, 2, 3, 4].map(n => id(`secret ${n}`))) {
    const u = outcome(seed, secret).value;
    // The boundary is exact: a chance of u + 1 holds the outcome, a chance of u does not.
    assert.equal(betPayout({ chance: u + 1n, prize: 9n }, u), 9n);
    assert.equal(betPayout({ chance: u, prize: 9n }, u), 0n);
  }
});

test('a bet whose prize is at most its stake can only lose the bankroll its commission', () => {
  const bankroll = 10n ** 18n,
    partial = assessBet({ bankroll, bet: { stake: 10n ** 15n, chance: OUTCOME_SPACE / 2n, prize: 4n * 10n ** 14n } }),
    even = assessBet({ bankroll, bet: { stake: 10n ** 15n, chance: OUTCOME_SPACE - 1n, prize: 10n ** 15n } });
  assert.equal(partial.liability, partial.fee);
  assert.equal(even.liability, even.fee);
  assert.ok(partial.fee > 0n && partial.fee < 10n ** 15n);
  assert.deepEqual(describeBet({ stake: 10n ** 15n, chance: 3n, prize: 5n }), { maxPayout: 5n, expectedPayout: 15n });
});

test('wallet pricing: 240 boundary-oriented risks match an independent integer-root oracle', async t => {
  const max = (1n << 256n) - 1n;
  const sqrt = (n: bigint) => {
    if (n < 2n) return n;
    let x = n,
      y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + n / x) / 2n;
    }
    return x;
  };
  function oracle(b: bigint, s: bigint, w: bigint, p: bigint) {
    if (!b || !s || !w || !p || p >= OUTCOME_SPACE || w >= b || s + w > max) return null;
    const a = b - w,
      required = (b * p * (s + w) + OUTCOME_SPACE - 1n) / OUTCOME_SPACE;
    if (a * s < required) return null;
    let fee = (a + s - sqrt((a - s) ** 2n + 4n * required)) / 2n;
    while (fee >= a || fee >= s || (a - fee) * (s - fee) < required) fee--;
    fee &= ~1n;
    return b + s - fee > max ? null : fee;
  }
  let accepted = 0,
    rejected = 0;
  for (let i = 0; i < 240; i++) {
    const bits = [8n, 64n, 128n, 192n, 255n, 256n][i % 6],
      mask = (1n << bits) - 1n;
    const random = (tag: any) => (BigInt(id('risk-review:' + i + ':' + tag)) & mask) + 1n;
    const b = random('b') > max ? max : random('b');
    const s = random('s') / 2n + 1n,
      w = random('w') / 4n + 1n;
    const p = [1n, OUTCOME_SPACE / 16n, OUTCOME_SPACE / 4n, OUTCOME_SPACE / 2n, OUTCOME_SPACE - 1n][
      Math.floor(i / 6) % 5
    ];
    const expected = oracle(b, s, w, p);
    if (expected === null) {
      assert.throws(() => assessBinary({ bankroll: b, stake: s, netWin: w, winThreshold: p }));
      rejected++;
    } else {
      assert.equal(assessBinary({ bankroll: b, stake: s, netWin: w, winThreshold: p }).fee, expected);
      accepted++;
    }
  }
  t.diagnostic(`Independent quadratic-root oracle: ${accepted} accepted and ${rejected} rejected cases agree.`);
});
