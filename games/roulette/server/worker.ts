/**
 * The whole game in one Worker: the page and its files are static assets, and everything under
 * /api/ is the wheel, one Durable Object. The page talks to nobody but this origin, and the Worker
 * to nobody but the casino's public API.
 */
import { createHost } from '@hookedin/play/sdk/host';
import { Wheel } from './wheel.ts';
import type { WheelState } from './wheel.ts';

interface Env {
  ASSETS: Fetcher;
  WHEEL: DurableObjectNamespace;
  /** The casino's public API. */
  CASINO_URL: string;
  /** The host's private key: it opens and closes rounds and nothing else. A secret. */
  HOST_KEY: string;
}

export class RouletteWheel implements DurableObject {
  private wheel: Promise<Wheel> | null = null;
  readonly ctx: DurableObjectState;
  readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
  /** One wheel, opened once and shared by every request that arrives meanwhile. A start that failed
   * is not kept: the casino it needs may be there by the next request. */
  private open(url: URL) {
    return (this.wheel ??= (async () => {
      await this.ctx.storage.put('url', url.href);
      return new Wheel(
        {
          host: await createHost({ casinoURL: this.env.CASINO_URL, key: this.env.HOST_KEY }),
          asset: assetOf(url),
          now: () => Date.now(),
          save: state => this.ctx.storage.put('state', state),
          wake: at => void this.ctx.storage.setAlarm(at),
        },
        await this.ctx.storage.get<WheelState>('state'),
      );
    })().catch(error => {
      this.wheel = null;
      throw error;
    }));
  }
  async fetch(request: Request) {
    const url = new URL(request.url);
    try {
      const wheel = await this.open(url);
      if (url.pathname === '/api/table' && request.method === 'GET') return Response.json(await wheel.view());
      if (url.pathname === '/api/table/seated' && request.method === 'POST') return Response.json(await wheel.seated());
      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (error: any) {
      return Response.json({ error: error.message || 'The wheel is unavailable' }, { status: 503 });
    }
  }
  /** The wheel spins on time whether or not anybody is asking. */
  async alarm() {
    await (
      await (this.wheel ?? this.open(new URL((await this.ctx.storage.get<string>('url'))!)))
    )
      .alarm()
      .catch(() => {});
  }
}

const assetOf = (url: URL) => (url.searchParams.get('asset') === 'test' ? 'test' : 'eth');

export default {
  fetch(request: Request, env: Env) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // Players with ETH share one wheel, players with test coins another.
    return env.WHEEL.get(env.WHEEL.idFromName(assetOf(new URL(request.url)))).fetch(request);
  },
};
