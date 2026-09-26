import { Wallet, ZeroHash, getBytes, hexlify, keccak256, randomBytes } from 'ethers';
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
  BANK_CASINO_BET_TYPES,
  deriveState,
  roundId,
  seedHash,
  gameKey,
  hashJSON,
  hashOperation,
  outcome,
  betPayout,
  plain,
  betTerms,
  checkpointEvidence,
  rejectionCheckpoint,
  KIND,
  LIMITS,
  MAX_DEVELOPER_BETS,
  MAX_META_BYTES,
  MAX_PAYOUTS,
  validMeta,
} from '../protocol/protocol.ts';
import { assessBet } from '../protocol/risk.ts';
import type { GameIdentity, GameLimit, GameReceipt } from '../protocol/game-types.ts';
import type { DeveloperCasinoBet, PublicDeveloperBet, Round } from '../protocol/types.ts';
import type { BankCasinoBet, Developer, Settlement } from '../sdk/src/developer.ts';

/** A game's side of the bridge, as `RoundClient` and a game's own client take it: every request goes through the
 * checks the wallet's bridge makes, and the player agrees to every request for funds. */
export interface TestBridge {
  call(method: string, params?: any): Promise<any>;
  balance(): Promise<GameLimit>;
  /** Called with every receipt the wallet pushes: a developer bet its developer settled, once collected. */
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
      if (method === 'wallet.round') return wallet.gameRound(checked.id);
      if (method === 'game.receipt') return wallet.gameReceipt(checked.id);
      if (method === 'game.requestFunds') {
        // The player agrees: the game may risk what it asked for more, as far as the balance goes.
        const more = checked.amount === undefined ? wallet.playableBalance() : BigInt(checked.amount),
          limit = BigInt(wallet.gameLimit().balance) + more,
          amount = limit < wallet.playableBalance() ? limit : wallet.playableBalance();
        await wallet.setGameLimit(String(amount));
        return { funded: true, amount: String(amount), ...wallet.gameLimit() };
      }
      if (method === 'game.casinoBet') return wallet.gameCasinoBet(checked);
      if (method === 'game.developerBet') return wallet.gameDeveloperBet(checked);
      return wallet.gamePayment(checked);
    },
    onReceipt(listener) {
      listeners!.add(listener);
      return () => void listeners!.delete(listener);
    },
  };
}

/**
 * A real wallet wired to an in-memory casino stub, and a stub developer shaped like the one a game's server creates
 * with its developer's key: what a game is tested against without the private casino. The stub holds every casino
 * bet to the casino's own admission rule and charges its commission, so a bet it takes is one the casino takes.
 * `bankroll` is what it covers casino bets with; `bank` is what the developer's bank holds before any developer bet
 * pays its stake into it.
 */
export async function gameWallet({ bankroll: capital = 10n ** 12n, bank: funds = 10n ** 12n } = {}) {
  const storage = new MemoryStore(),
    owner = Wallet.createRandom(),
    player = Wallet.createRandom(),
    developerKey = Wallet.createRandom();
  const casino = Wallet.createRandom().address,
    d = domain(31337, casino);
  let bankroll = capital,
    bank = funds;
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
  // The stub casino's rounds: each is the hash of its secret. A channel's own settles its next casino bet; a
  // developer's is revealed by the developer's casino bet on it.
  const secrets = new Map<string, string>(),
    own = new Map<string, string>();
  const createRound = () => {
    const secret = hexlify(randomBytes(32)),
      round = roundId(secret);
    secrets.set(round, secret);
    return round;
  };
  const rounds = new Map<string, { id: string; seed?: string; casinoBet?: DeveloperCasinoBet }>();
  // Developer bets, what each settled bet owes this player until the wallet collects it, and the order bets settled in.
  const developerBets = new Map<string, PublicDeveloperBet>(),
    owed = new Map<string, bigint>(),
    order = new Map<string, number>();
  // A casino derives a player's uname from their address with a key of its own; a stub only has to
  // give each wallet one of the right shape, so a game keys its storage by a real name.
  const uname = hexlify(randomBytes(12)).slice(2).replaceAll('0', 'z').replaceAll('1', 'y');
  const game = { name: 'test', key: gameKey({ developer: developerKey.address, name: 'test' }).toLowerCase() };
  // The games this fixture's developer publishes, by key: only a published game takes developer bets.
  const published = new Set([game.key]);
  const publicRound = (id: string): Round => {
    const round = rounds.get(id.toLowerCase());
    if (!round) throw Object.assign(new Error('Unknown round'), { status: 404, code: 'not-found' });
    const secret = secrets.get(round.id)!;
    return plain({
      id: round.id,
      developer: developerKey.address.toLowerCase(),
      status: round.casinoBet ? ('revealed' as const) : ('open' as const),
      ...(round.casinoBet
        ? {
            seed: round.seed,
            secret,
            outcome: String(outcome(round.seed!, secret).value),
            casinoBet: round.casinoBet,
          }
        : {}),
    });
  };
  const publicDeveloperBet = (hash: string) => plain(developerBets.get(hash)!);
  /** A page of developer bets, as the casino's feeds give them: open ones by hash, settled ones in the order they
   * settled. */
  const page = (bets: PublicDeveloperBet[], settled: boolean, after: string, limit: number) => {
    const all = bets
      .filter(bet =>
        settled
          ? bet.status === 'settled' && order.get(bet.bet)! > Number(after || '0')
          : bet.status === 'open' && bet.bet > after,
      )
      .sort((a, b) => (settled ? order.get(a.bet)! - order.get(b.bet)! : a.bet.localeCompare(b.bet)));
    const bets$ = all.slice(0, limit);
    return {
      bets: bets$,
      cursor: bets$.length
        ? String(settled ? order.get(bets$.at(-1)!.bet) : bets$.at(-1)!.bet)
        : after || (settled ? '0' : ''),
      more: all.length > limit,
    };
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
      channelId: first.opening.channelId,
      channels: { [first.opening.channelId]: structuredClone(first) },
    });
    wallet.ready = () => {
      wallet.requireDurableState();
      if (!wallet.channel) throw new Error('No channel');
    };
    wallet.api = async (path, body) => {
      if (path === '/api/metrics') return { bankroll: String(bankroll) };
      const channelRound = /^\/api\/channels\/(0x[0-9a-f]{64})\/round$/.exec(path);
      if (channelRound) {
        if (!own.has(channelRound[1]!)) own.set(channelRound[1]!, createRound());
        return { id: own.get(channelRound[1]!) };
      }
      const round = /^\/api\/rounds\/(0x[0-9a-fA-F]{64})$/.exec(path);
      if (round) return publicRound(round[1]!);
      const developerBet = /^\/api\/developer-bets\/(0x[0-9a-f]{64})$/.exec(path);
      if (developerBet) return publicDeveloperBet(developerBet[1]!);
      const list = new URL(path, 'https://casino.example');
      if (list.pathname.endsWith('/developer-bets')) {
        const settled = list.searchParams.get('status') === 'settled',
          { bets, cursor, more } = page(
            [...developerBets.values()],
            settled,
            list.searchParams.get('after') ?? '',
            Number(list.searchParams.get('limit') ?? 50),
          );
        return plain({
          bets: bets.map(bet => ({
            bet: bet.bet,
            game: bet.game,
            status: bet.status,
            stake: bet.stake,
            collected: settled && bet.settlement?.player !== '0' && !owed.has(bet.bet),
            ...(settled ? { payout: bet.settlement!.player, settledAt: bet.settledAt } : {}),
          })),
          cursor,
          more,
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
      if (kind === KIND.casinoBet) return casinoBet(request, details, signature, seed, elsewhere);
      if (elsewhere)
        return decline(request, details, 'This operation was carried out on another channel', { used: true });
      if (kind === KIND.debit && details.meta) return placeDeveloperBet(request, details, signature);
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
    /** A casino bet on the channel's own round: admitted by the casino's rule against the bankroll, or declined
     * with the round revealed, so the wallet records what it would have paid. */
    const casinoBet = async (request: any, details: any, signature: string, seed: string, elsewhere: boolean) => {
      const round = String(request.round).toLowerCase(),
        secret = secrets.get(round)!;
      if (own.get(request.channelId) !== round) return decline(request, details, 'Round is not open', { lost: true });
      own.set(request.channelId, createRound());
      const nextRound = { nextRound: own.get(request.channelId) },
        terms = betTerms(request.amount, request.chance, request.prize);
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
        fee = assessBet({ bankroll, bet: terms }).fee;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return {
          ...(await decline(request, details, 'The bankroll cannot take this casino bet', { secret })),
          ...nextRound,
        };
      }
      const paid = betPayout(terms, outcome(seed, secret).value);
      bankroll += terms.stake - paid - fee / 2n;
      return { ...(await settle(request, details, signature, seed, secret, fee)), ...nextRound };
    };
    /** A developer bet is final and completes at once if its game is published: its stake goes into the developer's
     * bank, and the developer settles it. */
    const placeDeveloperBet = async (request: any, details: any, signature: string) => {
      if (!published.has(details.game)) return decline(request, details, 'This game is published nowhere');
      const hash = hashOperation(d, request).toLowerCase();
      bank += BigInt(request.amount);
      developerBets.set(hash, {
        bet: hash,
        game: details.game,
        ...(details.group ? { group: details.group } : {}),
        uname,
        alias: null,
        developer: developerKey.address.toLowerCase(),
        stake: String(request.amount),
        placedAt: Date.now(),
        status: 'open',
        meta: details.meta,
      });
      return settle(request, details, signature, ZeroHash, ZeroHash, 0n);
    };
    return wallet;
  };
  const refused = (status: number, code: string, message: string) =>
    Object.assign(new Error(message), { status, code });
  /** One batch of settlements, as the casino takes it: paid whole from the developer's bank, or not at all. */
  const settleBatch = async (list: Settlement[]) => {
    const hashes = list.map(entry => entry.bet.toLowerCase());
    if (hashes.some(hash => !developerBets.has(hash))) throw refused(404, 'not-found', 'Unknown developer bet');
    const open = list.filter((_, i) => developerBets.get(hashes[i]!)!.status === 'open');
    const total = open.reduce((sum, entry) => sum + BigInt(entry.player) + BigInt(entry.casino), 0n);
    if (total > bank) throw refused(409, 'bank-short', "The developer's bank cannot pay these settlements");
    bank -= total;
    for (const entry of open) {
      const message = { bet: entry.bet.toLowerCase(), player: String(entry.player), casino: String(entry.casino) };
      Object.assign(developerBets.get(message.bet)!, {
        status: 'settled',
        settlement: { ...message, signature: await developerKey.signTypedData(d, SETTLEMENT_TYPES, message) },
        settledAt: Date.now(),
      });
      if (BigInt(message.player)) owed.set(message.bet, BigInt(message.player));
      order.set(message.bet, order.size + 1);
    }
    return hashes.map(publicDeveloperBet);
  };
  /** The seed of the developer's casino bet on a round, derived from its key as the developer kit derives it. */
  const seedOf = async (round: string) => keccak256(await developerKey.signMessage(getBytes(round)));
  /** The developer's casino bet on its round, as the casino takes it: admitted against the bankroll before the secret
   * is read, or, betting nothing, a plain reveal. Either way the round is revealed once. */
  const stubCasinoBet = async ({ round: id, stake, chance, prize, group, meta }: BankCasinoBet) => {
    const round = rounds.get(id.toLowerCase());
    if (!round) throw refused(404, 'not-found', 'Unknown round');
    if (!validMeta(meta))
      throw refused(400, 'invalid', `A casino bet's meta is a JSON object of up to ${MAX_META_BYTES} bytes`);
    if (typeof group !== 'string' || !group.length || group.length > LIMITS.group)
      throw refused(400, 'invalid', 'A casino bet names a group of 1 to 64 characters');
    const seed = await seedOf(round.id),
      message = {
        round: round.id,
        game: game.key,
        stake: String(stake),
        chance: String(chance),
        prize: String(prize),
        group,
      };
    const signature = await developerKey.signTypedData(d, BANK_CASINO_BET_TYPES, {
      ...message,
      seedHash: seedHash(seed),
      meta: hashJSON(meta),
    });
    // A round is revealed once: the same casino bet again is answered as it stands.
    if (round.casinoBet) {
      if (round.casinoBet.signature !== signature)
        throw refused(409, 'round-revealed', 'This round was revealed by another casino bet');
      return publicRound(round.id);
    }
    const reveal = message.stake === '0' && message.chance === '0' && message.prize === '0',
      terms = betTerms(message.stake, message.chance, message.prize);
    if (!reveal && terms.stake > bank)
      throw refused(409, 'bank-short', "The developer's bank cannot pay this casino bet");
    let fee: bigint | null = null;
    if (!reveal)
      try {
        fee = assessBet({ bankroll, bet: terms }).fee;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    const secret = secrets.get(round.id)!,
      paid = fee === null ? 0n : betPayout(terms, outcome(seed, secret).value);
    if (fee !== null) {
      bankroll += terms.stake - paid - fee / 2n;
      bank += paid - terms.stake;
    }
    const { round: _, ...signed } = message;
    round.seed = seed;
    round.casinoBet = plain({
      ...signed,
      meta: plain(meta),
      signature,
      accepted: fee !== null,
      ...(fee === null ? {} : { payout: String(paid) }),
    });
    return publicRound(round.id);
  };
  /** The developer a game's server would create with its developer's key, against this stub casino. */
  const stubDeveloper: Developer = {
    address: developerKey.address,
    game: game.key,
    limits: LIMITS,
    bankroll: async () => bankroll,
    async openRound() {
      const id = createRound();
      rounds.set(id, { id });
      return publicRound(id);
    },
    seedHash: async id => seedHash(await seedOf(id.toLowerCase())),
    round: async id => publicRound(id),
    casinoBet: bet => stubCasinoBet(bet),
    reveal: ({ round, group, meta }) => stubCasinoBet({ round, stake: 0n, chance: 0n, prize: 0n, group, meta }),
    // Settlements go to the casino a batch at a time, as the kit sends them, and each batch is paid whole or not at all.
    async settle(settlements) {
      const settled: PublicDeveloperBet[] = [];
      for (let i = 0; i < settlements.length; i += MAX_DEVELOPER_BETS)
        settled.push(...(await settleBatch(settlements.slice(i, i + MAX_DEVELOPER_BETS))));
      return settled;
    },
    bets: async ({ status = 'open', group, after = '', limit = 100 } = {}) => {
      const { bets, cursor, more } = page(
        [...developerBets.values()].filter(
          bet => bet.game === game.key && (group === undefined || bet.group === group),
        ),
        status === 'settled',
        after,
        limit,
      );
      return { bets: bets.map(bet => publicDeveloperBet(bet.bet)), cursor, more };
    },
    bet: async hash => (developerBets.has(hash.toLowerCase()) ? publicDeveloperBet(hash.toLowerCase()) : null),
  };
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
    /** The developer the game's server would create: it opens rounds, places its casino bets and settles developer
     * bets, with the developer's key. */
    developer: stubDeveloper,
    /** The game's side of the bridge to this fixture's wallet, and to any other. */
    bridge: bridgeTo(wallet),
    bridgeFor: bridgeTo,
    settlements: () => settlements,
    /** What the stub casino has to cover casino bets with, and what the developer's bank holds. */
    bankroll: () => bankroll,
    bank: () => bank,
    /** A round's secret, which only the casino knows until it reveals the round. */
    secretOf: (round: string) => secrets.get(round.toLowerCase())!,
    /** The player closes their channel and opens another. A game's operation IDs are theirs across both. */
    async replaceChannel(of = wallet) {
      const old = of.channels[of.channelId!]!,
        next = await openChannel();
      of.channels[old.opening.channelId] = { ...old, onchain: { status: '3' } };
      of.channels[next.opening.channelId] = structuredClone(next);
      of.channelId = next.opening.channelId;
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
    /** A game as its developer published it: the game this fixture's developer serves is `test`. `declared` is
     * anything its manifest says otherwise. Every game named here is published. */
    identity: (name = game.name, declared: Partial<GameIdentity> = {}): GameIdentity => {
      const key = gameKey({ developer: developerKey.address, name });
      published.add(key.toLowerCase());
      return {
        name,
        slug: name,
        key,
        manifestURL: `https://${name}.example/manifest.json`,
        entryURL: `https://${name}.example/`,
        developer: developerKey.address,
        ...declared,
      };
    },
  };
}
