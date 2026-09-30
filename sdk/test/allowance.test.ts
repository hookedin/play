import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../../testing/game-wallet.ts';
import { createSynth } from '../src/synth.ts';
import { coin } from './coin.ts';

/** An element that keeps its class, text, attributes and children: all of the DOM the allowance strip touches. */
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

test("the allowance strip shows every push in ETH and follows its round beside the round's other listeners", async () => {
  const posted: any[] = [],
    listeners: ((event: any) => void)[] = [];
  const parent = { postMessage: (message: any) => posted.push(message) };
  (globalThis as any).window = { parent, addEventListener: (_: string, fn: any) => listeners.push(fn) };
  (globalThis as any).document = { createElement: () => new Element() };
  try {
    const { HookedIn } = await import('../src/sdk.ts');
    const { mountAllowance } = await import('../src/allowance.ts');
    const { RoundClient } = await import('../src/round.ts');
    const deliver = (data: any) => listeners.forEach(listener => listener({ source: parent, data }));
    const push = (allowance: string) => deliver({ hookedin: true, event: 'game.allowance', allowance, pending: false });
    // The wallet answers the greeting the page sends as it loads.
    deliver({ hookedin: true, id: posted[0].id, result: { bounds: {} } });
    const round = new RoundClient(
      {
        call: async () => ({ uname: 'player', chainId: '1', bankroll: String(10n ** 21n) }),
        allowance: HookedIn.allowance,
      },
      coin({ payout: stake => (stake * 19n) / 10n }),
      undefined,
      { store: memoryStore() },
    );
    const heard: string[] = [];
    const deaf = round.onChange(() => heard.push('round'));
    const root = new Element();
    mountAllowance(root as any, { round });
    const [, amount, symbol] = root.children[0]!.children;
    // Nothing to show until the wallet pushes an allowance, and then at once.
    assert.deepEqual([amount!.textContent, symbol!.textContent], ['—', 'ETH']);
    push('5000000000000000');
    assert.equal(amount!.textContent, '0.005');
    // The strip redraws with the round, and the round's other listeners hear it too.
    await round.start({ stake: '1000000000000000' });
    assert.deepEqual(heard, ['round']);
    assert.equal(amount!.textContent, '0.004', 'the cash inside the round is left out');
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

test('a browser without Web Audio, or one that refuses a context, plays silently and never stops the click that plays', () => {
  // Node has neither localStorage nor AudioContext: a browser with both switched off.
  const silent = createSynth();
  assert.doesNotThrow(() => silent.unlock());
  assert.doesNotThrow(() => silent.melody([440, 880], 0.1));
  assert.equal(silent.output, null);
  const refusing = createSynth();
  (globalThis as any).AudioContext = class {
    constructor() {
      throw new Error('No audio device');
    }
  };
  try {
    assert.doesNotThrow(() => refusing.unlock());
    assert.equal(refusing.output, null);
  } finally {
    delete (globalThis as any).AudioContext;
  }
});
