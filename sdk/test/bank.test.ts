import test from 'node:test';
import assert from 'node:assert/strict';
import { fraction } from '../src/engine/index.ts';

/** An element that keeps its class, text, attributes and children: all of the DOM the bank strip touches. */
class Element {
  className = '';
  textContent = '';
  type = '';
  disabled = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Element[] = [];
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  toggleAttribute(name: string, on: boolean) {
    if (on) this.attributes.set(name, '');
    else this.attributes.delete(name);
  }
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  addEventListener() {}
}

test("the bank strip hears every push, lets a listener go, and follows its round beside the round's other listeners", async () => {
  const posted: any[] = [],
    listeners: ((event: any) => void)[] = [];
  const parent = { postMessage: (message: any) => posted.push(message) };
  (globalThis as any).window = { parent, addEventListener: (_: string, fn: any) => listeners.push(fn) };
  (globalThis as any).document = { createElement: () => new Element() };
  try {
    const { HookedIn } = await import('../src/sdk.ts');
    const { mountBank } = await import('../src/bank.ts');
    const { RoundClient } = await import('../src/round.ts');
    const deliver = (data: any) => listeners.forEach(listener => listener({ source: parent, data }));
    const push = (balance: string) => deliver({ hookedin: true, event: 'game.balance', balance, pending: false });
    const settled = () => new Promise(resolve => setImmediate(resolve));
    const asset = { symbol: 'ETH', decimals: 18 },
      saved = new Map<string, string>();
    const round = new RoundClient(
      {
        call: async (method: string) =>
          method === 'wallet.hello' ? { asset } : { uname: 'player', chainId: '1', bankroll: String(10n ** 21n) },
        balance: HookedIn.balance,
      },
      (setup: any) => ({
        root: 'start',
        nodes: [
          {
            id: 'start',
            kind: 'decision',
            actions: [
              {
                id: 'roll',
                outcomes: [
                  { next: 'win', probability: fraction(1n, 2n) },
                  { next: 'loss', probability: fraction(1n, 2n) },
                ],
              },
            ],
          },
          { id: 'win', kind: 'terminal', payout: (BigInt(setup.stake) * 19n) / 10n },
          { id: 'loss', kind: 'terminal', payout: 0n },
        ],
      }),
      undefined,
      {
        store: {
          get: key => saved.get(key) ?? null,
          set: (key, value) => void saved.set(key, value),
          remove: key => void saved.delete(key),
        },
      },
    );
    const heard: string[] = [];
    const deaf = round.onChange(() => heard.push('round'));
    const root = new Element();
    const bank = mountBank(root as any, { round });
    const [, amount, symbol] = root.children[0]!.children;
    // The wallet refuses the greeting the page sends as it loads, and answers the game's next one: the strip shows
    // the balance once it has.
    deliver({ hookedin: true, id: 1, error: { code: 'game-closed', message: 'No game is open' } });
    push('5000000000000000');
    await settled();
    assert.equal(amount!.textContent, '—');
    const greeting = HookedIn.hello();
    deliver({ hookedin: true, id: posted.at(-1).id, result: { asset } });
    await greeting;
    await settled();
    assert.deepEqual([amount!.textContent, symbol!.textContent], ['0.005', 'ETH']);
    // Every push, once the strip has taken it in, until the listener stops.
    const changes: string[] = [];
    const stop = bank.onChange(balance => changes.push(`${balance.balance} shown as ${bank.balance.balance}`));
    push('4000000000000000');
    stop();
    push('3000000000000000');
    assert.deepEqual(changes, ['4000000000000000 shown as 4000000000000000']);
    // The strip redraws with the round, and the round's other listeners hear it too.
    await round.start({ stake: '1000000000000000' });
    assert.deepEqual(heard, ['round']);
    assert.equal(amount!.textContent, '0.002', 'the cash inside the round is left out');
    deaf();
    push('2000000000000000');
    await round.restore();
    assert.deepEqual(heard, ['round']);
    assert.equal(amount!.textContent, '0.001');
  } finally {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  }
});
