import test from 'node:test';
import assert from 'node:assert/strict';
import { activityJSON, receiptSummary, receiptUnit } from '../client/activity.ts';

test('bet summaries show the payout against the stake and retain exact wei amounts', () => {
  const receipt = {
    kind: 'bet',
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
  assert.equal(win.title, 'Bet won');
  assert.match(win.description!, /Paid 0.002234567890123456 ETH of up to 0.005 ETH · RTP 97.0000%/);
  const loss = receiptSummary({ ...receipt, payout: '0', stake: '1' });
  assert.equal(loss.amount, '−0.000000000000000001 ETH');
  assert.equal(loss.tone, 'negative');
  // A prize below the stake is a partial loss, and a prize equal to it moves nothing.
  const partial = receiptSummary({ ...receipt, payout: '400000000000000' });
  assert.deepEqual([partial.title, partial.amount, partial.tone], ['Bet lost', '−0.0006 ETH', 'negative']);
  const returned = receiptSummary({ ...receipt, payout: receipt.stake });
  assert.deepEqual([returned.title, returned.amount, returned.tone], ['Bet returned', '+0.0 ETH', 'neutral']);
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

test('closures and actual collections remain distinct from off-chain transfers', () => {
  const closure = receiptSummary({ kind: 'closure', amount: '0', status: 'confirmed' });
  assert.equal(closure.amount, '0.0 ETH');
  assert.match(closure.notice!, /Collect available funds separately/);
  assert.equal(receiptSummary({ kind: 'withdrawal', amount: '123', status: 'confirmed' }).amountLabel, 'Received');
  const transfer = receiptSummary({ kind: 'transfer', amount: '123', status: 'signed', balance: '456' });
  assert.equal(transfer.amountLabel, 'Sent');
  assert.equal(transfer.status, 'Signed off-chain');
  assert.match(transfer.description!, /Paid to this game's developer\. Balance 0\.000000000000000456 ETH/);
  const payment = receiptSummary({ kind: 'payment', amount: '123', status: 'signed', balance: '456' });
  assert.match(payment.description!, /extra wager this game charged/);
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
    kind: 'bet',
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
