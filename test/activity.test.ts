import test from 'node:test';
import assert from 'node:assert/strict';
import { activityJSON, developerBetSummary, receiptSummary, receiptUnit } from '../client/activity.ts';
import type { PlayerDeveloperBet } from '../protocol/types.ts';

test('a developer bet shows its result apart from its collection, and a zero payout as settled', () => {
  const bet: PlayerDeveloperBet = {
    bet: '0x' + '1'.repeat(64),
    game: '0x' + '2'.repeat(64),
    asset: 'test',
    status: 'open',
    stake: '10',
    collected: false,
  };
  assert.equal(developerBetSummary(bet).status, 'Waiting for the developer');
  const settled = { ...bet, status: 'settled' as const, payout: '20' };
  assert.equal(developerBetSummary(settled).status, 'Payout ready');
  assert.equal(developerBetSummary(settled).amountLabel, 'Awaiting collection');
  assert.equal(developerBetSummary({ ...settled, payout: '0' }).status, 'Settled · no payout');
  assert.equal(developerBetSummary({ ...settled, collected: true }).status, 'Payout collected');
  const receipt = {
    kind: 'developer-bet',
    status: 'signed',
    balance: '100',
    amount: '10',
    stake: '10',
    details: { meta: { pick: 'home' } },
  };
  const open = receiptSummary(receipt);
  assert.deepEqual([open.status, open.title], ['Waiting for the developer', 'Developer bet placed']);
  assert.match(open.description!, /what it pays is their word/);
  const lost = receiptSummary({ ...receipt, payout: '0' });
  assert.deepEqual([lost.status, lost.title], ['Settled · no payout', 'Developer bet lost']);
  const even = receiptSummary({ ...receipt, payout: '10' });
  assert.deepEqual([even.status, even.title], ['Payout collected', 'Developer bet broke even']);
  const won = receiptSummary({ ...receipt, payout: '25' });
  assert.deepEqual([won.status, won.title], ['Payout collected', 'Developer bet won']);
});

test('bet summaries show the payout against the stake and retain exact wei amounts', () => {
  const receipt = {
    kind: 'casino-bet',
    status: 'signed',
    stake: '1000000000000000',
    payout: '2234567890123456',
    maxPayout: '5000000000000000',
    expectedPayout: String(((1n << 64n) * 1000000000000000n * 97n) / 100n),
    balance: '999999999999999999',
  };
  const win = receiptSummary(receipt);
  assert.equal(win.amount, '+0.001234567890123456 ETH');
  assert.equal(win.status, 'Signed off-chain');
  assert.match(win.description!, /Balance 0.999999999999999999 ETH/);
  assert.equal(win.amountLabel, 'Net game result');
  assert.equal(win.title, 'Casino bet won');
  assert.match(win.description!, /Paid 0.002234567890123456 ETH of up to 0.005 ETH · RTP 97.0000%/);
  const loss = receiptSummary({ ...receipt, payout: '0', stake: '1' });
  assert.equal(loss.amount, '−0.000000000000000001 ETH');
  assert.equal(loss.tone, 'negative');
  // A prize below the stake is a partial loss, and a prize equal to it moves nothing.
  const partial = receiptSummary({ ...receipt, payout: '400000000000000' });
  assert.deepEqual([partial.title, partial.amount, partial.tone], ['Casino bet lost', '−0.0006 ETH', 'negative']);
  const even = receiptSummary({ ...receipt, payout: receipt.stake });
  assert.deepEqual([even.title, even.amount, even.tone], ['Casino bet broke even', '+0.0 ETH', 'neutral']);
});

test('reorged, reverted, replaced and unknown receipts never advertise a confirmed payment', () => {
  for (const status of ['orphaned', 'reverted', 'replaced', 'pending', undefined]) {
    const summary = receiptSummary({ kind: 'withdrawal', amount: '1000000000000000000', status });
    assert.equal(summary.amount, '0.0 ETH');
    assert.equal(summary.amountLabel, 'No confirmed payment');
    assert.notEqual(summary.tone, 'positive');
    if (status === 'orphaned') assert.match(summary.notice!, /no longer confirmed/);
  }
});

test('closures and actual collections remain distinct from off-chain payments', () => {
  const closure = receiptSummary({ kind: 'closure', amount: '0', status: 'confirmed' });
  assert.equal(closure.amount, '0.0 ETH');
  assert.match(closure.notice!, /Collect available funds separately/);
  assert.equal(receiptSummary({ kind: 'withdrawal', amount: '123', status: 'confirmed' }).amountLabel, 'Received');
  const payment = receiptSummary({ kind: 'payment', amount: '123', status: 'signed', balance: '456' });
  assert.equal(payment.amountLabel, 'Sent');
  assert.equal(payment.status, 'Signed off-chain');
  assert.match(
    payment.description!,
    /A payment this game charged, paid into the casino's bankroll\. Balance 0\.000000000000000456 ETH/,
  );
});

test('diagnostic JSON handles bigint, malformed payloads and explicit preview truncation', () => {
  assert.deepEqual(JSON.parse(activityJSON({ value: 123n })), { value: '123' });
  const circular: any = {};
  circular.self = circular;
  assert.match(activityJSON(circular), /could not be displayed/);
  const long = { data: 'x'.repeat(100) };
  assert.match(activityJSON(long, 30), /truncated at 30 characters/);
  assert.deepEqual(JSON.parse(activityJSON(long)), long, 'Saved receipt JSON is never truncated by default');
});

test('a receipt is read in the asset of the channel that signed it', () => {
  assert.equal(receiptUnit({ asset: 'test' }), 'TEST');
  assert.equal(receiptUnit({ asset: 'eth' }), 'ETH');
  // On-chain rows carry no asset and are always ETH.
  assert.equal(receiptUnit({}), 'ETH');
  const bet = {
    kind: 'casino-bet',
    status: 'signed',
    asset: 'test',
    stake: '2000000000000000000',
    payout: '0',
    maxPayout: '19800000000000000000',
    expectedPayout: String(((1n << 64n) * 2000000000000000000n * 99n) / 100n),
    balance: '114800000000000000000',
  };
  assert.equal(receiptSummary(bet).amount, '−2.0 TEST');
  assert.match(receiptSummary(bet).description!, /Stake 2.0 TEST · Paid 0.0 TEST/);
});
