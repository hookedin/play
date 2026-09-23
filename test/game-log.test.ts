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
  assert.match(
    describeRequest('game.place', { stake: '1', terms: { pick: 'home' }, deadline: 0, group: 'match-9', id: 'p' }),
    /^stake 0\.000000000000000001 ETH · split by its referee · deadline .* · group match-9 · id p$/,
  );
  assert.match(
    describeRequest('game.place', { stake: '1', prizes: [], round: '0x' + 'a'.repeat(64), id: 'q' }),
    /drawn by its referee · id q$/,
  );
  assert.equal(describeRequest('game.receipt', { id: 'round-7' }), 'id round-7');
  assert.equal(describeRequest('game.requestFunds', {}), 'no suggested amount');
  assert.equal(describeRequest('game.requestFunds', { amount: '5' }), 'suggests 0.000000000000000005 ETH');
  assert.equal(describeRequest('wallet.info', {}), '');
});

test('bridge replies summarize outcomes without exposing more than the reply itself', () => {
  assert.equal(
    describeResult('game.bet', { id: 'op-1', kind: 'bet', status: 'settled', basis: 'outcome', payout: '3000' }),
    'bet settled · paid 0.000000000000003 ETH · op-1',
  );
  assert.equal(
    describeResult('game.bet', { id: 'op-3', kind: 'bet', status: 'rejected', reason: 'Capacity' }),
    'bet rejected · “Capacity” · op-3',
  );
  assert.equal(describeResult('game.place', { id: 'op-4', kind: 'bet', status: 'placed' }), 'bet placed · op-4');
  assert.equal(
    describeResult('game.receipt', { id: 'op-4', kind: 'bet', status: 'settled', basis: 'referee', payout: '7' }),
    "bet settled · paid 0.000000000000000007 ETH · on its referee's word · op-4",
  );
  assert.equal(
    describeResult('game.requestFunds', { funded: true, amount: '10', balance: '10', pending: false }),
    'limit set to 0.00000000000000001 ETH · balance 0.00000000000000001 ETH',
  );
  assert.equal(
    describeResult('game.receipt', { id: 'op-2', kind: 'bet', status: 'refunded', payout: '0', reason: 'Unsettled' }),
    'bet refunded · paid 0.0 ETH · “Unsettled” · op-2',
  );
  assert.match(describeResult('wallet.info', { bankroll: '2', uname: 'k3m9', alias: 'Bob' }), /@Bob/);
  assert.match(describeResult('wallet.info', { bankroll: '2', uname: 'k3m9', alias: null }), /~k3m9/);
  assert.equal(
    describeResult('wallet.hello', { methods: ['wallet.hello', 'game.bet'], asset: { symbol: 'ETH', decimals: 18 } }),
    '2 methods · ETH with 18 decimals',
  );
  assert.equal(describeResult('game.bet', null), '');
});
