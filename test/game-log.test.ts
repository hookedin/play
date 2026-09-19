import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRequest, describeResult } from '../client/game-log.ts';

test('bridge requests summarize their financial terms in one line', () => {
  const bet = describeRequest('game.bet', {
    stake: '1000000000000000',
    prizes: [
      { rangeStart: '0', rangeEnd: String((1n << 64n) / 2n), payout: '1990000000000000' },
      { rangeStart: '0', rangeEnd: String((1n << 64n) / 4n), payout: '10000000000000' },
    ],
    id: 'round-7',
  });
  assert.match(bet, /stake 0\.001 ETH/);
  assert.match(bet, /2 prizes · pays up to 0\.002 ETH/, 'overlapping prizes add');
  assert.match(bet, /RTP 99\.7500%/);
  assert.match(describeRequest('game.bet', { stake: '1', prizes: 'nonsense', id: 'x' }), /unreadable prizes/);
  assert.match(bet, /id round-7/);
  assert.equal(describeRequest('game.receipt', { id: 'round-7' }), 'id round-7');
  assert.equal(describeRequest('game.requestFunds', {}), 'no suggested amount');
  assert.equal(
    describeRequest('game.requestFunds', { amount: '5', reason: 'Double' }),
    'suggests 0.000000000000000005 ETH · “Double”',
  );
  assert.equal(describeRequest('wallet.info', {}), '');
});

test('bridge replies summarize outcomes without exposing more than the reply itself', () => {
  assert.equal(
    describeResult('game.bet', { status: 'signed', payout: '3000', balance: '2000', operationId: 'op-1' }),
    'paid 0.000000000000003 ETH · balance 0.000000000000002 ETH · op-1',
  );
  assert.equal(
    describeResult('game.bet', { status: 'rejected', verified: true, reason: 'Capacity' }),
    'rejected (verified) · “Capacity”',
  );
  assert.equal(
    describeResult('game.requestFunds', { funded: true, amount: '10', balance: '10', pending: false }),
    'authorized 0.00000000000000001 ETH · balance 0.00000000000000001 ETH',
  );
  assert.equal(
    describeResult('game.receipt', { kind: 'bet', status: 'signed', payout: '0', operationId: 'op-2' }),
    'bet signed · paid 0.0 ETH · op-2',
  );
  assert.match(
    describeResult('wallet.info', { balance: '1', availableBalance: '1', bankroll: '2', channelStatus: '1' }),
    /channel open/,
  );
  assert.equal(describeResult('game.bet', null), '');
});
