import fs from 'node:fs';
import { id, ZeroHash } from 'ethers';
import type { Checkpoint, Details, Operation } from '../protocol/types.ts';
import {
  domain,
  channelId,
  testOpening,
  initialState,
  hashState,
  operation,
  hashOperation,
  deriveState,
  rejectionCheckpoint,
  hashClose,
  canonicalJSON,
  memo,
  gameKey,
  outcome,
  roundId,
  seedHash,
  KIND,
  PROTOCOL,
  DEVELOPER_PROTOCOL,
} from '../protocol/protocol.ts';
import { fileURLToPath } from 'node:url';
import { assessBet, OUTCOME_SPACE } from '../protocol/risk.ts';

export function buildVectors() {
  const identity = {
    chainId: 31337n,
    casino: '0x1111111111111111111111111111111111111111',
    player: '0x2222222222222222222222222222222222222222',
    signer: '0x3333333333333333333333333333333333333333',
    developer: '0x4444444444444444444444444444444444444444',
  };
  const Q = OUTCOME_SPACE,
    priced = (
      bankroll: bigint,
      bet: { stake: bigint; prizes: { rangeStart: bigint; rangeEnd: bigint; payout: bigint }[] },
    ) => {
      const { maxFee, fee, liability } = assessBet({ bankroll, bet });
      return { bankroll, bet, risk: { maxFee, fee, liability } };
    };
  // One stake with one prize below a threshold, at a stated edge: the binary casino bet.
  const below = (stake: bigint, payout: bigint, edgeBps: bigint) => ({
    stake,
    prizes: [{ rangeStart: 0n, rangeEnd: (Q * stake * (10_000n - edgeBps)) / (10_000n * payout), payout }],
  });
  const cases = [
    below(100_000_000n, 200_000_000n, 100n),
    below(100_000_000n, 200_000_000n, 200n),
    below(1_000_000_000n, 1_100_000_000n, 200n),
    below(100_000_000n, 9_100_000_000n, 9000n),
  ].map(bet => priced(10_000_000_000n, bet));
  const d = domain(identity.chainId, identity.casino);
  // Roulette as one casino bet each: a lone red, and one player whose overlapping chips (red, a dozen, a number)
  // pay together.
  const pocket = Q / 37n,
    chip = (from: number, to: number, payout: bigint) => ({
      rangeStart: pocket * BigInt(from),
      rangeEnd: pocket * BigInt(to),
      payout,
    }),
    red = { stake: 100_000_000n, prizes: [chip(0, 18, 200_000_000n)] },
    chips = {
      stake: 160_000_000n,
      prizes: [chip(0, 18, 200_000_000n), chip(6, 18, 150_000_000n), chip(17, 18, 360_000_000n)],
    };
  const tables = [red, chips].map(bet => priced(10_000_000_000n, bet));
  // The player's ETH channel, and its test channel with the same channel key.
  const deposit = 1_000_000_000n,
    channels = {
      eth: {
        channelId: channelId(identity.player, identity.signer, deposit),
        player: identity.player,
        signer: identity.signer,
        deposit: String(deposit),
      },
      test: testOpening(identity.player, identity.signer),
    },
    genesis = initialState(channels.eth);
  // An operation on the checkpoint before it: its details, whose canonical JSON its memo hashes, the operation and its
  // hash, and the checkpoint it leads to with the seed and secret it settles with, zero but for a casino bet.
  const apply = (
    base: Checkpoint,
    values: Partial<Operation>,
    details: Details,
    seed = ZeroHash,
    secret = ZeroHash,
  ) => {
    const signed = operation(d, base, { ...values, memo: memo(details) }),
      next = deriveState(d, base, signed, secret, seed);
    return {
      details,
      canonical: canonicalJSON(details),
      operation: signed,
      hash: hashOperation(d, signed),
      seed,
      secret,
      next,
      nextHash: hashState(d, next),
    };
  };
  const game = gameKey({ developer: identity.developer, name: 'roulette' });
  // A casino bet of the three chips. The round's secret is the first of these whose outcome, with the bettor's seed,
  // lands in pocket 17, where all three chips pay.
  const seed = `0x${'72'.repeat(32)}`;
  let n = 0,
    secret: string;
  do secret = id(`HOOKEDIN/VECTOR/SECRET/${++n}`);
  while (outcome(chips.prizes, seed, secret).value / pocket !== 17n);
  const bet = apply(
    genesis,
    {
      kind: KIND.casinoBet,
      amount: chips.stake,
      prizes: chips.prizes,
      round: roundId(secret),
      seedHash: seedHash(seed),
    },
    { id: `0x${'82'.repeat(32)}`, game },
    seed,
    secret,
  );
  // A developer bet of the same game: a debit whose meta is a layout of chips.
  const developerBet = apply(
    bet.next,
    { kind: KIND.debit, amount: 60_000_000n },
    {
      id: `0x${'83'.repeat(32)}`,
      game,
      group: 'spin-1',
      meta: { chips: { red: '30000000', '9': '10000000', '17': '20000000' } },
    },
  );
  // A credit collecting what the developer paid for that bet, which it names by its hash.
  const payout = apply(
    developerBet.next,
    { kind: KIND.credit, amount: 120_000_000n },
    { id: `0x${'84'.repeat(32)}`, counterparty: developerBet.hash },
  );
  const rejection = rejectionCheckpoint(d, genesis, bet.operation),
    close = { channelId: channels.eth.channelId, stateHash: payout.nextHash };
  return {
    warning: 'Public deterministic test seeds; never use these for a funded deployment.',
    identity,
    protocol: PROTOCOL,
    developerProtocol: DEVELOPER_PROTOCOL,
    channels,
    genesis,
    genesisHash: hashState(d, genesis),
    operations: [bet, developerBet, payout],
    outcome: outcome(chips.prizes, seed, secret),
    rejection,
    rejectionHash: hashState(d, rejection),
    close,
    closeHash: hashClose(d, close),
    cases,
    tables,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = new URL('../vectors/protocol.json', import.meta.url);
  const text = `${JSON.stringify(buildVectors(), (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`;
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text)
      throw new Error('The protocol vectors differ; run npm run vectors for an intentional update');
    console.log('Protocol vectors verified.');
  } else {
    fs.writeFileSync(file, text);
    console.log('Wrote vectors/protocol.json');
  }
}
