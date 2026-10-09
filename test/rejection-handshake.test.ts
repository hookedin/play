import test from 'node:test';
import assert from 'node:assert/strict';
import { gameWallet } from '../testing/game-wallet.ts';
import { checkpointEvidence, rejectionCheckpoint, STATE_TYPES, verifyEvidence } from '../protocol/protocol.ts';

const bet = { id: 'declined', stake: '10', chance: '9000000000000000000', prize: '20' };

test('a rejection is agreed durably before completion, and a lost completion survives reload', async () => {
  const f = await gameWallet({ bankroll: 1n }),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('100');
  const base = structuredClone(w.channel!.state),
    api = w.api.bind(w);
  let requests = 0;
  w.api = async (path, body: any) => {
    if (!path.endsWith('/operations')) return api(path, body);
    requests++;
    const response = await api(path, body);
    assert.deepEqual(w.channel!.state, base, 'the proposal does not advance the wallet');
    if (requests === 1) {
      assert.equal(body.rejectionSignature, undefined);
      assert.equal(response.casinoSignature, '0x');
      return response;
    }
    const saved = await f.storage.get(w.storageKey);
    assert.equal(saved.channels[w.channelId!].pending.rejectionSignature, body.rejectionSignature);
    assert.notEqual(response.casinoSignature, '0x');
    throw new Error('completion lost');
  };
  await assert.rejects(w.gameCasinoBet(bet), /completion lost/);
  assert.equal(requests, 2);
  const restored = await f.reload(),
    receipt = await restored.resume();
  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.reason, 'No quote of the casino covers this casino bet');
  assert.equal(restored.pending, null);
  assert.equal(await restored.balance(), BigInt(base.balance));
  assert.deepEqual(
    verifyEvidence({
      chainId: String(restored.expectedChainId),
      casino: restored.config.contractAddress,
      operator: restored.operator,
      evidence: receipt.proof,
    }).state,
    restored.channel!.state,
  );
  assert.equal(f.settlements(), 0);
});

test('a covered casino bet signs no rejection proposal', async () => {
  const f = await gameWallet(),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('100');
  const api = w.api.bind(w);
  w.api = async (path, body: any) => {
    if (!path.endsWith('/operations')) return api(path, body);
    assert.equal(body.rejectionSignature, undefined);
    return {
      status: 'rejected',
      reason: 'No quote of the casino covers this casino bet',
      request: body.request,
      state: rejectionCheckpoint(w.domain, w.channel!.state, body.request),
      casinoSignature: '0x',
      evidence: checkpointEvidence(w.channel!.state, w.channel!.playerSignature, w.channel!.casinoSignature),
    };
  };
  await assert.rejects(w.gameCasinoBet(bet), /quote covers/);
  assert.equal(w.pending.rejectionSignature, undefined);
  assert.ok(w.pending.quote);
});

test('a rejection signature stays inside the wallet when its save fails', async () => {
  const f = await gameWallet({ bankroll: 1n }),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('100');
  const api = w.api.bind(w);
  let requests = 0;
  w.api = async (path, body: any) => {
    const response = await api(path, body);
    if (path.endsWith('/operations')) {
      requests++;
      f.storage.beforeCommit = () => {
        throw new Error('storage failed');
      };
    }
    return response;
  };
  await assert.rejects(w.gameCasinoBet(bet), /storage failed/);
  assert.equal(requests, 1);
  const saved = await f.storage.get(w.storageKey);
  assert.equal(saved.channels[w.channelId!].pending.rejectionSignature, undefined);
});

test('a result after an agreed rejection is refused, so the signed rejection can never supersede what follows it', async () => {
  const f = await gameWallet(),
    w = f.wallet,
    api = w.api.bind(w),
    base = structuredClone(w.channel!.state);
  w.openGame(f.identity());
  let requests = 0;
  w.api = async (path, body: any) => {
    const response = await api(path, body);
    if (!path.endsWith('/operations') || ++requests !== 1) return response;
    return {
      status: 'rejected',
      reason: 'Declined',
      request: body.request,
      state: rejectionCheckpoint(w.domain, base, body.request),
      casinoSignature: '0x',
      evidence: checkpointEvidence(base, w.channel!.playerSignature, w.channel!.casinoSignature),
    };
  };
  await assert.rejects(w.payBankroll(10n, 'payment'), /result after its rejection was agreed/);
  assert.equal(requests, 2);
  assert.equal(f.settlements(), 1);
  assert.deepEqual(w.channel!.state, base, 'the wallet stays below the rejection it signed');
  assert.ok(w.pending.rejectionSignature);
});

test('a casino-only rejection signature does not complete a rejection', async () => {
  const f = await gameWallet({ bankroll: 1n }),
    w = f.wallet;
  w.openGame(f.identity());
  await w.setGameAllowance('100');
  const api = w.api.bind(w);
  w.api = async (path, body: any) => {
    const response = await api(path, body);
    if (path.endsWith('/operations'))
      response.casinoSignature = await f.owner.signTypedData(w.domain, STATE_TYPES, response.state);
    return response;
  };
  await assert.rejects(w.gameCasinoBet(bet), /jointly signed/);
  assert.equal(w.pending.rejectionSignature, undefined);
});
