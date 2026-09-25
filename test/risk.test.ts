import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, id, keccak256 } from 'ethers';
import { domain, hashOperation, outcome, seedHash } from '../protocol/protocol.ts';
import { buildVectors } from '../scripts/vectors.ts';
import { OUTCOME_SPACE, UINT256_MAX, assessBet, describeBet, MAX_PRIZES } from '../protocol/risk.ts';

const zero32 = `0x${'00'.repeat(32)}`;
const secret0 = `0x${'cd'.repeat(32)}`;
const casino = '0x0000000000000000000000000000000000000001';
const player = '0x0000000000000000000000000000000000000002';
const units = 1_000_000n;
const terms = { bankroll: 10_000n * units, stake: 1_000n * units, netWin: 100n * units };
/** One stake with one prize below a threshold: the binary casino bet whose closed form
 * (B-W-F)(S-F)Q >= B*t*(S+W) the general condition must reduce to exactly. */
const assessBinary = ({
  bankroll,
  stake,
  netWin,
  winThreshold,
}: Record<'bankroll' | 'stake' | 'netWin' | 'winThreshold', bigint>) => {
  const risk = assessBet({
    bankroll,
    bet: { stake, prizes: [{ rangeStart: 0n, rangeEnd: winThreshold, payout: stake + netWin }] },
  });
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

test('the integer search matches exhaustive fee enumeration on small bankrolls', () => {
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
  for (const payout of [0n, -1n, UINT256_MAX + 1n, 100])
    assert.throws(() =>
      assessBet({
        bankroll: good.bankroll,
        bet: { stake: good.stake, prizes: [{ rangeStart: 0n, rangeEnd: 1n, payout: payout as bigint }] },
      }),
    );
  // A prize that always pays more than the stake can never be admitted; one past the outcome space is malformed.
  for (const winThreshold of [0n, OUTCOME_SPACE, OUTCOME_SPACE + 1n, 0.5])
    assert.throws(() => assessBinary({ ...good, winThreshold: winThreshold as bigint }));
  assert.throws(() => assessBinary({ ...good, netWin: terms.bankroll }), /available bankroll/);
  assert.throws(() => riskAtEdge(99n), /Kelly/);
  assert.throws(() => assessBinary({ ...good, stake: UINT256_MAX }), /payout/);
  assert.throws(
    () => assessBinary({ bankroll: UINT256_MAX, stake: 2n, netWin: 1n, winThreshold: 1n }),
    /bankroll after player loss/,
  );
});

test('signed operation binds every field and deployment domain', () => {
  const v = buildVectors(),
    d = domain(v.identity.chainId, v.identity.casino),
    digest = hashOperation(d, v.request);
  for (const [field, value] of Object.entries(v.request)) {
    if (field === 'prizes') continue;
    const changed =
      field === 'developer'
        ? casino
        : typeof value === 'string' && value.startsWith('0x')
          ? secret0
          : String(BigInt(value as string) + 1n);
    assert.notEqual(hashOperation(d, { ...v.request, [field]: changed }), digest, field);
  }
  // Every field of every prize is signed, and so are their number and order.
  const prizes = v.request.prizes;
  for (const [i, prize] of prizes.entries())
    for (const field of ['rangeStart', 'rangeEnd', 'payout'] as const) {
      const changed = prizes.map((p, j) => (i === j ? { ...p, [field]: String(BigInt(prize[field]) + 1n) } : p));
      assert.notEqual(hashOperation(d, { ...v.request, prizes: changed }), digest, `prizes[${i}].${field}`);
    }
  assert.notEqual(hashOperation(d, { ...v.request, prizes: prizes.slice(1) }), digest);
  assert.notEqual(hashOperation(d, { ...v.request, prizes: [...prizes, prizes[0]] }), digest);
  assert.notEqual(hashOperation(d, { ...v.request, prizes: [...prizes].reverse() }), digest);
  assert.notEqual(hashOperation({ ...d, chainId: '1' }, v.request), digest);
  assert.notEqual(hashOperation({ ...d, verifyingContract: player }, v.request), digest);
});
test('outcome depends only on the round: every prize holding it pays, and overlapping prizes add', () => {
  const v = buildVectors(),
    result = outcome(v.request.prizes, v.seed, secret0);
  const expected = keccak256(
    AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'bytes32'], [id('HOOKEDIN/OUTCOME'), v.seed, secret0]),
  );
  const value = BigInt(expected) & (OUTCOME_SPACE - 1n);
  assert.equal(result.randomHash, expected);
  assert.equal(result.value, value);
  // Another channel's bet on the same round and seed sees the same outcome; another seed does not.
  assert.equal(outcome([], v.seed, secret0).value, value);
  assert.notEqual(outcome(v.request.prizes, id('other'), secret0).randomHash, expected);
  assert.equal(seedHash(v.seed), v.request.seedHash, 'the bet names its seed by its hash');
  const paid = (prizes: any[], secret: string) => outcome(prizes, v.seed, secret).payout;
  for (const secret of v.secrets) {
    const u = outcome(v.request.prizes, v.seed, secret).value,
      half = OUTCOME_SPACE / 2n;
    // Complementary ranges split every outcome between them: exactly one pays.
    const low = { rangeStart: 0n, rangeEnd: half, payout: 5n },
      high = { rangeStart: half, rangeEnd: OUTCOME_SPACE, payout: 7n };
    assert.equal(paid([low, high], secret), u < half ? 5n : 7n);
    // Overlapping prizes all pay: a prize over everything adds to whichever half was hit.
    assert.equal(
      paid([low, high, { rangeStart: 0n, rangeEnd: OUTCOME_SPACE, payout: 100n }], secret),
      (u < half ? 5n : 7n) + 100n,
    );
    // The boundaries are exact: [u, u+1) holds the outcome, its neighbours do not.
    assert.equal(paid([{ rangeStart: u, rangeEnd: u + 1n, payout: 9n }], secret), 9n);
    if (u > 0n) assert.equal(paid([{ rangeStart: 0n, rangeEnd: u, payout: 9n }], secret), 0n);
    if (u + 1n < OUTCOME_SPACE)
      assert.equal(paid([{ rangeStart: u + 1n, rangeEnd: OUTCOME_SPACE, payout: 9n }], secret), 0n);
  }
});

test('a casino bet is one wager: prizes on the same outcomes stack, prizes on different outcomes hedge', t => {
  const bankroll = 10n ** 18n,
    pocket = OUTCOME_SPACE / 37n,
    stake = 10n ** 16n;
  /** Chips of `stake` each on red, and on black: one casino bet, whoever holds the chips. */
  const table = (reds: bigint, blacks: bigint) => ({
    stake: (reds + blacks) * stake,
    prizes: [
      ...(reds ? [{ rangeStart: 0n, rangeEnd: pocket * 18n, payout: 2n * reds * stake }] : []),
      ...(blacks ? [{ rangeStart: pocket * 18n, rangeEnd: pocket * 36n, payout: 2n * blacks * stake }] : []),
    ],
  });
  const one = assessBet({ bankroll, bet: table(1n, 0n) }),
    two = assessBet({ bankroll, bet: table(2n, 0n) }),
    hedged = assessBet({ bankroll, bet: table(1n, 1n) });
  // One chip is exactly the single-wager formula.
  const single = assessBinary({ bankroll, stake, netWin: stake, winThreshold: pocket * 18n });
  assert.deepEqual([one.maxFee, one.fee, one.liability], [single.maxFee, single.fee, single.liability]);
  // Two chips on the same side are one double-sized wager for the bankroll.
  const doubled = assessBinary({ bankroll, stake: 2n * stake, netWin: 2n * stake, winThreshold: pocket * 18n });
  assert.equal(two.maxFee, doubled.maxFee);
  assert.equal(two.liability - two.fee, 2n * stake);
  assert.ok(two.fee < 2n * one.fee, 'stacked risk leaves less surplus edge per chip');
  // Red and black cannot both win: the bankroll never loses, and gains both stakes on green.
  assert.ok(hedged.fee > 2n * one.fee, 'a hedged table carries more surplus edge');
  assert.equal(hedged.liability, hedged.fee, 'no outcome costs the bankroll more than its commission');
  // A 2.7% edge carries 1% of bankroll per chip twice, not three times.
  assert.throws(() => assessBet({ bankroll, bet: table(3n, 0n) }), /Kelly limit/);
  assert.ok(assessBet({ bankroll, bet: table(3n, 3n) }).fee > 0n);
  // The fee is an even number of wei, never more than the safe most.
  assert.ok(hedged.fee % 2n === 0n && hedged.fee <= hedged.maxFee);
  const seat = (rangeStart: bigint, rangeEnd: bigint, amount = stake) => ({
    stake: amount,
    prizes: [{ rangeStart, rangeEnd, payout: 2n * amount }],
  });
  assert.throws(() => assessBet({ bankroll, bet: { stake: 1n, prizes: [] } }), /1 to 64 prizes/);
  assert.throws(
    () => assessBet({ bankroll, bet: { stake: 1n, prizes: Array(MAX_PRIZES + 1).fill(seat(0n, 1n).prizes[0]) } }),
    /1 to 64 prizes/,
  );
  assert.throws(() => assessBet({ bankroll, bet: seat(5n, 5n) }), /within \[0, 2\^64\)/);
  assert.throws(() => assessBet({ bankroll, bet: seat(0n, OUTCOME_SPACE + 1n) }), /within \[0, 2\^64\)/);
  assert.throws(() => assessBet({ bankroll, bet: seat(0n, 1n, bankroll) }), /less than the available bankroll/);
  // A bet that cannot lose is not a bet the bankroll takes; covering the wheel at the house's odds is.
  assert.throws(() => assessBet({ bankroll, bet: seat(0n, OUTCOME_SPACE) }), /Kelly limit/);
  const everything = {
    stake: 37n * 10n ** 15n,
    prizes: [{ rangeStart: 0n, rangeEnd: OUTCOME_SPACE, payout: 36n * 10n ** 15n }],
  };
  assert.equal(assessBet({ bankroll, bet: everything }).liability, assessBet({ bankroll, bet: everything }).fee);
  t.diagnostic(
    JSON.stringify(
      { one: one.fee, stackedTwo: two.fee, hedged: hedged.fee, hedgedLiability: hedged.liability },
      (_, v) => (typeof v === 'bigint' ? String(v) : v),
    ),
  );
});

test('a paytable is one bet: partial losses, overlapping chips and the exact return a player signs', t => {
  const Q = OUTCOME_SPACE,
    stake = 10n ** 15n;
  // Plinko, eight rows: binomial widths are exact in 2^64, and most buckets pay back less than the stake.
  const tenths = [260n, 40n, 12n, 3n, 4n, 3n, 12n, 40n, 260n],
    ways = [1n, 8n, 28n, 56n, 70n, 56n, 28n, 8n, 1n];
  let edge = 0n;
  const plinko = {
    stake,
    prizes: ways.map((w, i) => {
      const prize = { rangeStart: edge, rangeEnd: edge + (Q / 256n) * w, payout: (stake * tenths[i]) / 10n };
      edge = prize.rangeEnd;
      return prize;
    }),
  };
  assert.equal(edge, Q, 'binomial buckets tile the outcome space exactly');
  const table = describeBet(plinko);
  assert.equal(table.maxPayout, stake * 26n);
  const expected = ways.reduce((sum, w, i) => sum + w * tenths[i], 0n); // out of 2560 stakes
  assert.equal(table.expectedPayout * 2560n, expected * stake * Q, 'the return is exact, not sampled');
  assert.ok(expected < 2560n, 'and below one stake');
  const risk = assessBet({ bankroll: 10n ** 20n, bet: plinko });
  assert.equal(risk.liability - risk.fee, stake * 25n, 'the bankroll can lose the top bucket less the stake');
  // Roulette: chips overlap. 10 on red, 5 on the first dozen, 1 on 9, which is red and in that dozen.
  const pocket = Q / 37n,
    reds = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
  const at = (n: number, payout: bigint) => ({
    rangeStart: pocket * BigInt(n),
    rangeEnd: pocket * BigInt(n + 1),
    payout,
  });
  const chips = {
    stake: 16n * stake,
    prizes: [
      ...reds.map(n => at(n, 20n * stake)),
      { rangeStart: pocket, rangeEnd: pocket * 13n, payout: 15n * stake },
      at(9, 36n * stake),
    ],
  };
  assert.equal(chips.prizes.length, 20);
  assert.equal(describeBet(chips).maxPayout, 71n * stake, 'on 9 the colour, the dozen and the number all pay');
  // Flattened to one payout per pocket it is the same wager: same cells, same price.
  const perPocket = Array.from({ length: 37 }, (_, n) => ({
    n,
    payout: chips.prizes.reduce(
      (sum, p) => (pocket * BigInt(n) >= p.rangeStart && pocket * BigInt(n) < p.rangeEnd ? sum + p.payout : sum),
      0n,
    ),
  })).filter(p => p.payout > 0n);
  const flat = { stake: chips.stake, prizes: perPocket.map(p => at(p.n, p.payout)) };
  const a = assessBet({ bankroll: 10n ** 20n, bet: chips }),
    b = assessBet({ bankroll: 10n ** 20n, bet: flat });
  assert.deepEqual([a.maxFee, a.liability], [b.maxFee, b.liability]);
  assert.deepEqual(describeBet(chips), describeBet(flat));
  // A table of players as one casino bet: each pocket pays what their chips pay on it together, so the bet stays
  // within 37 pockets however many sit down.
  const started = performance.now(),
    full = assessBet({
      bankroll: 10n ** 22n,
      bet: {
        stake: 256n * chips.stake,
        prizes: Array.from({ length: 37 }, (_, n) =>
          at(n, 256n * perPocket.reduce((sum, p) => (p.n === n ? sum + p.payout : sum), 0n) + 7n * stake),
        ),
      },
    }),
    elapsed = performance.now() - started;
  assert.ok(full.fee > 0n && elapsed < 2000);
  t.diagnostic(
    JSON.stringify({
      plinkoRtp: Number(expected) / 2560,
      rouletteSeats: 256,
      ms: Math.round(elapsed),
      chipsMaxPayoutInStakes: 71,
    }),
  );
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
