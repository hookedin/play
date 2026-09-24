import { Wallet, ZeroHash, hexlify, randomBytes } from 'ethers';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';
import { validateRequest } from '../client/bridge.ts';
import { gameReceipt } from '../client/wallet-games.ts';
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
  gameKey,
  hashOperation,
  outcome,
  plain,
  same,
  betTerms,
  checkpointEvidence,
  rejectionCheckpoint,
  KIND,
  LIMITS,
  MAX_DEADLINE_MS,
  MAX_PAYOUTS,
  ROUND_MS,
} from '../protocol/protocol.ts';
import { assessRound } from '../protocol/risk.ts';
import type { GameIdentity, GameLimit, GameReceipt } from '../protocol/game-types.ts';
import type { PublicBet, Round } from '../protocol/types.ts';
import type { Referee } from '../sdk/src/referee.ts';

/** A game's side of the bridge, as `RoundClient` and a game's own client take it: every request goes through the
 * checks the wallet's bridge makes, and the player agrees to every request for funds. */
export interface TestBridge {
  call(method: string, params?: any): Promise<any>;
  balance(): Promise<GameLimit>;
  /** Called with every receipt the wallet pushes: a placed bet that settled, or came back, once collected. */
  onReceipt(listener: (receipt: GameReceipt) => void): () => void;
}

/** A game's side of the bridge to any wallet: requests go through the checks the wallet's bridge makes, the player
 * agrees to every request for funds, and every receipt the wallet pushes reaches the listeners. */
const pushes = new WeakMap<CasinoWallet, Set<(receipt: GameReceipt) => void>>();
export function bridgeTo(wallet: CasinoWallet): TestBridge {
  let listeners = pushes.get(wallet),
    sent = 0;
  if (!listeners) {
    const heard = (listeners = new Set());
    pushes.set(wallet, heard);
    wallet.onGameReceipt = (game, receipt) => {
      for (const listener of heard) listener(gameReceipt(game.id, receipt));
    };
  }
  return {
    balance: async () => wallet.gameLimit(),
    async call(method, params = {}) {
      const checked = validateRequest({ hookedin: true, id: ++sent, method, params }).params;
      if (method === 'wallet.hello') return wallet.gameHello();
      if (method === 'wallet.info') return wallet.gameInfo();
      if (method === 'game.receipt') return wallet.gameReceipt(checked.id);
      if (method === 'game.requestFunds') {
        // The player agrees: the game may risk what it asked for more, as far as the balance goes.
        const more = checked.amount === undefined ? wallet.playableBalance() : BigInt(checked.amount),
          limit = BigInt(wallet.gameLimit().balance) + more,
          amount = limit < wallet.playableBalance() ? limit : wallet.playableBalance();
        await wallet.setGameLimit(String(amount));
        return { funded: true, amount: String(amount), ...wallet.gameLimit() };
      }
      if (method === 'game.bet') return wallet.gameBet(checked);
      if (method === 'game.place') return wallet.gamePlace(checked);
      return wallet.gamePayment(checked);
    },
    onReceipt(listener) {
      listeners!.add(listener);
      return () => void listeners!.delete(listener);
    },
  };
}

/**
 * A real wallet wired to an in-memory casino stub, and a stub referee shaped like the one a game's server
 * creates with its developer's key: what a game is tested against without the private casino. The stub holds
 * every bet to the casino's own admission rule and charges its commission, so a table it passes is one the casino
 * takes. `bankroll` is what it covers bets with; `bank` is what the developer's bank holds to pay bets with terms.
 */
export async function gameWallet({ bankroll: capital = 10n ** 12n, bank: funds = 10n ** 12n } = {}) {
  const storage = new MemoryStore(),
    owner = Wallet.createRandom(),
    player = Wallet.createRandom(),
    developer = Wallet.createRandom();
  const casino = Wallet.createRandom().address,
    d = domain(31337, casino);
  let bankroll = capital,
    bank = funds,
    ahead = 0;
  const now = () => Date.now() + ahead;
  /** A channel this player opens with `deposit`, jointly signed at its start. */
  const openChannel = async (deposit = 1000000n) => {
    const key = Wallet.createRandom(),
      opening = {
        channelId: channelId(player.address, key.address, deposit),
        player: player.address,
        signer: key.address,
        deposit: String(deposit),
      },
      state = initialState(opening);
    return {
      key: key.privateKey,
      opening,
      state: structuredClone(state),
      playerSignature: await key.signTypedData(d, STATE_TYPES, state),
      casinoSignature: await owner.signTypedData(d, STATE_TYPES, state),
      onchain: { status: '1' },
    };
  };
  const first = await openChannel();
  // What the stub casino has signed, by channel and operation, and which channel each game operation ID was
  // carried out on: a game names its operations for its player, not for one channel.
  const responses = new Map<string, any>(),
    carried = new Map<string, string>();
  let settlements = 0;
  // The stub casino's rounds: each is the hash of its secret. A channel's own settles its next bet; a referee's
  // takes bets until it is drawn or its deadline passes.
  const secrets = new Map<string, string>(),
    own = new Map<string, string>();
  const createRound = () => {
    const secret = hexlify(randomBytes(32)),
      round = roundId(secret);
    secrets.set(round, secret);
    return round;
  };
  const rounds = new Map<
    string,
    { id: string; game: string; seed: string; seedHash: string; signature: string; deadline: number; drawn: boolean }
  >();
  let waiting: string | null = null;
  // Bets that settle later, what each settled bet owes this player until the wallet collects it, and the order
  // bets settled in.
  const held = new Map<string, PublicBet>(),
    owed = new Map<string, bigint>(),
    order = new Map<string, number>();
  // A casino derives a player's uname from their address with a key of its own; a stub only has to
  // give each wallet one of the right shape, so a game keys its storage by a real name.
  const uname = hexlify(randomBytes(12)).slice(2).replaceAll('0', 'z').replaceAll('1', 'y');
  const publicRound = (id: string): Round => {
    const round = rounds.get(id.toLowerCase());
    if (!round) throw Object.assign(new Error('Unknown round'), { status: 404, code: 'not-found' });
    const secret = secrets.get(round.id)!;
    return plain({
      id: round.id,
      game: round.game,
      referee: developer.address.toLowerCase(),
      asset: 'eth' as const,
      deadline: round.deadline,
      status: round.drawn ? ('drawn' as const) : round.deadline <= now() ? ('expired' as const) : ('open' as const),
      seedHash: round.seedHash,
      signature: round.signature,
      ...(round.drawn ? { seed: round.seed, secret, outcome: String(outcome([], round.seed, secret).value) } : {}),
    });
  };
  const publicBet = (hash: string) => plain(held.get(hash)!);
  /** A bet settles: what it paid waits, owed to this player, for the wallet to collect. */
  const end = (hash: string, payout: bigint, change: Partial<PublicBet> = {}) => {
    Object.assign(held.get(hash)!, { status: 'settled', payout: String(payout), settledAt: now(), ...change });
    if (payout) owed.set(hash, payout);
    order.set(hash, order.size + 1);
  };
  /** Bets past their deadline come back, as the casino's tick refunds them. */
  const expire = () => {
    for (const bet of held.values())
      if (bet.status === 'open' && bet.deadline <= now()) end(bet.bet, BigInt(bet.stake), { refunded: true });
  };
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
      reportedBankroll: String(bankroll),
      currentId: first.opening.channelId,
      channels: { [first.opening.channelId]: structuredClone(first) },
    });
    wallet.ready = () => {
      wallet.requireDurableState();
      if (!wallet.current) throw new Error('No channel');
    };
    wallet.api = async (path, body) => {
      expire();
      if (path === '/api/metrics') return { bankroll: String(bankroll) };
      const channelRound = /^\/api\/channels\/(0x[0-9a-f]{64})\/round$/.exec(path);
      if (channelRound) {
        if (!own.has(channelRound[1]!)) own.set(channelRound[1]!, createRound());
        return { id: own.get(channelRound[1]!) };
      }
      const round = /^\/api\/rounds\/(0x[0-9a-fA-F]{64})$/.exec(path);
      if (round) return publicRound(round[1]!);
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
            game: bet.game,
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
        return [...owed]
          .slice(0, MAX_PAYOUTS)
          .map(([source, amount]) => ({ source, index: 0, amount: String(amount) }));
      if (!path.endsWith('/operations')) return {};
      const { request, details, signature, seed } = body as any,
        recorded = `${request.channelId}:${details.id}`;
      if (responses.has(recorded)) return responses.get(recorded);
      const kind = Number(request.kind),
        elsewhere = details.game && carried.has(details.id) && carried.get(details.id) !== request.channelId;
      if (kind === KIND.bet) return bet$(request, details, signature, seed, elsewhere);
      if (elsewhere)
        return decline(request, details, 'This operation was carried out on another channel', { used: true });
      if (kind === KIND.debit && details.bet) return place(request, details, signature);
      if (kind === KIND.credit && owed.has(details.counterparty)) {
        if (owed.get(details.counterparty) !== BigInt(request.amount))
          throw new Error('No payout of this amount is due');
        owed.delete(details.counterparty);
      }
      if (kind === KIND.debit) bankroll += BigInt(request.amount);
      return settle(request, details, signature, ZeroHash, ZeroHash, 0n);
    };
    /** The casino declines an operation with a signed checkpoint above it: the balance is unchanged. */
    const decline = async (request: any, details: any, reason: string, extra: Record<string, unknown> = {}) => {
      const base = wallet.channels[request.channelId]!,
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
        bankroll: String(bankroll),
        ...extra,
      });
      responses.set(`${request.channelId}:${details.id}`, response);
      return response;
    };
    const settle = async (request: any, details: any, signature: string, seed: string, secret: string, fee: bigint) => {
      const base = wallet.channels[request.channelId]!;
      const next = deriveState(d, base.state, request, secret, seed);
      const signed = await owner.signTypedData(d, STATE_TYPES, next);
      const response = plain({
        status: 'signed',
        state: next,
        casinoSignature: signed,
        details,
        operationId: details.id,
        commission: String(fee),
        evidence: {
          ...checkpointEvidence(base.state, base.playerSignature, base.casinoSignature),
          step: { operation: request, authorization: signature, seed, secret, casinoSignature: signed },
        },
        bankroll: String(bankroll),
      });
      responses.set(`${request.channelId}:${details.id}`, response);
      if (details.game) carried.set(details.id, request.channelId);
      settlements++;
      return response;
    };
    /** A bet on the channel's own round: admitted by the casino's rule against the bankroll, or declined with
     * the round revealed, so the wallet records what it would have paid. */
    const bet$ = async (request: any, details: any, signature: string, seed: string, elsewhere: boolean) => {
      const round = String(request.round).toLowerCase(),
        secret = secrets.get(round)!;
      if (own.get(request.channelId) !== round) return decline(request, details, 'Round is not open', { lost: true });
      own.set(request.channelId, createRound());
      const nextRound = { nextRound: own.get(request.channelId) },
        terms = betTerms(request.amount, request.prizes);
      if (elsewhere)
        return {
          ...(await decline(request, details, 'This operation was carried out on another channel', {
            used: true,
            secret,
          })),
          ...nextRound,
        };
      let fee: bigint;
      try {
        fee = assessRound({ bankroll, bets: [terms] }).fees[0]!;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return {
          ...(await decline(request, details, 'Casino capacity is too low for this wager', { secret })),
          ...nextRound,
        };
      }
      const paid = outcome(request.prizes, seed, secret).payout;
      bankroll += terms.stake - paid - fee / 2n;
      return { ...(await settle(request, details, signature, seed, secret, fee)), ...nextRound };
    };
    /** A bet that settles later is final and completes at once, if its referee is the game's developer, its
     * deadline is in range and, to be drawn, it rides the developer's open round and fits the bankroll with the
     * bets there before it. */
    const place = async (request: any, details: any, signature: string) => {
      const later = details.bet;
      if (!same(later.referee, developer.address)) return decline(request, details, "This is not the game's developer");
      if ('prizes' in later) {
        const round = rounds.get(later.round);
        if (
          !round ||
          round.drawn ||
          round.deadline <= now() ||
          !same(round.game, details.game) ||
          round.seedHash !== later.seedHash ||
          round.deadline !== later.deadline
        )
          return decline(request, details, 'The round is not open');
        const riding = [...held.values()].filter(bet => bet.round === later.round && bet.status === 'open');
        try {
          assessRound({
            bankroll,
            bets: [...riding, { stake: request.amount, prizes: later.prizes }].map(bet =>
              betTerms(bet.stake, bet.prizes!),
            ),
          });
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          return decline(request, details, 'Casino capacity is too low for this bet on this round');
        }
      } else if (later.deadline <= now() || later.deadline > now() + MAX_DEADLINE_MS)
        return decline(request, details, 'A bet with terms settles within 30 days');
      const hash = hashOperation(d, request).toLowerCase();
      held.set(hash, {
        bet: hash,
        game: details.game,
        ...(details.group ? { group: details.group } : {}),
        asset: 'eth',
        uname,
        alias: null,
        stake: String(request.amount),
        placedAt: now(),
        status: 'open',
        ...later,
      });
      return settle(request, details, signature, ZeroHash, ZeroHash, 0n);
    };
    return wallet;
  };
  /** The referee a game's server would create with its developer's key, against this stub casino. */
  const stubReferee: Referee = {
    address: developer.address,
    limits: LIMITS,
    async open() {
      const current = waiting && rounds.get(waiting);
      if (current && !current.drawn && current.deadline > now()) return publicRound(current.id);
      const id = createRound(),
        seed = hexlify(randomBytes(32)),
        hash = seedHash(seed);
      rounds.set(id, {
        id,
        game: game.key,
        seed,
        seedHash: hash,
        signature: await developer.signTypedData(d, COMMIT_TYPES, { round: id, seedHash: hash }),
        deadline: now() + ROUND_MS,
        drawn: false,
      });
      waiting = id;
      return publicRound(id);
    },
    async draw(id) {
      expire();
      const round = rounds.get(id.toLowerCase());
      if (!round) throw Object.assign(new Error('Unknown round'), { status: 404, code: 'not-found' });
      const riding = [...held.values()].filter(bet => bet.round === round.id);
      if (!round.drawn && riding.some(bet => bet.status === 'open')) {
        const secret = secrets.get(round.id)!,
          open = riding.filter(bet => bet.status === 'open'),
          terms = open.map(bet => betTerms(bet.stake, bet.prizes!));
        let fees: readonly bigint[] = terms.map(() => 0n);
        try {
          fees = assessRound({ bankroll, bets: terms }).fees;
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
        }
        open.forEach((bet, i) => {
          const paid = outcome(bet.prizes!, round.seed, secret).payout;
          bankroll += BigInt(bet.stake) - paid - fees[i]! / 2n;
          end(bet.bet, paid, { draw: { seed: round.seed, secret } });
        });
        round.drawn = true;
      }
      const view = publicRound(round.id);
      return {
        round: round.id,
        ...(view.status === 'drawn' ? { seed: view.seed, secret: view.secret, outcome: view.outcome } : {}),
        bets: riding.map(bet => publicBet(bet.bet)),
      };
    },
    round: async id => publicRound(id),
    async settle(list) {
      expire();
      const hashes = list.map(entry => entry.bet.toLowerCase());
      if (hashes.some(hash => !held.has(hash) || held.get(hash)!.prizes))
        throw Object.assign(new Error('Unknown bet'), { status: 404, code: 'not-found' });
      const open = list.filter((_, i) => held.get(hashes[i]!)!.status === 'open');
      if (open.some(entry => held.get(entry.bet.toLowerCase())!.deadline <= now()))
        throw Object.assign(new Error('The bet is past its deadline'), { status: 409, code: 'bet-expired' });
      const change = open.reduce(
        (sum, entry) =>
          sum + BigInt(held.get(entry.bet.toLowerCase())!.stake) - BigInt(entry.player) - BigInt(entry.casino),
        0n,
      );
      if (bank + change < 0n)
        throw Object.assign(new Error("The developer's bank cannot pay these settlements"), {
          status: 409,
          code: 'bank-short',
        });
      bank += change;
      for (const entry of open) {
        const message = { bet: entry.bet.toLowerCase(), player: String(entry.player), casino: String(entry.casino) };
        end(message.bet, BigInt(message.player), {
          settlement: { ...message, signature: await developer.signTypedData(d, SETTLEMENT_TYPES, message) },
        });
      }
      return hashes.map(publicBet);
    },
    bets: async group =>
      [...held.values()]
        .filter(bet => bet.status === 'open' && (group === undefined || bet.group === group))
        .sort((a, b) => a.placedAt - b.placedAt)
        .map(bet => publicBet(bet.bet)),
    bet: async hash => (held.has(hash.toLowerCase()) ? publicBet(hash.toLowerCase()) : null),
  };
  const game = { name: 'test', key: gameKey({ developer: developer.address, name: 'test' }) };
  const wallet = make();
  await wallet.save();
  /** A wallet started afresh from what this one saved, as a reload does. */
  const reload = async () => {
    const restored = make();
    restored.hydrate(await storage.get('game-wallet'));
    return restored;
  };
  return {
    wallet,
    storage,
    owner,
    player,
    /** The game's developer, whose key the stub referee signs with; `referee` is the referee itself. */
    developer,
    referee: stubReferee,
    /** The game's side of the bridge to this fixture's wallet, and to any other. */
    bridge: bridgeTo(wallet),
    bridgeFor: bridgeTo,
    settlements: () => settlements,
    /** What the stub casino has to cover bets with, and what the developer's bank holds. */
    bankroll: () => bankroll,
    bank: () => bank,
    /** A round's secret, which only the casino knows until it reveals the round. */
    secretOf: (round: string) => secrets.get(round.toLowerCase())!,
    /** Time passes: every bet whose deadline it passes comes back. */
    advance(ms: number) {
      ahead += ms;
      expire();
    },
    /** The player closes their channel and opens another. A game's operation IDs are theirs across both. */
    async replaceChannel(of = wallet) {
      const old = of.channels[of.currentId!]!,
        next = await openChannel();
      of.channels[old.opening.channelId] = { ...old, onchain: { status: '3' } };
      of.channels[next.opening.channelId] = structuredClone(next);
      of.currentId = next.opening.channelId;
      await of.save();
    },
    reload,
    /** A wallet that has lost the receipts this one kept, as one restored from an older backup would have. */
    async forget() {
      for (const key of [...storage.records.keys()]) if (key.includes(':receipt:')) storage.records.delete(key);
      const record = await storage.get('game-wallet');
      await storage.put('game-wallet', { ...record, history: [] });
      return reload();
    },
    /** A game as its developer published it: the game this fixture's referee runs is `test`. `declared` is
     * anything its manifest says otherwise. */
    identity: (name = game.name, declared: Partial<GameIdentity> = {}): GameIdentity => ({
      name,
      slug: name,
      key: gameKey({ developer: developer.address, name }),
      manifestURL: `https://${name}.example/manifest.json`,
      entryURL: `https://${name}.example/`,
      developer: developer.address,
      ...declared,
    }),
  };
}
