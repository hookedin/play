import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const chainId = (url: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  }).then(response => response.json());

test('a test chain stops with the process that started it, even one killed outright', async t => {
  const contract = new URL('../testing/contract.ts', import.meta.url).href;
  const owner = spawn(
    process.execPath,
    ['--input-type=module', '-e', `import { anvil } from '${contract}'; console.log((await anvil()).url);`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => owner.kill('SIGKILL'));
  let printed = '';
  for await (const chunk of owner.stdout!) {
    printed += chunk;
    if (/^http:.*\n/m.test(printed)) break;
  }
  const url = /^(http:.*)$/m.exec(printed)![1]!;
  assert.equal((await chainId(url)).result, '0x7a69');
  owner.kill('SIGKILL');
  await once(owner, 'exit');
  for (let i = 0; ; i++) {
    try {
      await chainId(url);
    } catch {
      return;
    }
    if (i > 50) assert.fail('The chain outlived the process that started it');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});
