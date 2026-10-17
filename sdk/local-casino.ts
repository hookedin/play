/**
 * What `hookedin-game serve` runs in Node beside the local wallet's page (local-wallet.ts): the real wallet with pretend
 * money, against the test kit's stand-in casino (testing/game-wallet.ts), with keys made up for it. The page asks the
 * wallet everything here, and the game's server, if it has one, reaches the same casino over HTTP, under /api/, as
 * `createDeveloper` reaches the real one: it opens rounds and reads and settles the bets the wallet places. It all lives
 * in memory, so serve starts it afresh.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gameWallet } from '../testing/game-wallet.ts';
import {
  assertSignature,
  hashJSON,
  json,
  seedHash,
  BANK_CASINO_BET_TYPES,
  DEVELOPER_ACCESS_TYPES,
  DEVELOPER_PROTOCOL,
  MAX_DEVELOPER_BETS,
  MAX_JSON_BYTES,
  SETTLEMENT_TYPES,
} from '../protocol/protocol.ts';
import * as read from '../protocol/read.ts';
import { formatAmount } from './src/wire.ts';
import { decode, encode } from './local-json.ts';

/** The key the game's server signs with here, made up for the stand-in, which takes it as the game's and no other. */
export const SERVER_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const ETH = 10n ** 18n;
const refused = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
/** A request's body, as long as the casino reads. */
async function body(req: IncomingMessage) {
  let text = '';
  for await (const chunk of req)
    if ((text += chunk).length > MAX_JSON_BYTES) throw refused(413, 'too-large', 'The request is too large');
  return text;
}

/** The local wallet's player and the stand-in casino, with the game at `url` open: `handle` answers the page's
 * requests and the game's server's, and `game` is the ID the server names the game by. */
export async function localCasino(url: string) {
  // A pretend ETH to play with, against a bankroll as large as the casino's, so it covers the bets the casino covers,
  // and a bank as large for the game's server to pay from.
  const f = await gameWallet({ deposit: ETH, bankroll: 1000n * ETH, bank: 1000n * ETH, key: SERVER_KEY }),
    { wallet, developer } = f,
    game = f.identity(undefined, { url }),
    d = wallet.domain;
  wallet.openGame(game);
  /** The pages open, each a stream of what its top bar shows and what it tells the game, as they change. */
  const pages = new Set<ServerResponse>(),
    shown = () => ({
      balance: `${formatAmount(wallet.playableBalance(), 0)} METH`,
      allowance: `${formatAmount(wallet.gameAllowance().allowance, 0)} METH`,
    });
  // What the top bars last showed, and whether the game said it places developer bets: the player's allowance then
  // allows them too.
  let last = '',
    developerBets = false;
  const tell = (event: string, fields: object) => {
    for (const page of pages) page.write(`data: ${encode([event, fields])}\n\n`);
  };
  wallet.onChange = () => {
    const now = shown();
    if (json(now) !== last) tell('wallet', now);
    last = json(now);
  };
  f.bridge.onAllowance(allowance => tell('game.allowance', allowance));
  f.bridge.onReceipt(receipt => tell('game.receipt', { receipt }));

  /** The game's server, by the access its key signed, good for two minutes at most: the stand-in's key, or refused. */
  const server = (req: IncomingMessage) => {
    try {
      const token = /^HookedIn ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')![1]!,
        { message, signature } = read.signed(DEVELOPER_ACCESS_TYPES)(
          JSON.parse(Buffer.from(token, 'base64url').toString()),
        ),
        now = BigInt(Math.floor(Date.now() / 1000));
      if (message.server === game.developer && message.expiresAt >= now && message.expiresAt <= now + 120n)
        return assertSignature(d, DEVELOPER_ACCESS_TYPES, message, signature, game.developer);
    } catch {}
    throw refused(401, 'unauthorized', 'Sign with the SERVER_KEY hookedin-game serve prints');
  };
  const ours = (named: unknown) => {
    if (named !== game.id) throw refused(400, 'invalid', 'Name the game by the GAME hookedin-game serve prints');
  };
  /** The casino's API as `createDeveloper` calls it, each request read in its one form as the casino reads it. */
  const casino = async (req: IncomingMessage, { pathname, searchParams }: URL): Promise<unknown> => {
    const round = /^\/api\/rounds\/(0x[0-9a-f]{64})(\/casino-bet)?$/.exec(pathname);
    if (req.method === 'GET') {
      if (pathname === '/api/config')
        return { chainId: d.chainId, contractAddress: d.verifyingContract, developerProtocol: DEVELOPER_PROTOCOL };
      if (pathname === '/api/status') return { virtualBankroll: await developer.virtualBankroll() };
      if (pathname === `/api/games/${game.id}`) return { bank: await developer.bank() };
      if (round && !round[2]) return developer.round(round[1]!);
      if (pathname === '/api/developer-bets') {
        const query = [...searchParams],
          { game: named, status = 'open', after = '', wait } = Object.fromEntries(query);
        if (
          query.some(([key]) => !['game', 'status', 'after', 'wait'].includes(key)) ||
          new Set(query.map(([key]) => key)).size !== query.length ||
          (status !== 'open' && status !== 'settled') ||
          (wait !== undefined && !/^[1-9][0-9]?$/.test(wait))
        )
          throw refused(400, 'invalid', 'Name a game, and its open or settled bets, after a cursor, waiting or not');
        ours(named);
        // Only the game's server waits for its bets.
        if (wait) server(req);
        return developer.bets({ status, after, wait: Number(wait ?? 0) });
      }
    }
    if (req.method !== 'POST') throw refused(404, 'not-found', 'The local casino answers a game server only');
    server(req);
    let input: unknown;
    try {
      input = JSON.parse(await body(req));
    } catch (error: any) {
      throw error.status ? error : refused(400, 'invalid', 'A request is JSON');
    }
    if (pathname === '/api/rounds') {
      ours(read.object({ game: read.gameId })(input).game);
      return developer.openRound();
    }
    if (round?.[2]) {
      const bet = read.object({
        round: read.hash,
        game: read.text,
        stake: read.whole,
        chance: read.whole,
        prize: read.whole,
        group: read.text,
        meta: read.meta,
        seed: read.hash,
        signature: read.signature,
      })(input);
      ours(bet.game);
      const { round: id, stake, chance, prize, group, meta, seed } = bet;
      // The stand-in derives the seed from the server's key as the kit does, and reveals the round with it.
      if (id !== round[1] || seedHash(seed) !== (await developer.seedHash(id)))
        throw refused(400, 'invalid', 'A casino bet names its round and brings the seed its server derives for it');
      try {
        const signed = {
          round: id,
          game: game.id,
          stake,
          chance,
          prize,
          group,
          seedHash: seedHash(seed),
          meta: hashJSON(meta),
        };
        assertSignature(d, BANK_CASINO_BET_TYPES, signed, bet.signature, game.developer);
      } catch {
        throw refused(400, 'invalid', "The casino bet is not signed by the game's server");
      }
      return developer.casinoBet({ round: id, stake, chance, prize, group, meta });
    }
    if (pathname === '/api/developer-bets/settle') {
      const { settlements } = read.object({
        settlements: read.list(
          read.object({
            bet: read.hash,
            player: read.whole,
            casino: read.whole,
            secret: read.optional(read.hash),
            signature: read.signature,
          }),
          MAX_DEVELOPER_BETS,
        ),
      })(input);
      if (!settlements.length)
        throw refused(400, 'invalid', `Settle 1 to ${MAX_DEVELOPER_BETS} developer bets at once`);
      for (const { bet, player, casino, signature } of settlements)
        try {
          assertSignature(d, SETTLEMENT_TYPES, { bet, player, casino }, signature, game.developer);
        } catch {
          throw refused(400, 'invalid', "The settlement is not signed by the game's server");
        }
      return developer.settle(settlements.map(({ signature, ...settlement }) => settlement));
    }
    throw refused(404, 'not-found', 'The local casino answers a game server only');
  };
  /** What the page asks of the wallet: a game's request, checked as the wallet's bridge checks it and answered as the
   * wallet answers it, but for the bet in full that `wallet.showBet` asks the page to show; or the allowance the player
   * sets in the top bar. */
  const ask = async (pathname: string, input: any) => {
    if (pathname === '/allowance') return wallet.setGameAllowance(input, developerBets);
    const { method, params } = input,
      result = await f.bridge.call(method, params);
    if (method === 'game.placesDeveloperBets') developerBets = true;
    return method === 'wallet.showBet' ? wallet.gameBet(params.id) : result;
  };
  return {
    game: game.id,
    async handle(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let status = 200,
          answer: unknown;
        try {
          answer = await casino(req, url);
        } catch (error: any) {
          status = error.status ?? 400;
          answer = { error: error.message, code: /^[a-z][a-z-]*$/.test(error.code ?? '') ? error.code : 'invalid' };
        }
        return void res
          .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(json(answer));
      }
      if (url.pathname === '/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(`data: ${encode(['wallet', shown()])}\n\n`);
        pages.add(res);
        req.on('close', () => pages.delete(res));
        return;
      }
      if ((url.pathname === '/wallet' || url.pathname === '/allowance') && req.method === 'POST') {
        let answer: unknown;
        try {
          answer = { result: (await ask(url.pathname, decode(await body(req)))) ?? null };
        } catch (error: any) {
          answer = { error: { code: error.code, message: error.shortMessage || error.message } };
        }
        return void res
          .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(encode(answer));
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    },
  };
}
