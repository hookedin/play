import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, id, keccak256 } from 'ethers';
import { domain, hashOperation, outcome, seedHash } from '../protocol/protocol.ts';
import { buildVectors } from '../scripts/vectors.ts';
import {
  OUTCOME_SPACE,
  UINT256_MAX,
  assessRound,
  describeBet,
  MAX_ROUND_BETS,
  MAX_PRIZES,
  MAX_ROUND_CELLS,
} from '../protocol/risk.ts';

const zero32 = `0x${'00'.repeat(32)}`;
const secret0 = `0x${'cd'.repeat(32)}`;
const casino = '0x0000000000000000000000000000000000000001';
const player = '0x0000000000000000000000000000000000000002';
const units = 1_000_000n;
const terms = { bankroll: 10_000n * units, stake: 1_000n * units, netWin: 100n * units };
/** One stake with one prize below a threshold: the binary wager whose closed form
 * (B-W-F)(S-F)Q >= B*t*(S+W) the round condition must reduce to exactly. */
const assessBet = ({
  bankroll,
  stake,
  netWin,
  winThreshold,
}: Record<'bankroll' | 'stake' | 'netWin' | 'winThreshold', bigint>) => {
  const risk = assessRound({
    bankroll,
    bets: [{ stake, prizes: [{ rangeStart: 0n, rangeEnd: winThreshold, payout: stake + netWin }] }],
  });
  return {
    ...risk,
    stake,
    netWin,
    winThreshold,
    grossPayout: stake + netWin,
    developerFee: risk.totalFee / 2n,
    casinoFee: risk.totalFee / 2n,
  };
};
/** The largest integer threshold whose edge is at least `edgeBps`. */
const thresholdForEdge = ({ stake, netWin, edgeBps }: Record<'stake' | 'netWin' | 'edgeBps', bigint>) =>
  (OUTCOME_SPACE * stake * (10_000n - edgeBps)) / (10_000n * (stake + netWin));
const riskAtEdge = (edgeBps: any, input = terms) =>
  assessBet({ ...input, winThreshold: thresholdForEdge({ ...input, edgeBps: edgeBps as bigint }) });
const safe = (
  q: Pick<ReturnType<typeof assessBet>, 'bankroll' | 'stake' | 'netWin' | 'winThreshold' | 'grossPayout'>,
  fee: bigint,
) =>
  fee < q.stake &&
  q.netWin + fee < q.bankroll &&
  (q.bankroll - q.netWin - fee) * (q.stake - fee) * OUTCOME_SPACE >= q.bankroll * q.winThreshold * q.grossPayout;

test('a bet exactly at the stated Kelly edge pays no material commission', () => {
  const q = riskAtEdge(100n);
  assert.equal(q.totalFee, 0n);
  assert.equal(q.liability, q.netWin);
  assert.ok(safe(q, q.totalFee));
});

test('extra edge funds equal fixed fees while preserving exact bankroll Kelly', () => {
  const q = riskAtEdge(200n);
  assert.equal(q.developerFee, q.casinoFee);
  assert.equal(q.totalFee, q.developerFee * 2n);
  assert.ok(q.totalFee > 0n);
  assert.ok(q.maxFee - q.totalFee <= 1n);
  assert.ok(safe(q, q.maxFee));
  assert.ok(!safe(q, q.maxFee + 1n));
  assert.equal(q.liability, q.netWin + q.totalFee);
  assert.equal(q.grossPayout, q.stake + q.netWin);
  assert.ok(!safe(q, 10n * units), 'a naive stake times excess-edge fee overbets this risk');
});

test('paying developers never relies on the expected profit as collateral', () => {
  const q = riskAtEdge(200n);
  assert.equal(q.stake + q.liability, q.grossPayout + q.developerFee + q.casinoFee);
  const onWin = q.bankroll - q.liability;
  const onLoss = q.bankroll + q.stake - q.totalFee;
  assert.ok(onWin > 0n);
  assert.equal(onLoss - q.bankroll, q.stake - q.totalFee);
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
          if (fees.length === 0) assert.throws(() => assessBet(input), /Kelly/);
          else assert.equal(assessBet(input).maxFee, fees.at(-1));
        }
      }
    }
  }
});

test('more available bankroll cannot reduce the safe commission', () => {
  const winThreshold = thresholdForEdge({ ...terms, edgeBps: 200n });
  let previous = 0n;
  for (const multiple of [1n, 2n, 5n, 10n, 100n]) {
    const q = assessBet({ ...terms, bankroll: terms.bankroll * multiple, winThreshold });
    assert.ok(q.maxFee >= previous);
    previous = q.maxFee;
  }
});

test('there is no percentage cap apart from Kelly and bankroll backing', () => {
  const q = assessBet({ bankroll: 1_000_000n, stake: 100n, netWin: 999_999n, winThreshold: 1n });
  assert.equal(q.netWin, q.bankroll - 1n);
  assert.equal(q.totalFee, 0n);
});

test('large intermediate products stay exact near uint256 limits', () => {
  const q = assessBet({
    bankroll: UINT256_MAX - UINT256_MAX / 4n,
    stake: UINT256_MAX / 4n,
    netWin: UINT256_MAX / 2n,
    winThreshold: 1n,
  });
  assert.ok(q.bankroll * q.winThreshold * q.grossPayout > UINT256_MAX);
  assert.ok(safe(q, q.totalFee));
  assert.ok(!safe(q, q.maxFee + 1n));
  assert.equal(q.developerFee, q.casinoFee);
});

test('invalid odds, unbacked bets, excessive fees, and uint256 overflow are rejected', () => {
  const good = { ...terms, winThreshold: OUTCOME_SPACE / 2n };
  for (const field of ['bankroll', 'stake']) {
    for (const value of [0n, -1n, UINT256_MAX + 1n, 100]) assert.throws(() => assessBet({ ...good, [field]: value }));
  }
  for (const payout of [0n, -1n, UINT256_MAX + 1n, 100])
    assert.throws(() =>
      assessRound({
        bankroll: good.bankroll,
        bets: [{ stake: good.stake, prizes: [{ rangeStart: 0n, rangeEnd: 1n, payout: payout as bigint }] }],
      }),
    );
  // A prize that always pays more than the stake can never be admitted; one past the outcome space is malformed.
  for (const winThreshold of [0n, OUTCOME_SPACE, OUTCOME_SPACE + 1n, 0.5])
    assert.throws(() => assessBet({ ...good, winThreshold: winThreshold as bigint }));
  assert.throws(() => assessBet({ ...good, netWin: terms.bankroll }), /available bankroll/);
  assert.throws(() => riskAtEdge(99n), /Kelly/);
  assert.throws(() => assessBet({ ...good, stake: UINT256_MAX }), /payout/);
  assert.throws(
    () => assessBet({ bankroll: UINT256_MAX, stake: 2n, netWin: 1n, winThreshold: 1n }),
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

test('round admission prices the shared outcome: stacked bets divide capacity, opposite bets hedge', t => {
  const bankroll = 10n ** 18n,
    pocket = OUTCOME_SPACE / 37n;
  const seat = (rangeStart: bigint, rangeEnd: bigint, stake = 10n ** 16n) => ({
    stake,
    prizes: [{ rangeStart, rangeEnd, payout: 2n * stake }],
  });
  const red = seat(0n, pocket * 18n),
    black = seat(pocket * 18n, pocket * 36n);
  const one = assessRound({ bankroll, bets: [red] }),
    two = assessRound({ bankroll, bets: [red, red] }),
    hedged = assessRound({ bankroll, bets: [red, black] });
  // One bet is exactly the single-wager formula.
  const single = assessBet({ bankroll, stake: red.stake, netWin: red.stake, winThreshold: pocket * 18n });
  assert.deepEqual([one.maxFee, one.totalFee, one.liability], [single.maxFee, single.totalFee, single.liability]);
  // Two players on the same side are one double-sized wager for the bankroll.
  const doubled = assessBet({ bankroll, stake: 2n * red.stake, netWin: 2n * red.stake, winThreshold: pocket * 18n });
  assert.equal(two.maxFee, doubled.maxFee);
  assert.equal(two.liability - two.totalFee, 2n * red.stake);
  assert.ok(two.totalFee < 2n * one.totalFee, 'stacked risk leaves less surplus edge per seat');
  // Red and black cannot both win: the bankroll never loses, and gains both stakes on green.
  assert.ok(hedged.totalFee > 2n * one.totalFee, 'a hedged table carries more surplus edge');
  assert.equal(hedged.liability, hedged.totalFee, 'no outcome costs the bankroll more than its commission');
  // One player holding both chips is the same wager as two players holding one each.
  const both = assessRound({ bankroll, bets: [{ stake: 2n * red.stake, prizes: [...red.prizes, ...black.prizes] }] });
  assert.equal(both.maxFee, hedged.maxFee);
  // A 2.7% edge carries 1% of bankroll per seat twice, not three times.
  assert.throws(() => assessRound({ bankroll, bets: [red, red, red] }), /Kelly limit/);
  assert.ok(assessRound({ bankroll, bets: [red, red, red, black, black, black] }).totalFee > 0n);
  // Fees follow stakes, each an even number of wei, never more than the safe total.
  const uneven = assessRound({ bankroll, bets: [red, seat(pocket * 18n, pocket * 36n, 3n * 10n ** 15n)] });
  assert.ok(uneven.fees.every(fee => fee % 2n === 0n) && uneven.totalFee <= uneven.maxFee);
  assert.ok(uneven.fees[0] > uneven.fees[1]);
  assert.throws(() => assessRound({ bankroll, bets: [] }), /1 to 256/);
  assert.throws(() => assessRound({ bankroll, bets: Array(MAX_ROUND_BETS + 1).fill(red) }), /1 to 256/);
  assert.throws(() => assessRound({ bankroll, bets: [{ stake: 1n, prizes: [] }] }), /1 to 64 prizes/);
  assert.throws(
    () => assessRound({ bankroll, bets: [{ stake: 1n, prizes: Array(MAX_PRIZES + 1).fill(red.prizes[0]) }] }),
    /1 to 64 prizes/,
  );
  assert.throws(() => assessRound({ bankroll, bets: [seat(5n, 5n)] }), /within \[0, 2\^64\)/);
  assert.throws(() => assessRound({ bankroll, bets: [seat(0n, OUTCOME_SPACE + 1n)] }), /within \[0, 2\^64\)/);
  assert.throws(() => assessRound({ bankroll, bets: [seat(0n, 1n, bankroll)] }), /less than the available bankroll/);
  // A bet that cannot lose is not a bet the bankroll takes; covering the wheel at the house's odds is.
  assert.throws(() => assessRound({ bankroll, bets: [seat(0n, OUTCOME_SPACE)] }), /Kelly limit/);
  const everything = {
    stake: 37n * 10n ** 15n,
    prizes: [{ rangeStart: 0n, rangeEnd: OUTCOME_SPACE, payout: 36n * 10n ** 15n }],
  };
  assert.equal(
    assessRound({ bankroll, bets: [everything] }).liability,
    assessRound({ bankroll, bets: [everything] }).totalFee,
  );
  t.diagnostic(
    JSON.stringify(
      { one: one.totalFee, stackedTwo: two.totalFee, hedged: hedged.totalFee, hedgedLiability: hedged.liability },
      (_, v) => String(v),
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
  const risk = assessRound({ bankroll: 10n ** 20n, bets: [plinko] });
  assert.equal(risk.liability - risk.totalFee, stake * 25n, 'the bankroll can lose the top bucket less the stake');
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
  const a = assessRound({ bankroll: 10n ** 20n, bets: [chips] }),
    b = assessRound({ bankroll: 10n ** 20n, bets: [flat] });
  assert.deepEqual([a.maxFee, a.liability], [b.maxFee, b.liability]);
  assert.deepEqual(describeBet(chips), describeBet(flat));
  // A table of 32 such players shares the wheel's 37 pockets, so the round stays small however many sit down.
  const started = performance.now(),
    full = assessRound({
      bankroll: 10n ** 22n,
      bets: Array.from({ length: MAX_ROUND_BETS }, (_, i) => ({
        ...chips,
        prizes: [...chips.prizes.slice(0, 19), at(1 + (i % 36), 36n * stake)],
      })),
    }),
    elapsed = performance.now() - started;
  assert.ok(full.totalFee > 0n && elapsed < 2000);
  // Too many distinct outcomes for one round is declined rather than priced slowly.
  const wide = (offset: bigint) => ({
    stake: 10n ** 18n,
    prizes: Array.from({ length: MAX_PRIZES }, (_, i) => ({
      rangeStart: (BigInt(i) * 2n + offset) * (Q / 400n),
      rangeEnd: (BigInt(i) * 2n + offset + 1n) * (Q / 400n),
      payout: BigInt(i + 1) * 10n ** 15n + offset,
    })),
  });
  assert.throws(
    () => assessRound({ bankroll: 10n ** 24n, bets: [wide(0n), wide(1n), wide(200n)] }),
    new RegExp(`at most ${MAX_ROUND_CELLS}`),
  );
  t.diagnostic(
    JSON.stringify({
      plinkoRtp: Number(expected) / 2560,
      rouletteSeats: 32,
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
      assert.throws(() => assessBet({ bankroll: b, stake: s, netWin: w, winThreshold: p }));
      rejected++;
    } else {
      assert.equal(assessBet({ bankroll: b, stake: s, netWin: w, winThreshold: p }).totalFee, expected);
      accepted++;
    }
  }
  t.diagnostic(`Independent quadratic-root oracle: ${accepted} accepted and ${rejected} rejected cases agree.`);
});
