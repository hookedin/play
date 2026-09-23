import { Wallet, ZeroHash, hexlify, randomBytes } from 'ethers';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';
import { gameKey } from '../client/game-account.ts';
import {
  domain,
  initialState,
  channelId,
  STATE_TYPES,
  SETTLEMENT_TYPES,
  COMMIT_TYPES,
  deriveState,
  roundId,
  seedHash,
  gameKey as keyOf,
  hashOperation,
  outcome,
  plain,
  checkpointEvidence,
  rejectionCheckpoint,
  KIND,
} from '../protocol/protocol.ts';
import type { GameIdentity } from '../protocol/game-types.ts';
import type { PublicBet } from '../protocol/types.ts';

/** A real wallet wired to an in-memory casino stub, with a stub referee that draws and settles the game's
 * bets: what a game is tested against without the private casino. */
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
  // The referee's open round: named by the stub casino and committed to the referee's seed.
  let open: { id: string; secret: string; seed: string; seedHash: string; signature: string } | null = null;
  const openRound = async () => {
    if (open) return open;
    const secret = hexlify(randomBytes(32)),
      seed = hexlify(randomBytes(32)),
      id = roundId(secret),
      hash = seedHash(seed);
    return (open = {
      id,
      secret,
      seed,
      seedHash: hash,
      signature: await referee.signTypedData(d, COMMIT_TYPES, { round: id, seedHash: hash }),
    });
  };
  // Its bets that settle later, what each settled bet owes this player until the wallet collects it, and the
  // order bets settled in.
  const held = new Map<string, PublicBet & { developer: string; name: string }>(),
    owed = new Map<string, bigint>(),
    order = new Map<string, number>();
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
      if (path.startsWith('/api/rounds?')) {
        const { id, seedHash, signature } = await openRound();
        return { id, seedHash, signature };
      }
      const bet = /^\/api\/bets\/(0x[0-9a-f]{64})$/.exec(path);
      if (bet) return publicBet(bet[1]!);
      const list = new URL(path, 'https://casino.example');
      if (list.pathname.endsWith('/bets')) {
        const settled = list.searchParams.get('status') === 'settled',
          after = list.searchParams.get('after') ?? '';
        const limit = Number(list.searchParams.get('limit') ?? 50);
        const all = [...held.values()]
          .filter(bet =>
            settled
              ? bet.status === 'settled' && order.get(bet.bet)! > Number(after || '0')
              : bet.status === 'open' && bet.bet > after,
          )
          .sort((a, b) => (settled ? order.get(a.bet)! - order.get(b.bet)! : a.bet.localeCompare(b.bet)));
        const page = all.slice(0, limit);
        return plain({
          bets: page.map(bet => ({
            bet: bet.bet,
            game: { developer: bet.developer, name: bet.name },
            asset: bet.asset,
            status: bet.status,
            stake: bet.stake,
            deadline: bet.deadline,
            collected: settled && bet.payout !== '0' && !owed.has(bet.bet),
            ...(settled
              ? { payout: bet.payout, settledAt: bet.settledAt, ...(bet.refunded ? { refunded: true } : {}) }
              : {}),
          })),
          cursor: page.length
            ? String(settled ? order.get(page.at(-1)!.bet) : page.at(-1)!.bet)
            : after || (settled ? '0' : ''),
          more: all.length > limit,
        });
      }
      if (path.endsWith('/payouts'))
        return [...owed].map(([source, amount]) => ({ source, index: 0, amount: String(amount) }));
      if (!path.endsWith('/operations')) return {};
      const { request, details, signature, seed } = body as any;
      if (responses.has(request.memo)) return responses.get(request.memo);
      if (Number(request.kind) === KIND.debit && details.bet) return place(request, details, signature);
      if (Number(request.kind) === KIND.credit && owed.has(details.counterparty)) {
        if (owed.get(details.counterparty) !== BigInt(request.amount))
          throw new Error('No payout of this amount is due');
        owed.delete(details.counterparty);
      }
      return settle(request, details, signature, seed ?? ZeroHash);
    };
    /** The casino declines a bet with a signed checkpoint above it: the balance is unchanged. */
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
    const settle = async (request: any, details: any, signature: string, seed: string) => {
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
      });
      responses.set(request.memo, response);
      settlements++;
      return response;
    };
    /** A bet that settles later is final and completes at once, if its referee is the game's and, to be drawn,
     * it rides the referee's open round. */
    const place = async (request: any, details: any, signature: string) => {
      const later = details.bet;
      if (later.referee !== referee.address)
        return decline(request, details, "This is not the referee the game's developer published");
      const round = open;
      if (later.prizes && !(round && later.round === round.id && later.seedHash === round.seedHash))
        return decline(request, details, 'The round is not open');
      const hash = hashOperation(d, request).toLowerCase();
      held.set(hash, {
        bet: hash,
        game: keyOf(details.game),
        developer: details.game.developer,
        name: details.game.name,
        ...(details.group ? { group: details.group } : {}),
        asset: 'eth',
        uname,
        alias: null,
        stake: String(request.amount),
        placedAt: Date.now(),
        status: 'open',
        ...later,
      });
      return settle(request, details, signature, ZeroHash);
    };
    return wallet;
  };
  const publicBet = (hash: string) => {
    const { developer: _developer, name: _name, ...bet } = held.get(hash)!;
    return plain(bet);
  };
  /** A bet settles: what it paid waits, owed to this player, for the wallet to collect. */
  const end = (hash: string, payout: bigint, change: Partial<PublicBet> = {}) => {
    Object.assign(held.get(hash)!, { status: 'settled', payout: String(payout), settledAt: Date.now(), ...change });
    if (payout) owed.set(hash, payout);
    order.set(hash, order.size + 1);
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
    /** The referee draws its open round: every open bet on it is owed what its prizes pay on the one outcome,
     * or, if it is in `declined`, refunded beside the draw. The next round is then open. */
    async draw(declined: string[] = []) {
      const { id, seed, secret } = await openRound(),
        draw = { seed, secret };
      for (const bet of held.values())
        if (bet.status === 'open' && bet.round === id)
          if (declined.includes(bet.bet)) end(bet.bet, BigInt(bet.stake), { draw, refunded: true });
          else end(bet.bet, outcome(bet.prizes!, seed, secret).payout, { draw });
      open = null;
      return { round: id, seed, secret, outcome: outcome([], seed, secret).value };
    },
    /** The referee's open round, as a wallet reads it. */
    openRound: async () => {
      const { id, seedHash, signature } = await openRound();
      return { id, seedHash, signature };
    },
    /** The referee settles a bet with terms: `player` to the player and `casino` to the casino, signed. */
    async settle(hash: string, player: bigint, casino = 0n) {
      const message = { bet: hash, player: String(player), casino: String(casino) };
      end(hash, player, {
        settlement: { ...message, signature: await referee.signTypedData(d, SETTLEMENT_TYPES, message) },
      });
      return publicBet(hash);
    },
    /** A bet's deadline passes before anybody settles it: its stake comes back. */
    refund(hash: string) {
      end(hash, BigInt(held.get(hash)!.stake), { refunded: true });
      return publicBet(hash);
    },
    /** The game's bets that are open. */
    open: () => [...held.values()].filter(bet => bet.status === 'open').map(bet => publicBet(bet.bet)),
    /** A game as its developer published it, with the stub's referee. `declared` is anything its manifest
     * says otherwise. */
    identity: (name = 'test', declared: Partial<GameIdentity> = {}) => ({
      name,
      slug: name,
      manifestURL: `https://${name}.example/manifest.json`,
      entryURL: `https://${name}.example/`,
      developer: owner.address,
      referee: referee.address,
      ...declared,
    }),
    async reload() {
      const restored = make();
      restored.hydrate(await storage.get('game-wallet'));
      return restored;
    },
  };
}
