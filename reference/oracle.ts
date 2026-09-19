/**
 * A reference match oracle: the host of a two-player rock paper scissors game. It pairs players,
 * carries their signed stakes to the casino, referees the moves and signs the outcome. It never
 * holds money: the casino escrows the pot, and this key can only say which seat the match pays.
 *
 * The pot is not simply the two stakes. The stakes are one bet, settled by the casino the moment
 * the match opens, against the next round of a hash chain this host owns and both players' seeds;
 * what it pays is the pot. Most matches play for a little under the stakes, a few for many times them, and
 * everyone knows which before the first move.
 *
 * Moves are committed before they are revealed, so neither player, and no leak from this host, can
 * answer a move already seen. The transcript (commitments, reveals and the signed resolution) is
 * served with the result, so a wrong decision is provable.
 */
import type { Server } from 'node:http';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Wallet, getAddress, keccak256, concat, toBeHex } from 'ethers';
import {
  authorization,
  domain,
  matchId,
  matchPot,
  CHAIN_ACCESS_TYPES,
  RESOLUTION_TYPES,
  SHARE_SCALE,
} from '../protocol/protocol.ts';
import { WORD_SPACE } from '../protocol/risk.ts';
import type { MatchTerms } from '../protocol/types.ts';

export const MOVES = ['rock', 'paper', 'scissors'] as const;
type Move = (typeof MOVES)[number];
/** Outcome 0: seat 0 wins. 1: seat 1 wins. 2: a draw halves the pot. 3, one past the last, voids the match. */
export const decide = (a: Move, b: Move) => (a === b ? 2 : (MOVES.indexOf(a) + 3 - MOVES.indexOf(b)) % 3 === 1 ? 0 : 1);
export const commitment = (move: string, salt: string) => createHash('sha256').update(`${move}:${salt}`).digest('hex');

/** What the winner's stake is multiplied by, and how often, in millionths. It returns 96.5% of the
 * stakes on average; the rest is the casino's edge and, through it, this game's commission. */
export const MULTIPLIERS: [multiplier: number, chance: number][] = [
  [1.3, 550_000],
  [2, 300_000],
  [3, 100_000],
  [5, 40_000],
  [10, 9_000],
  [25, 1_000],
];
/** One prize per multiplier, laid end to end over the 64-bit outcome. */
export function potPrizes(stake: bigint, multipliers = MULTIPLIERS) {
  let edge = 0n,
    chance = 0;
  return multipliers.map(([multiplier, share]) => {
    const rangeStart = edge;
    edge = (WORD_SPACE * BigInt((chance += share))) / 1_000_000n;
    return {
      rangeStart: String(rangeStart),
      rangeEnd: String(edge),
      payout: String((stake * BigInt(Math.round(multiplier * 100))) / 100n),
    };
  });
}

interface Table {
  key: string;
  stake: bigint;
  tokens: string[];
  channels: string[];
  /** The chain whose next round settles this table's pot, held from pairing until the match opens. */
  lane?: Wallet;
  pot?: string;
  phase: 'waiting' | 'staking' | 'commit' | 'reveal' | 'resolved' | 'failed';
  deadline: number;
  terms?: MatchTerms;
  matchId?: string;
  entries: any[];
  commitments: (string | null)[];
  reveals: ({ move: Move; salt: string } | null)[];
  outcome?: number;
  resolution?: string;
  error?: string;
}

export async function createOracleService({
  casinoURL,
  key,
  developer,
  rakeBps = 200,
  multipliers = MULTIPLIERS,
  matchSeconds = 3600,
  stepSeconds = 60,
  now = () => Date.now(),
}: {
  casinoURL: string;
  key: string;
  developer: string;
  /** The share of the pot a decided match keeps, split between the developer and the casino. It
   * applies to a match of plain stakes; a pot that was a bet has already paid the house its edge. */
  rakeBps?: number;
  /** The pot bet. With none the pot is the two stakes. */
  multipliers?: [number, number][];
  matchSeconds?: number;
  /** How long a player has for each step before the other is awarded the match. */
  stepSeconds?: number;
  now?: () => number;
}) {
  const signer = new Wallet(key),
    config = await (await fetch(casinoURL + '/api/config')).json(),
    d = domain(config.chainId, config.contractAddress),
    tables = new Map<string, Table>();
  // A chain settles one round at a time, and a table holds its round from pairing until both players
  // have signed. Each table therefore takes a lane: a chain of its own under a key derived from this
  // host's, returned when the match opens or fails, so tables never wait on each other.
  const lanes: Wallet[] = [];
  const lane = () => {
    const busy = new Set([...tables.values()].filter(t => t.phase === 'staking').map(t => t.lane));
    const free = lanes.find(wallet => !busy.has(wallet));
    if (free) return free;
    lanes.push(new Wallet(keccak256(concat([key, toBeHex(lanes.length, 32)]))));
    return lanes.at(-1)!;
  };
  const casino = async (path: string, body: unknown, owner?: Wallet) => {
    const access = owner && { owner: owner.address, expiresAt: Math.floor(Date.now() / 1000) + 60 };
    const response = await fetch(casinoURL + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(access
          ? { authorization: authorization(access, await owner.signTypedData(d, CHAIN_ACCESS_TYPES, access)) }
          : {}),
      },
      body: JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? String(v) : v)),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Casino unavailable');
    return value;
  };
  const resolve = async (table: Table, outcome: number) => {
    table.resolution = await signer.signTypedData(d, RESOLUTION_TYPES, { matchId: table.matchId!, outcome });
    try {
      await casino(`/api/matches/${table.matchId}/resolution`, {
        outcome: String(outcome),
        signature: table.resolution,
      });
      table.outcome = outcome;
      table.phase = 'resolved';
    } catch (error: any) {
      // The signed resolution is kept: it can be delivered again, by anyone.
      table.error = error.message;
    }
  };
  /** A player who lets a step's clock run out forfeits to one who did not; if both did, nobody wins. */
  const expire = async (table: Table) => {
    if (now() < table.deadline || !['staking', 'commit', 'reveal'].includes(table.phase)) return;
    if (table.phase === 'staking') {
      table.phase = 'failed';
      table.error = 'Your opponent never staked. Withdraw your stake and try again.';
      return;
    }
    const done = (table.phase === 'commit' ? table.commitments : table.reveals).map(Boolean);
    table.deadline = Infinity;
    await resolve(table, done[0] === done[1] ? 3 : done[0] ? 0 : 1);
  };
  const view = (table: Table, seat: number) => ({
    key: table.key,
    seat,
    phase: table.phase,
    stake: String(table.stake),
    deadline: Number.isFinite(table.deadline) ? table.deadline : null,
    terms: table.terms ?? null,
    matchId: table.matchId ?? null,
    // What this match plays for, known from the moment it opens.
    pot: table.pot ?? null,
    staked: table.entries.map(Boolean),
    committed: table.commitments.map(Boolean),
    revealed: table.reveals.map(Boolean),
    // The transcript: commitments once both are in, moves and the signed resolution once decided.
    commitments: table.commitments.every(Boolean) ? table.commitments : null,
    reveals: table.phase === 'resolved' ? table.reveals : null,
    outcome: table.outcome ?? null,
    resolution: table.phase === 'resolved' ? table.resolution : null,
    error: table.error ?? null,
  });
  const actions: Record<string, (table: Table, seat: number, input: any) => Promise<void> | void> = {
    async stake(table, seat, { entry }) {
      if (table.phase !== 'staking' || !table.terms) throw new Error('This match is not taking stakes');
      table.entries[seat] = entry;
      if (!table.entries.every(Boolean)) return;
      try {
        // A pot bet is a round, opened by its chain's owner; a match of plain stakes anyone may open.
        const opened = await casino(
          table.lane ? `/api/chains/${table.lane.address}/matches` : '/api/matches',
          { terms: table.terms, seats: table.entries },
          table.lane,
        );
        if (opened.status === 'rejected') throw new Error(opened.responses[0].reason + '.');
        // The host checks the casino too: the pot is recomputed from the signed terms and both seeds.
        table.pot = matchPot(table.terms!, opened.seeds, opened.preimage).pot;
        table.phase = 'commit';
        table.deadline = now() + stepSeconds * 1000;
      } catch (error: any) {
        table.phase = 'failed';
        table.error = `The casino did not open the match: ${error.message} Withdraw your stake and try again.`;
      }
    },
    commit(table, seat, { commitment: value }) {
      if (table.phase !== 'commit' || table.commitments[seat]) throw new Error('Not waiting for your move');
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid commitment');
      table.commitments[seat] = value;
      if (table.commitments.every(Boolean)) {
        table.phase = 'reveal';
        table.deadline = now() + stepSeconds * 1000;
      }
    },
    async reveal(table, seat, { move, salt }) {
      if (table.phase !== 'reveal' || table.reveals[seat]) throw new Error('Not waiting for your reveal');
      if (!MOVES.includes(move) || typeof salt !== 'string' || commitment(move, salt) !== table.commitments[seat])
        throw new Error('Reveal does not open your commitment');
      table.reveals[seat] = { move, salt };
      if (table.reveals.every(Boolean)) {
        table.deadline = Infinity;
        await resolve(table, decide(table.reveals[0]!.move, table.reveals[1]!.move));
      }
    },
  };
  async function join(channelId: string, stake: bigint) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(channelId) || stake <= 0n) throw new Error('Invalid seat');
    channelId = channelId.toLowerCase();
    const token = randomBytes(16).toString('hex');
    const waiting = [...tables.values()].find(
      t => t.phase === 'waiting' && t.stake === stake && t.channels[0] !== channelId,
    );
    if (!waiting) {
      const key = randomBytes(8).toString('hex'),
        table: Table = {
          key,
          stake,
          tokens: [token],
          channels: [channelId],
          phase: 'waiting',
          deadline: Infinity,
          entries: [null, null],
          commitments: [null, null],
          reveals: [null, null],
        };
      tables.set(key, table);
      return { key, seat: 0, token };
    }
    // Claim the table before anything is awaited, so a third player starts a table of their own.
    waiting.phase = 'staking';
    waiting.deadline = now() + stepSeconds * 1000;
    waiting.tokens.push(token);
    waiting.channels.push(channelId);
    const prizes = potPrizes(stake, multipliers),
      zero = '0x' + '0'.repeat(64);
    let roundHead = zero;
    if (prizes.length)
      try {
        waiting.lane = lane();
        ({ roundHead } = await casino(`/api/chains/${waiting.lane.address}/round`, {}, waiting.lane));
      } catch (error: any) {
        waiting.phase = 'failed';
        waiting.error = `The casino offered no round for this match: ${error.message}`;
        return { key: waiting.key, seat: 1, token };
      }
    const win = String(prizes.length ? SHARE_SCALE : SHARE_SCALE - (SHARE_SCALE * BigInt(rakeBps)) / 10000n),
      half = String(SHARE_SCALE / 2n);
    waiting.terms = {
      oracle: signer.address,
      developer: getAddress(developer),
      expiresAt: String(Math.floor(now() / 1000) + matchSeconds),
      nonce: '0x' + randomBytes(32).toString('hex'),
      roundHead,
      prizes,
      seats: [
        { channelId: waiting.channels[0], stake: String(stake), shares: [win, '0', half] },
        { channelId, stake: String(stake), shares: ['0', win, half] },
      ],
    };
    waiting.matchId = matchId(d, waiting.terms);
    return { key: waiting.key, seat: 1, token };
  }
  const server: Server = http.createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method === 'OPTIONS') return send(204, null);
      const url = new URL(req.url!, 'http://localhost');
      let input: any = {};
      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          if ((size += chunk.length) > 65536) return send(413, { error: 'Request too large' });
          chunks.push(chunk);
        }
        input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      }
      if (url.pathname === '/info' && req.method === 'GET')
        return send(200, {
          oracle: signer.address,
          developer: getAddress(developer),
          rakeBps,
          multipliers,
          stepSeconds,
        });
      if (url.pathname === '/join' && req.method === 'POST')
        return send(200, await join(String(input.channelId), BigInt(input.stake)));
      const route = /^\/match\/([0-9a-f]{16})(?:\/(stake|commit|reveal|leave))?$/.exec(url.pathname);
      const table = route && tables.get(route[1]);
      if (!route || !table) return send(404, { error: 'Unknown match' });
      const seat = table.tokens.indexOf(String(input.token ?? url.searchParams.get('token')));
      if (seat < 0) return send(403, { error: 'Not a seat of this match' });
      await expire(table);
      if (req.method === 'POST' && route[2] === 'leave') {
        // Only a table nobody has joined can be left; afterwards a stake is withdrawn in the wallet.
        if (table.phase === 'waiting') tables.delete(table.key);
      } else if (req.method === 'POST' && route[2]) await actions[route[2]](table, seat, input);
      return send(200, view(table, seat));
    } catch (error: any) {
      send(400, { error: error.message || 'Invalid request' });
    }
  });
  // A player who walks away must not be able to stall the other: the clock runs without requests.
  const timer = setInterval(() => {
    for (const table of tables.values()) void expire(table).catch(() => {});
  }, 1000);
  server.on('close', () => clearInterval(timer));
  return { server, oracle: signer.address, tables, expire: () => Promise.all([...tables.values()].map(expire)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.HOOKEDIN_ORACLE_PORT ?? 4186),
    casinoURL = process.env.HOOKEDIN_CASINO_URL ?? 'http://127.0.0.1:4183',
    key = process.env.HOOKEDIN_ORACLE_KEY ?? Wallet.createRandom().privateKey,
    developer = process.env.HOOKEDIN_DEVELOPER;
  if (!developer) throw new Error("Set HOOKEDIN_DEVELOPER to the address that earns the game's commission");
  const service = await createOracleService({ casinoURL, key, developer });
  service.server.listen(port, '127.0.0.1', () =>
    console.log(`Match oracle ${service.oracle} listening on http://127.0.0.1:${port}`),
  );
}
