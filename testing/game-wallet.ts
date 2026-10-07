import { Wallet, ZeroHash, getBytes, hexlify, keccak256, randomBytes } from 'ethers';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';
import { validateRequest } from '../client/bridge.ts';
import { gameReceipt } from '../client/wallet-games.ts';
import {
  domain,
  baseState,
  hashState,
  channelId,
  STATE_TYPES,
  SETTLEMENT_TYPES,
  BANK_CASINO_BET_TYPES,
  deriveState,
  roundId,
  seedHash,
  hashJSON,
  hashOperation,
  outcome,
  betPayout,
  plain,
  betTerms,
  checkpointEvidence,
  rejectionCheckpoint,
  KIND,
  BOUNDS,
  MAX_DEVELOPER_BETS,
  MAX_META_BYTES,
  MAX_PAYOUTS,
  validMeta,
  validGroup,
  canonicalJSON,
  assertSignature,
  covers,
  QUOTE_TYPES,
  QUOTE_PERIOD,
  gameSlug,
  urlGameId,
} from '../protocol/protocol.ts';
import { assessBet, betReturn, RETURN_SCALE } from '../protocol/risk.ts';
import type { GameIdentity, GameReceipt } from '../protocol/game-types.ts';
import type { DeveloperCasinoBet, PublicDeveloperBet, Round } from '../protocol/types.ts';
import type { BankCasinoBet, Developer, Settlement } from '../sdk/src/developer.ts';
import type { GamePlan } from '../sdk/src/engine/index.ts';

/** A game's side of the bridge, as `RoundClient` and a game's own client take it: every request goes through the
 * checks the wallet's bridge makes. The test sets the allowance, as the player does in the wallet's top bar. */
export interface TestBridge {
  call(method: string, params?: any): Promise<any>;
  /** Called with every receipt the wallet pushes: a developer bet its developer settled, once collected. */
  onReceipt(listener: (receipt: GameReceipt) => void): () => void;
}

/** A game's side of the bridge to any wallet: requests go through the checks the wallet's bridge makes, and every
 * receipt the wallet pushes reaches the listeners. */
const pushes = new WeakMap<CasinoWallet, Set<(receipt: GameReceipt) => void>>();
export function bridgeTo(wallet: CasinoWallet): TestBridge {
  let listeners = pushes.get(wallet),
    sent = 0;
  if (!listeners) {
    const heard = (listeners = new Set());
    pushes.set(wallet, heard);
    wallet.onGameReceipt = (game, receipt) => {
      for (const listener of heard) listener(gameReceipt(game.operation, receipt));
    };
  }
  return {
    async call(method, params = {}) {
      const checked = validateRequest({ hookedin: true, id: ++sent, method, params }).params;
      if (method === 'wallet.hello') return wallet.gameHello();
      if (method === 'wallet.info') return wallet.gameInfo();
      if (method === 'wallet.round') return wallet.gameRound(checked.id);
      if (method === 'game.receipt') return wallet.gameReceipt(checked.id);
      if (method === 'game.history') return wallet.gameHistory(checked.after, checked.limit);
      if (method === 'game.allowance') return wallet.gameAllowance(checked.group);
      if (method === 'game.end') {
        await wallet.gameEnd(checked.group, checked.meta);
        return null;
      }
      if (method === 'game.placesDeveloperBets') return null;
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

/** A game's origin storage in memory, as `RoundClient` takes it in a test: what `localStorage` is to a page. Two
 * clients over one store are one game in two tabs, or before and after a reload. `map` holds what it saved. */
export function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    get: (key: string) => map.get(key) ?? null,
    set: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => void map.delete(key),
  };
}

/** The least any bet a priced game can place pays back, in millionths of its stake: every branch of every step. */
export function worstReturn(plan: GamePlan) {
  let worst = RETURN_SCALE;
  for (const node of plan.nodes)
    if (node.kind === 'decision')
      for (const { transition } of node.actions)
        if (transition.kind === 'casino-bet')
          for (const branch of transition.branches)
            if (branch.kind === 'bet' && betReturn(branch.bet) < worst) worst = betReturn(branch.bet);
  return worst;
}

/**
 * A real wallet wired to an in-memory casino stub, and a stub developer shaped like the one a game's server creates
 * with its key, here the developer's own: what a game is tested against without the private casino. The stub holds
 * every casino bet to the casino's own admission rule and charges its commission, so a bet it takes is one the casino
 * takes. `bankroll` is what it covers casino bets with, and admits them against half of, as the casino's quotes do;
 * `bank` is what the game's bank holds before any developer bet pays its stake into it.
 */
export async function gameWallet({
  bankroll: capital = 10n ** 12n,
  bank: funds = 10n ** 12n,
  deposit = 1000000n,
} = {}) {
  const storage = new MemoryStore(),
    owner = Wallet.createRandom(),
    player = Wallet.createRandom(),
    developerKey = Wallet.createRandom();
  const casino = Wallet.createRandom().address,
    d = domain(31337, casino);
  let bankroll = capital,
    bank = funds;
  /** The player's channel number `index`, with `deposit` taken into its balance and jointly signed. */
  const openChannel = async (deposit = 1000000n, index = 0) => {
    const opening = { channelId: channelId(player.address, index), player: player.address, index: String(index) },
      base = baseState(opening.player, opening.index),
      state = {
        ...base,
        sequence: '1',
        previousStateHash: hashState(d, base),
        balance: String(deposit),
        deposited: String(deposit),
      };
    return {
      opening,
      state: structuredClone(state),
      playerSignature: await player.signTypedData(d, STATE_TYPES, state),
      casinoSignature: await owner.signTypedData(d, STATE_TYPES, state),
      registered: true,
      onchain: { status: '0', deposited: String(deposit), principal: String(deposit), collateral: '0', claimed: '0' },
    };
  };
  const first = await openChannel(deposit);
  // What the stub casino has signed, by channel and operation, and which channel each game operation ID was
  // carried out on: a game names its operations for its player, not for one channel.
  const responses = new Map<string, any>(),
    carried = new Map<string, string>();
  let settlements = 0;
  // The stub casino's rounds: each is the hash of its secret. A channel's own settles its next casino bet; a game's is
  // revealed by the game's casino bet on it.
  const secrets = new Map<string, string>(),
    own = new Map<string, string>();
  const createRound = () => {
    const secret = hexlify(randomBytes(32)),
      round = roundId(secret);
    secrets.set(round, secret);
    return round;
  };
  /** The quote for the casino bet that follows `state` on a channel: its round, and half the bankroll, for a day. */
  const quoteFor = async (channel: string, state: any) => {
    if (!own.has(channel)) own.set(channel, createRound());
    const message = {
      previousStateHash: hashState(d, state),
      round: own.get(channel)!,
      virtualBankroll: String(bankroll / 2n),
      expiresAt: String(Math.floor(Date.now() / 1000) + QUOTE_PERIOD),
    };
    return { message, signature: await owner.signTypedData(d, QUOTE_TYPES, message) };
  };
  const rounds = new Map<string, { id: string; createdAt: number; seed?: string; casinoBet?: DeveloperCasinoBet }>();
  // Developer bets, what each settled bet owes this player until the wallet collects it, the order bets were placed and
  // settled in, each bet's ID, which a cursor names, and the developer's wait for the next bet.
  const developerBets = new Map<string, PublicDeveloperBet>(),
    owed = new Map<string, bigint>(),
    placed = new Map<string, number>(),
    order = new Map<string, number>(),
    ids = new Map<string, string>();
  let waiting: () => void = () => {};
  // A casino derives a player's uname from their address with a key of its own; a stub only has to
  // give each wallet one of the right shape, so a game keys its storage by a real name.
  const uname = hexlify(randomBytes(12)).slice(2).replaceAll('0', 'z').replaceAll('1', 'y');
  // A casino gives a game its ID when it is first published; the stub gives each name one.
  const idOf = (name: string) => urlGameId(`stub game ${name}`);
  const game = { name: 'test', id: idOf('test') };
  // The games this fixture's developer publishes, by ID: only a published game takes developer bets.
  const published = new Set([game.id]);
  const publicRound = (id: string): Round => {
    const round = rounds.get(id.toLowerCase());
    if (!round) throw Object.assign(new Error('Unknown round'), { status: 404, code: 'not-found' });
    const secret = secrets.get(round.id)!;
    return plain({
      id: round.id,
      game: game.id,
      createdAt: round.createdAt,
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
  /** The player's history of each game, oldest first, as the casino keeps it: each game operation it carried out, with
   * the developer bet it placed if it placed one, and each group a game ended with meta. */
  const history: ({ id: string; at: number; game: string } & (
    | { type: 'operation'; details: any; evidence: any; hash?: string }
    | { type: 'end'; group: string; meta: Record<string, unknown> }
  ))[] = [];
  /** A page of the player's history of `game`, newest first, older than the entry `after` names. */
  const historyPage = (game: string, after: string, limit: number) => {
    const all = history.filter(entry => entry.game === game).reverse(),
      from = after ? all.findIndex(entry => entry.id === after) + 1 : 0,
      page = all.slice(from, from + limit);
    return plain({
      entries: page.map(entry =>
        entry.type === 'end'
          ? { type: 'end', at: entry.at, group: entry.group, meta: entry.meta }
          : {
              type: 'operation',
              at: entry.at,
              details: entry.details,
              evidence: entry.evidence,
              ...(entry.hash ? { bet: publicDeveloperBet(entry.hash) } : {}),
            },
      ),
      cursor: page.at(-1)?.id ?? after,
      more: all.length > from + limit,
    });
  };
  /** A game ends a group with meta once: the same meta again changes nothing, and other meta is refused. */
  const endGroup = ({ game, group, meta }: any) => {
    if (!validGroup(group) || !validMeta(meta)) throw refused(400, 'invalid', 'A malformed end of a group');
    const ended = history.find(entry => entry.type === 'end' && entry.game === game && entry.group === group);
    if (ended?.type === 'end' && canonicalJSON(ended.meta) !== canonicalJSON(meta))
      throw refused(409, 'id-conflict', 'This group ended with other meta');
    if (!ended) history.push({ id: crypto.randomUUID(), at: Date.now(), type: 'end', game, group, meta: plain(meta) });
    return {};
  };
  /** A page of developer bets, as the casino's feeds give them: open ones in the order they were placed, settled ones
   * in the order they settled. */
  const page = (bets: PublicDeveloperBet[], settled: boolean, after: string, limit: number) => {
    const at = settled ? order : placed,
      from = [...ids].find(([, id]) => id === after)?.[0];
    if (after && !(from && at.has(from))) throw refused(400, 'invalid', 'Invalid developer bet cursor or limit');
    const all = bets
      .filter(bet => bet.status === (settled ? 'settled' : 'open') && at.get(bet.bet)! > (from ? at.get(from)! : 0))
      .sort((a, b) => at.get(a.bet)! - at.get(b.bet)!);
    const bets$ = all.slice(0, limit);
    return { bets: bets$, cursor: bets$.length ? ids.get(bets$.at(-1)!.bet)! : after, more: all.length > limit };
  };
  const make = () => {
    const wallet = new CasinoWallet({ network: 'local', storage });
    Object.assign(wallet, {
      storageKey: 'game-wallet',
      address: player.address,
      uname,
      discordUsername: null,
      signer: player,
      domain: d,
      config: { contractAddress: casino, operator: owner.address },
      channelId: first.opening.channelId,
      channels: { [first.opening.channelId]: structuredClone(first) },
    });
    wallet.ready = async () => {
      wallet.requireDurableState();
      if (!wallet.channel) throw new Error('No channel');
    };
    wallet.api = async (path, body) => {
      const channelQuote = /^\/api\/channels\/(0x[0-9a-f]{64})\/quote$/.exec(path);
      if (channelQuote) return { quote: await quoteFor(channelQuote[1]!, wallet.channels[channelQuote[1]!]!.state) };
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
      if (list.pathname === '/api/account/game-history')
        return body === undefined
          ? historyPage(
              list.searchParams.get('game')!,
              list.searchParams.get('after') ?? '',
              Number(list.searchParams.get('limit') ?? 50),
            )
          : endGroup(body);
      if (path.endsWith('/payouts'))
        return [...owed]
          .slice(0, MAX_PAYOUTS)
          .map(([source, amount]) => ({ source, record: ids.get(source) ?? source, amount: String(amount) }));
      const channel = /^\/api\/channels\/(0x[0-9a-f]{64})\/operations$/.exec(path)?.[1];
      if (!channel) throw refused(404, 'not-found', `The stub casino has no ${path}`);
      const { request, details, signature, seed, quote, rejectionSignature } = body as any,
        recorded = `${channel}:${details.id}`;
      if (responses.has(recorded)) return responses.get(recorded);
      const kind = Number(request.kind),
        elsewhere = details.game && carried.has(details.id) && carried.get(details.id) !== channel;
      if (rejectionSignature)
        return decline(
          channel,
          request,
          details,
          'Cancelled by player',
          elsewhere ? { used: true } : {},
          rejectionSignature,
        );
      if (kind === KIND.casinoBet) return casinoBet(channel, request, details, signature, seed, quote, elsewhere);
      if (elsewhere)
        return decline(channel, request, details, 'This operation was carried out on another channel', { used: true });
      if (kind === KIND.debit && details.meta) return placeDeveloperBet(channel, request, details, signature);
      if (kind === KIND.credit && owed.has(details.counterparty)) {
        if (owed.get(details.counterparty) !== BigInt(request.amount))
          throw new Error('No payout of this amount is due');
        owed.delete(details.counterparty);
      }
      if (kind === KIND.debit) bankroll += BigInt(request.amount);
      return settle(channel, request, details, signature, ZeroHash, ZeroHash, 0n);
    };
    /** The casino proposes a rejection, then completes it once the player signs its unchanged-balance checkpoint. */
    const decline = async (
      channel: string,
      request: any,
      details: any,
      reason: string,
      extra: Record<string, unknown> = {},
      rejectionSignature?: string,
    ) => {
      const base = wallet.channels[channel]!,
        state = rejectionCheckpoint(d, base.state, request);
      if (rejectionSignature) assertSignature(d, STATE_TYPES, state, rejectionSignature, player.address);
      const casinoSignature = rejectionSignature ? await owner.signTypedData(d, STATE_TYPES, state) : '0x';
      const response = plain({
        status: 'rejected',
        reason,
        request,
        details,
        operationId: details.id,
        state,
        casinoSignature,
        commission: '0',
        evidence: rejectionSignature
          ? checkpointEvidence(state, rejectionSignature, casinoSignature)
          : checkpointEvidence(base.state, base.playerSignature, base.casinoSignature),
        ...(rejectionSignature ? { quote: await quoteFor(channel, state) } : {}),
        ...extra,
      });
      if (rejectionSignature) responses.set(`${channel}:${details.id}`, response);
      return response;
    };
    const settle = async (
      channel: string,
      request: any,
      details: any,
      signature: string,
      seed: string,
      secret: string,
      fee: bigint,
    ) => {
      const base = wallet.channels[channel]!;
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
        quote: await quoteFor(channel, next),
      });
      responses.set(`${channel}:${details.id}`, response);
      if (details.game) {
        carried.set(details.id, channel);
        history.push({
          id: crypto.randomUUID(),
          at: Date.now(),
          game: details.game,
          type: 'operation',
          details,
          evidence: response.evidence,
          ...(details.meta ? { hash: hashOperation(d, request).toLowerCase() } : {}),
        });
      }
      settlements++;
      return response;
    };
    /** A casino bet on the channel's own round: settled when the stub's quote covers it, and otherwise declined,
     * revealing nothing. A covered one carried out on another channel is declined with the proof the wallet checks. */
    const casinoBet = async (
      channel: string,
      request: any,
      details: any,
      signature: string,
      seed: string,
      quote: any,
      elsewhere: boolean,
    ) => {
      const round = String(request.round).toLowerCase(),
        used = 'This operation was carried out on another channel';
      let covered = own.get(channel) === round;
      try {
        assertSignature(d, QUOTE_TYPES, quote?.message ?? {}, quote?.signature ?? '', owner.address);
        covered &&= covers(quote, request, Math.floor(Date.now() / 1000));
      } catch {
        covered = false;
      }
      if (!covered)
        return decline(channel, request, details, elsewhere ? used : 'No quote of the casino covers this casino bet', {
          ...(elsewhere ? { used: true } : {}),
        });
      if (elsewhere) {
        const other = responses.get(`${carried.get(details.id)}:${details.id}`);
        return decline(channel, request, details, used, {
          used: true,
          carried: {
            base: other.evidence.base,
            operation: other.evidence.step.operation,
            authorization: other.evidence.step.authorization,
            details: other.details,
          },
        });
      }
      own.set(channel, createRound());
      const secret = secrets.get(round)!,
        terms = betTerms(request.amount, request.chance, request.prize),
        fee = assessBet({ bankroll: BigInt(quote.message.virtualBankroll), bet: terms }).fee,
        paid = betPayout(terms, outcome(seed, secret).value);
      bankroll += terms.stake - paid - fee / 2n;
      return settle(channel, request, details, signature, seed, secret, fee);
    };
    /** A developer bet is final and completes at once if its game is published: its stake goes into the game's bank,
     * and the game's server settles it. */
    const placeDeveloperBet = async (channel: string, request: any, details: any, signature: string) => {
      if (!published.has(details.game)) return decline(channel, request, details, 'This game is published nowhere');
      const hash = hashOperation(d, request).toLowerCase();
      bank += BigInt(request.amount);
      developerBets.set(hash, {
        bet: hash,
        game: details.game,
        ...(details.group ? { group: details.group } : {}),
        uname,
        discordUsername: null,
        stake: String(request.amount),
        placedAt: Date.now(),
        status: 'open',
        meta: details.meta,
      });
      placed.set(hash, placed.size + 1);
      ids.set(hash, crypto.randomUUID());
      waiting();
      return settle(channel, request, details, signature, ZeroHash, ZeroHash, 0n);
    };
    return wallet;
  };
  const refused = (status: number, code: string, message: string) =>
    Object.assign(new Error(message), { status, code });
  /** One batch of settlements, as the casino takes it: paid whole from the game's bank, or not at all. */
  const settleBatch = async (list: Settlement[]) => {
    const hashes = list.map(entry => entry.bet.toLowerCase());
    if (hashes.some(hash => !developerBets.has(hash))) throw refused(404, 'not-found', 'Unknown developer bet');
    const open = list.filter((_, i) => developerBets.get(hashes[i]!)!.status === 'open');
    const total = open.reduce((sum, entry) => sum + BigInt(entry.player) + BigInt(entry.casino), 0n);
    if (total > bank) throw refused(409, 'bank-short', "The game's bank cannot pay these settlements");
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
  /** The seed of the game's casino bet on a round, derived from its server's key as the developer kit derives it. */
  const seedOf = async (round: string) => keccak256(await developerKey.signMessage(getBytes(round)));
  /** The game's casino bet on its round, as the casino takes it: admitted against the virtual bankroll, half the
   * bankroll, before the secret is read, or, betting nothing, a plain reveal. Either way the round is revealed once. */
  const stubCasinoBet = async ({ round: id, stake, chance, prize, group, meta }: BankCasinoBet) => {
    const round = rounds.get(id.toLowerCase());
    if (!round) throw refused(404, 'not-found', 'Unknown round');
    if (!validMeta(meta))
      throw refused(400, 'invalid', `A casino bet's meta is a JSON object of up to ${MAX_META_BYTES} bytes`);
    if (typeof group !== 'string' || !group.length || group.length > BOUNDS.group)
      throw refused(400, 'invalid', 'A casino bet names a group of 1 to 64 characters');
    const seed = await seedOf(round.id),
      message = {
        round: round.id,
        game: game.id,
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
    if (!reveal && terms.stake > bank) throw refused(409, 'bank-short', "The game's bank cannot pay this casino bet");
    let fee: bigint | null = null;
    if (!reveal)
      try {
        fee = assessBet({ bankroll: bankroll / 2n, bet: terms }).fee;
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
  /** The developer a game's server would create with its key, against this stub casino. */
  const stubDeveloper: Developer = {
    virtualBankroll: async () => bankroll / 2n,
    async openRound() {
      const id = createRound();
      rounds.set(id, { id, createdAt: Date.now() });
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
    // An open page with no bets waits as the casino holds it: until a bet is placed, the time is up or another wait
    // begins.
    async bets({ status = 'open', after = '', wait = 0 } = {}) {
      if (wait && (status !== 'open' || !Number.isInteger(wait) || wait < 1 || wait > 25))
        throw refused(400, 'invalid', 'Wait 1 to 25 seconds for open developer bets');
      if (wait) waiting();
      const read = () => {
        const { bets, cursor, more } = page(
          [...developerBets.values()].filter(bet => bet.game === game.id),
          status === 'settled',
          after,
          100,
        );
        return { bets: bets.map(bet => publicDeveloperBet(bet.bet)), cursor, more };
      };
      const first = read();
      if (!wait || first.bets.length) return first;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, wait * 1000);
        waiting = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      return read();
    },
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
    /** The developer the game's server would create: it opens the game's rounds, places its casino bets and settles
     * its developer bets, with the developer's own key. */
    developer: stubDeveloper,
    /** The game's side of the bridge to this fixture's wallet. */
    bridge: bridgeTo(wallet),
    settlements: () => settlements,
    /** What the game's bank holds. */
    bank: () => bank,
    /** A round's secret, which only the casino knows until it reveals the round. */
    secretOf: (round: string) => secrets.get(round.toLowerCase())!,
    /** The player closes their channel and opens another. A game's operation IDs are theirs across both. */
    async replaceChannel() {
      const old = wallet.channels[wallet.channelId!]!,
        next = await openChannel(1000000n, Number(old.opening.index) + 1);
      wallet.channels[old.opening.channelId] = { ...old, onchain: { ...old.onchain, status: '2' } };
      wallet.channels[next.opening.channelId] = structuredClone(next);
      wallet.channelId = next.opening.channelId;
      await wallet.save();
    },
    reload,
    /** A wallet that has lost the receipts this one kept, as the same account on another device has. */
    async forget() {
      for (const key of [...storage.records.keys()]) if (key.includes(':receipt:')) storage.records.delete(key);
      const record = await storage.get('game-wallet');
      await storage.put('game-wallet', { ...record, history: [] });
      return reload();
    },
    /** A game as its developer published it: the game this fixture's developer serves is `test`. `declared` is
     * anything else about it. Every game named here is published. */
    identity: (name = game.name, declared: Partial<GameIdentity> = {}): GameIdentity => {
      const id = idOf(name);
      published.add(id);
      return {
        name,
        slug: gameSlug(name),
        id,
        url: `https://${name}.example/`,
        developer: developerKey.address,
        ...declared,
      };
    },
  };
}
