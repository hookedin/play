import { Wallet, ZeroHash, hexlify, randomBytes } from 'ethers';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';
import { gameKey } from '../client/game-account.ts';
import {
  domain,
  initialState,
  channelId,
  STATE_TYPES,
  QUOTE_TYPES,
  RESOLUTION_TYPES,
  deriveState,
  roundId,
  seedHash,
  hashJSON,
  outcome,
  potPayouts,
  plain,
  checkpointEvidence,
  rejectionCheckpoint,
  KIND,
} from '../protocol/protocol.ts';
import type { GameIdentity } from '../protocol/game-types.ts';
import type { Bank, GameName, PotResult, PotStatus } from '../protocol/types.ts';

/** A real wallet wired to an in-memory casino stub, with a stub referee for the game's pots: what a game
 * is tested against without the private casino. */
export async function gameWallet(storage = new MemoryStore()) {
  const owner = Wallet.createRandom(),
    player = Wallet.createRandom(),
    key = Wallet.createRandom(),
    referee = Wallet.createRandom();
  const casino = Wallet.createRandom().address,
    d = domain(31337, casino);
  const message = {
    channelId: channelId(player.address, key.address, 1000000n),
    player: player.address,
    signer: key.address,
    deposit: '1000000',
  };
  const opening = message;
  const state = initialState(message);
  const playerSignature = await key.signTypedData(d, STATE_TYPES, state),
    casinoSignature = await owner.signTypedData(d, STATE_TYPES, state);
  const bankroll = '1000000000000';
  const responses = new Map();
  let settlements = 0;
  // The stub casino's rounds: each is the hash of its secret, settled with the channel's next bet.
  const secrets = new Map<string, string>();
  let own = '';
  const createRound = () => {
    const secret = hexlify(randomBytes(32)),
      round = roundId(secret);
    secrets.set(round, secret);
    return round;
  };
  // Its pots, and what each ended pot owes this player, until the wallet collects it.
  const pots = new Map<string, PotStatus & { seeds?: string }>(),
    owed = new Map<string, bigint>(),
    games = new Map<string, GameName>(),
    resolutions = new Map<string, { sequence: number; payout: string }>();
  // A casino derives a player's uname from their address with a key of its own; a stub only has to
  // give each wallet one of the right shape, so a game keys its storage by a real name.
  const uname = hexlify(randomBytes(12)).slice(2).replaceAll('0', 'z').replaceAll('1', 'y');
  const make = () => {
    const wallet = new CasinoWallet({ network: 'local', storage });
    Object.assign(wallet, {
      storageKey: 'game-wallet',
      address: player.address,
      uname,
      alias: null,
      signer: player,
      mode: 'demo',
      operator: owner.address,
      domain: d,
      config: { contractAddress: casino },
      verifiedChainId: 31337n,
      reportedBankroll: bankroll,
      currentId: message.channelId,
      channels: {
        [message.channelId]: {
          key: key.privateKey,
          opening,
          state: structuredClone(state),
          playerSignature,
          casinoSignature,
          onchain: { status: '1' },
        },
      },
    });
    wallet.ready = () => {
      wallet.requireDurableState();
      if (!wallet.current) throw new Error('No channel');
    };
    wallet.api = async (path, body) => {
      if (path === '/api/metrics') return { bankroll };
      if (path.endsWith('/round')) return { id: (own ||= createRound()) };
      const pot = /^\/api\/pots\/(0x[0-9a-f]{64})$/.exec(path);
      if (pot) return publicPot(pot[1]!);
      const list = new URL(path, 'https://casino.example');
      if (list.pathname.endsWith('/pots')) {
        const resolved = list.searchParams.get('status') === 'resolved',
          after = list.searchParams.get('after') ?? '';
        const limit = Number(list.searchParams.get('limit') ?? 50);
        const cursor = (pot: PotStatus) => (resolved ? resolutions.get(pot.id)!.sequence : pot.id);
        const all = [...pots.values()]
          .filter(
            pot =>
              pot.entries.length &&
              pot.status === (resolved ? 'resolved' : 'unresolved') &&
              (resolved ? Number(cursor(pot)) > Number(after) : String(cursor(pot)) > after),
          )
          .sort((a, b) => (resolved ? Number(cursor(a)) - Number(cursor(b)) : a.id.localeCompare(b.id)));
        const page = all.slice(0, limit);
        return plain({
          pots: page.map(pot => ({
            id: pot.id,
            game: games.get(pot.id),
            asset: pot.asset,
            status: pot.status,
            closesAt: pot.closesAt,
            deadline: pot.deadline,
            stake: String(pot.entries.reduce((sum, entry) => sum + BigInt(entry.stake), 0n)),
            collected: resolved && resolutions.get(pot.id)!.payout !== '0' && !owed.has(pot.id),
            ...(resolved
              ? {
                  payout: resolutions.get(pot.id)!.payout,
                  resolution: pot.resolution,
                  refundReason: pot.refundReason,
                  resolvedAt: pot.resolvedAt,
                }
              : {}),
          })),
          cursor: page.length ? String(cursor(page.at(-1)!)) : after || (resolved ? '0' : ''),
          more: all.length > limit,
        });
      }
      if (path.endsWith('/payouts'))
        return [...owed].map(([source, amount]) => ({ source, index: 0, amount: String(amount) }));
      if (!path.endsWith('/operations')) return {};
      const { request, details, signature, seed } = body as any;
      if (responses.has(request.memo)) return responses.get(request.memo);
      if (Number(request.kind) === KIND.debit && details.counterparty && pots.has(details.counterparty))
        return enter(request, details, signature);
      if (Number(request.kind) === KIND.credit && owed.has(details.counterparty)) {
        if (owed.get(details.counterparty) !== BigInt(request.amount))
          throw new Error('No payout of this amount is due');
        owed.delete(details.counterparty);
      }
      return settle(request, details, signature, seed ?? ZeroHash);
    };
    /** The casino declines an entry with a signed checkpoint above it: the balance is unchanged. */
    const decline = async (request: any, details: any, reason: string) => {
      const base = wallet.current!,
        state = rejectionCheckpoint(d, base.state, request);
      const response = plain({
        status: 'rejected',
        reason,
        request,
        details,
        operationId: details.id,
        state,
        casinoSignature: await owner.signTypedData(d, STATE_TYPES, state),
        commission: '0',
        evidence: checkpointEvidence(base.state, base.playerSignature, base.casinoSignature),
        bankroll,
      });
      responses.set(request.memo, response);
      return response;
    };
    const settle = async (request: any, details: any, signature: string, seed: string, extra = {}) => {
      const base = wallet.current!,
        secret = Number(request.kind) === KIND.bet ? secrets.get(request.round)! : ZeroHash;
      const next = deriveState(d, base.state, request, secret, seed);
      const signed = await owner.signTypedData(d, STATE_TYPES, next);
      const response = plain({
        status: 'signed',
        state: next,
        casinoSignature: signed,
        details,
        operationId: details.id,
        commission: '0',
        evidence: {
          ...checkpointEvidence(base.state, base.playerSignature, base.casinoSignature),
          step: { operation: request, authorization: signature, seed, secret, casinoSignature: signed },
        },
        bankroll,
        ...(request.round === own ? { nextRound: (own = createRound()) } : {}),
        ...extra,
      });
      responses.set(request.memo, response);
      settlements++;
      return response;
    };
    /** An entry is final and completes at once, if the pot is open and, for a developer's pot, at its
     * referee's quote. */
    const enter = async (request: any, details: any, signature: string) => {
      const pot = pots.get(details.counterparty)!,
        prizes = details.entry?.prizes,
        quote = details.entry?.quote;
      if (pot.status !== 'unresolved') return decline(request, details, 'The pot takes no more entries');
      if (pot.bank === 'developer') {
        const quoted = await new Wallet(referee.privateKey).signTypedData(d, QUOTE_TYPES, {
          pot: pot.id,
          stake: String(request.amount),
          prizes: hashJSON(prizes),
          expiresAt: quote?.expiresAt ?? '0',
        });
        if (quoted !== quote?.signature || Number(quote.expiresAt) < Date.now() / 1000)
          return decline(request, details, "The entry is not at the referee's quote");
      }
      pot.entries.push({ uname, alias: null, stake: String(request.amount), ...(prizes ? { prizes } : {}) });
      return settle(request, details, signature, ZeroHash, { entry: pot.entries.length - 1 });
    };
    return wallet;
  };
  const publicPot = (id: string) => {
    const { seeds: _seeds, ...pot } = pots.get(id)!;
    return plain(pot);
  };
  /** A pot ends: what each entry is owed, summed for this one player, waits for the wallet to collect it. */
  const end = (pot: PotStatus, payouts: bigint[]) => {
    const total = payouts.reduce((sum, payout) => sum + payout, 0n);
    if (total) owed.set(pot.id, total);
    resolutions.set(pot.id, { sequence: resolutions.size + 1, payout: String(total) });
  };
  const wallet = make();
  await wallet.save();
  return {
    wallet,
    storage,
    owner,
    player,
    referee,
    settlements: () => settlements,
    /** A round's secret, which only the casino knows until it reveals the round. */
    secretOf: (round: string) => secrets.get(round)!,
    /** What a game's referee does at the casino: open a pot of `game`. A house pot is a round whose seed
     * the referee keeps. */
    openPot(game: GameIdentity, bank: Bank, { outcomes = 3, rake = 0 } = {}) {
      const secret = hexlify(randomBytes(32)),
        seed = hexlify(randomBytes(32)),
        id = bank === 'house' ? roundId(secret) : hexlify(randomBytes(32));
      if (bank === 'house') secrets.set(id, secret);
      const pot: PotStatus = {
        id,
        game: gameKey(game),
        referee: referee.address.toLowerCase(),
        bank,
        asset: 'eth',
        status: 'unresolved',
        ...(bank === 'house' ? { seedHash: seedHash(seed) } : bank === 'developer' ? { outcomes } : { rake }),
        closesAt: null,
        deadline: Date.now() + 600_000,
        entries: [],
      };
      pots.set(id, { ...pot, seeds: seed });
      games.set(id, { developer: game.developer, name: game.slug ?? game.manifestURL });
      return plain(pot);
    },
    /** The referee's price for an entry into a developer's pot. */
    async quote(pot: string, stake: string, prizes: any[], expiresAt = Math.floor(Date.now() / 1000) + 60) {
      const message = { pot, stake, prizes: hashJSON(prizes), expiresAt: String(expiresAt) };
      return { expiresAt: message.expiresAt, signature: await referee.signTypedData(d, QUOTE_TYPES, message) };
    },
    /** The referee ends a pot: a house pot with its seed, a developer's or players' pot with a result it signs. */
    async resolvePot(id: string, result?: PotResult) {
      const pot = pots.get(id)!;
      if (pot.bank === 'house') {
        const secret = secrets.get(id)!;
        Object.assign(pot, {
          status: 'resolved',
          resolution: 'outcome',
          resolvedAt: Date.now(),
          seed: pot.seeds,
          secret,
        });
        end(pot, potPayouts(pot, { value: outcome([], pot.seeds!, secret).value }));
      } else {
        const signature = await referee.signTypedData(d, RESOLUTION_TYPES, { pot: id, result: hashJSON(result) });
        Object.assign(pot, { status: 'resolved', resolution: 'outcome', resolvedAt: Date.now(), result, signature });
        end(pot, potPayouts(pot, result!));
      }
      return publicPot(id);
    },
    /** The referee calls a pot off, or its deadline passes: every entry is refunded. */
    voidPot(id: string) {
      const pot = pots.get(id)!;
      Object.assign(pot, {
        status: 'resolved',
        resolution: 'refund',
        refundReason: 'cancelled',
        resolvedAt: Date.now(),
      });
      end(pot, potPayouts(pot, { refund: true }));
      return publicPot(id);
    },
    /** A game as its developer published it. `declared` is anything its manifest says otherwise. */
    identity: (name = 'test', declared: Partial<GameIdentity> = {}) => ({
      name,
      slug: name,
      manifestURL: `https://${name}.example/manifest.json`,
      entryURL: `https://${name}.example/`,
      developer: owner.address,
      ...declared,
    }),
    async reload() {
      const restored = make();
      restored.hydrate(await storage.get('game-wallet'));
      return restored;
    },
  };
}
