import test from 'node:test';
import assert from 'node:assert/strict';
import { withLock } from '../client/storage.ts';

/** Web Locks as a browser grants them: one holder per name, waiters in order, a wait that can be aborted. */
function fakeLocks() {
  const held = new Set<string>(),
    waiting = new Map<string, (() => void)[]>();
  return {
    async request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: any) {
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        await new Promise<void>((resolve, reject) => {
          const queue = waiting.get(name) ?? [];
          waiting.set(name, [...queue, resolve]);
          options.signal?.addEventListener('abort', () => reject(options.signal!.reason));
        });
      }
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
        waiting.get(name)?.shift()?.();
      }
    },
  };
}

test("an action outlasts another tab's brief observation and still gives way to a long hold", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: fakeLocks() } });
  t.after(() =>
    original ? Object.defineProperty(globalThis, 'navigator', original) : delete (globalThis as any).navigator,
  );
  const hold = (ms: number) => withLock('channel', true, () => new Promise<void>(resolve => setTimeout(resolve, ms)));

  let observing = hold(20);
  assert.equal(await withLock('channel', false, async held => held), false, 'an observation skips a busy lock');
  assert.equal(await withLock('channel', 500, async held => held), true, 'an action waits the observation out');
  await observing;

  observing = hold(200);
  assert.equal(await withLock('channel', 20, async held => held), false, 'a long hold is still reported');
  await observing;

  const failure = new DOMException('The read timed out', 'TimeoutError');
  await assert.rejects(
    withLock('channel', 500, async () => {
      throw failure;
    }),
    error => error === failure,
    "the action's own timeout is not mistaken for a busy tab",
  );
});
