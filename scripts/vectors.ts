import fs from 'node:fs';
import { domain, operation, hashOperation, initialState, outcome } from '../protocol/protocol.ts';
import { fileURLToPath } from 'node:url';
import { assessRound, WORD_SPACE } from '../protocol/risk.ts';
import { generateHashChain, hashChainLink } from '../protocol/hash-chain.ts';

export function buildVectors() {
  const seed = `0x${'31'.repeat(32)}`,
    clientSeed = `0x${'72'.repeat(32)}`;
  const chain = generateHashChain(seed, 4);
  const identity = {
    chainId: 31337n,
    casino: '0x1111111111111111111111111111111111111111',
    player: '0x2222222222222222222222222222222222222222',
    chainKey: `0x${'53'.repeat(32)}`,
    epoch: 1n,
    index: 0n,
  };
  const Q = WORD_SPACE,
    priced = (
      bankroll: bigint,
      bets: { stake: bigint; prizes: { rangeStart: bigint; rangeEnd: bigint; payout: bigint }[] }[],
    ) => {
      const { maxFee, totalFee, fees, liability } = assessRound({ bankroll, bets });
      return { bankroll, bets, risk: { maxFee, totalFee, fees, liability } };
    };
  // One stake with one prize below a threshold, at a stated edge: the binary wager.
  const below = (stake: bigint, payout: bigint, edgeBps: bigint) => ({
    stake,
    prizes: [{ rangeStart: 0n, rangeEnd: (Q * stake * (10_000n - edgeBps)) / (10_000n * payout), payout }],
  });
  const cases = [
    below(100_000_000n, 200_000_000n, 100n),
    below(100_000_000n, 200_000_000n, 200n),
    below(1_000_000_000n, 1_100_000_000n, 200n),
    below(100_000_000n, 9_100_000_000n, 9000n),
  ].map(bet => priced(10_000_000_000n, [bet]));
  const d = domain(identity.chainId, identity.casino);
  // One outcome for the whole round: a lone red, two stacked reds, a red hedged by a black, and one
  // player whose overlapping chips (red, a dozen, a number) pay together.
  const pocket = Q / 37n,
    chip = (from: number, to: number, payout: bigint) => ({
      rangeStart: pocket * BigInt(from),
      rangeEnd: pocket * BigInt(to),
      payout,
    }),
    red = { stake: 100_000_000n, prizes: [chip(0, 18, 200_000_000n)] },
    black = { stake: 100_000_000n, prizes: [chip(18, 36, 200_000_000n)] },
    chips = {
      stake: 160_000_000n,
      prizes: [chip(0, 18, 200_000_000n), chip(6, 18, 150_000_000n), chip(17, 18, 360_000_000n)],
    };
  const rounds = [[red], [red, red], [red, black], [chips], [chips, black]].map(bets => priced(10_000_000_000n, bets));
  const state = initialState({ channelId: `0x${'53'.repeat(32)}`, deposit: '1000000000' });
  const request = operation(d, state, {
    kind: 1,
    amount: chips.stake,
    prizes: chips.prizes,
    seed: clientSeed,
    roundHead: hashChainLink(chain.preimages[0]),
    operationId: `0x${'82'.repeat(32)}`,
    developer: identity.player,
  });
  const requestHash = hashOperation(d, request);
  return {
    warning: 'Public deterministic test seeds; never use these for a funded deployment.',
    cases,
    rounds,
    chain,
    identity,
    state,
    request,
    requestHash,
    outcome: outcome(request, chain.preimages[0]),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = new URL('../vectors/bets.json', import.meta.url);
  const canonical = `${JSON.stringify(buildVectors(), (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`;
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== canonical)
      throw new Error('Atomic wager vectors differ; run npm run vectors for an intentional update');
    console.log('Round pricing, hash-chain and outcome vectors verified.');
  } else {
    fs.mkdirSync(new URL('../vectors/', import.meta.url), { recursive: true });
    fs.writeFileSync(file, canonical);
    console.log('Wrote vectors/bets.json');
  }
}
