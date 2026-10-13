import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { createDeveloper, DEVELOPER_PROTOCOL } from '../src/developer.ts';

test('the developer kit takes what the casino answers in its one form, every whole number a decimal string', async t => {
  const answers: Record<string, unknown> = {
    '/api/config': {
      developerProtocol: DEVELOPER_PROTOCOL,
      chainId: '31337',
      contractAddress: Wallet.createRandom().address,
    },
    '/api/status': { virtualBankroll: '500' },
    '/api/games/01890a5d-ac96-774b-bcce-b302099a8057': { bank: '700' },
  };
  t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(answers[new URL(url).pathname]));
  const developer = await createDeveloper({
    casinoURL: 'https://casino.example',
    key: Wallet.createRandom().privateKey,
    game: '01890a5d-ac96-774b-bcce-b302099a8057',
  });
  assert.equal(await developer.virtualBankroll(), 500n);
  assert.equal(await developer.bank(), 700n);
  for (const virtualBankroll of [500, '0x1f4', '0500', ' 500']) {
    answers['/api/status'] = { virtualBankroll };
    await assert.rejects(developer.virtualBankroll(), (error: any) => error.code === 'invalid');
    answers['/api/games/01890a5d-ac96-774b-bcce-b302099a8057'] = { bank: virtualBankroll };
    await assert.rejects(developer.bank(), (error: any) => error.code === 'invalid');
  }
});
