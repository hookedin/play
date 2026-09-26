import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRequest, describeResult } from '../client/game-log.ts';

test('bridge requests summarize their financial terms in one line', () => {
  const bet = describeRequest('game.casinoBet', {
    stake: '1000000000000000',
    chance: String((1n << 64n) / 2n),
    prize: '1990000000000000',
    id: 'round-7',
  });
  assert.match(bet, /stake 0\.001 ETH/);
  assert.match(bet, /pays 0\.00199 ETH on 50\.0000%/);
  assert.match(bet, /RTP 99\.5000%/);
  assert.match(
    describeRequest('game.casinoBet', { stake: '1', chance: 'nonsense', prize: '2', id: 'x' }),
    /unreadable odds/,
  );
  assert.match(bet, /id round-7/);
  assert.match(bet, /^casino bet · /);
  assert.equal(
    describeRequest('game.developerBet', { stake: '1', meta: { pick: 'home' }, group: 'match-9', id: 'p' }),
    "developer bet · stake 0.000000000000000001 ETH · on its developer's word · group match-9 · id p",
  );
  assert.equal(describeRequest('game.receipt', { id: 'round-7' }), 'id round-7');
  assert.equal(describeRequest('game.requestFunds', {}), 'no suggested amount');
  assert.equal(describeRequest('game.requestFunds', { amount: '5' }), 'suggests 0.000000000000000005 ETH');
  assert.equal(describeRequest('wallet.info', {}), '');
});

test('bridge replies summarize outcomes without exposing more than the reply itself', () => {
  assert.equal(
    describeResult('game.casinoBet', {
      id: 'op-1',
      kind: 'casino-bet',
      status: 'settled',
      payout: '3000',
    }),
    'casino-bet settled · paid 0.000000000000003 ETH · op-1',
  );
  assert.equal(
    describeResult('game.casinoBet', { id: 'op-3', kind: 'casino-bet', status: 'rejected', reason: 'Capacity' }),
    'casino-bet rejected · “Capacity” · op-3',
  );
  assert.equal(
    describeResult('game.developerBet', { id: 'op-4', kind: 'developer-bet', status: 'open' }),
    'developer-bet open · op-4',
  );
  assert.equal(
    describeResult('game.receipt', {
      id: 'op-4',
      kind: 'developer-bet',
      status: 'settled',
      payout: '7',
    }),
    "developer-bet settled · paid 0.000000000000000007 ETH · on its developer's word · op-4",
  );
  assert.equal(
    describeResult('game.requestFunds', { funded: true, amount: '10', balance: '10', pending: false }),
    'limit set to 0.00000000000000001 ETH · balance 0.00000000000000001 ETH',
  );
  assert.match(describeResult('wallet.info', { bankroll: '2', uname: 'k3m9', alias: 'Bob' }), /@Bob/);
  assert.match(describeResult('wallet.info', { bankroll: '2', uname: 'k3m9', alias: null }), /~k3m9/);
  assert.equal(
    describeResult('wallet.hello', {
      methods: ['wallet.hello', 'game.casinoBet'],
      asset: { symbol: 'ETH', decimals: 18 },
    }),
    '2 methods · ETH with 18 decimals',
  );
  assert.equal(describeResult('game.casinoBet', null), '');
});
