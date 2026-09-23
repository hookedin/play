/**
 * The whole game in one Worker: the page and its files are static assets, and everything under /api/ is
 * the book, one Durable Object. Anyone may read the markets and ask for a quote; opening, resolving and
 * voiding a market takes the operator's token. The Worker talks to nobody but the casino's public API.
 */
import { createReferee } from '@hookedin/play/sdk/referee';
import { Book } from './book.ts';
import type { Market } from './book.ts';

interface Env {
  ASSETS: Fetcher;
  BOOK: DurableObjectNamespace;
  /** The casino's public API. */
  CASINO_URL: string;
  /** The game as its developer published it: their address and the game's name. */
  DEVELOPER: string;
  GAME_NAME: string;
  /** The referee's private key: it opens, prices and resolves the game's pots and nothing else. A secret. */
  REFEREE_KEY: string;
  /** What the operator sends as `Authorization: Bearer …` to open, resolve and void markets. A secret. */
  ADMIN_TOKEN?: string;
}

export class SportsBook implements DurableObject {
  private book: Promise<Book> | null = null;
  readonly ctx: DurableObjectState;
  readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
  /** One book, opened once and shared by every request that arrives meanwhile. A start that failed is
   * not kept: the casino it needs may be there by the next request. */
  private open() {
    return (this.book ??= (async () =>
      new Book(
        {
          referee: await createReferee({
            casinoURL: this.env.CASINO_URL,
            key: this.env.REFEREE_KEY,
            game: { developer: this.env.DEVELOPER, name: this.env.GAME_NAME },
          }),
          now: () => Date.now(),
          save: markets => this.ctx.storage.put('markets', markets),
        },
        await this.ctx.storage.get<Market[]>('markets'),
      ))().catch(error => {
      this.book = null;
      throw error;
    }));
  }
  async fetch(request: Request) {
    const { pathname } = new URL(request.url),
      post = request.method === 'POST';
    try {
      const book = await this.open(),
        body: any = post ? await request.json().catch(() => null) : null;
      if (pathname === '/api/markets' && !post) return Response.json(book.list());
      if (pathname === '/api/quote' && post) return Response.json(await book.quote(body));
      const operator = /^\/api\/markets(?:\/([^/]+)\/(resolve|void))?$/.exec(pathname);
      if (operator && post) {
        const token = this.env.ADMIN_TOKEN;
        if (!token || request.headers.get('authorization') !== `Bearer ${token}`)
          return Response.json({ error: "Only the book's operator may do that" }, { status: 401 });
        const [, id, action] = operator;
        return Response.json(
          !id
            ? await book.open(body)
            : action === 'resolve'
              ? await book.resolve(id, body?.winner)
              : await book.void(id),
        );
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (error: any) {
      return Response.json({ error: error.message || 'The book is unavailable' }, { status: error.status ?? 503 });
    }
  }
}

export default {
  fetch(request: Request, env: Env) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    return env.BOOK.get(env.BOOK.idFromName('book')).fetch(request);
  },
};
