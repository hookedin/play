import test from 'node:test';
import assert from 'node:assert/strict';
import { activityJSON, developerBetSummary, receiptSummary } from '../client/activity.ts';
import type { PlayerDeveloperBet } from '../protocol/types.ts';

const contract = '0x4444444444444444444444444444444444444444';

test('a developer bet shows its result apart from its collection, and a zero payout as settled', () => {
  const bet: PlayerDeveloperBet = {
    bet: '0x' + '1'.repeat(64),
    game: '0x' + '2'.repeat(64),
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
  const open = receiptSummary(receipt, contract);
  assert.deepEqual([open.status, open.title], ['Waiting for the developer', 'Developer bet placed']);
  assert.match(open.description!, /what it pays is their word/);
  const lost = receiptSummary({ ...receipt, payout: '0' }, contract);
  assert.deepEqual([lost.status, lost.title], ['Settled · no payout', 'Developer bet lost']);
  const even = receiptSummary({ ...receipt, payout: '10' }, contract);
  assert.deepEqual([even.status, even.title], ['Payout collected', 'Developer bet broke even']);
  const won = receiptSummary({ ...receipt, payout: '25' }, contract);
  assert.deepEqual([won.status, won.title], ['Payout collected', 'Developer bet won']);
});

test('bet summaries show the payout against the stake in METH, cut at a gwei, never rounded up', () => {
  const receipt = {
    kind: 'casino-bet',
    status: 'signed',
    stake: '1000000000000000',
    payout: '2234567890123456',
    maxPayout: '5000000000000000',
    expectedPayout: String(((1n << 64n) * 1000000000000000n * 97n) / 100n),
    balance: '999999999999999999',
  };
  const win = receiptSummary(receipt, contract);
  assert.equal(win.amount, '+1,234.567 METH');
  assert.equal(win.status, 'Signed off-chain');
  assert.match(win.description!, /Balance 999,999\.999999999999 METH/);
  assert.equal(win.amountLabel, 'Net game result');
  assert.equal(win.title, 'Casino bet won');
  assert.match(win.description!, /Paid 2,234\.567 METH of up to 5,000 METH · RTP 97.0000%/);
  const loss = receiptSummary({ ...receipt, payout: '0', stake: '1' }, contract);
  assert.equal(loss.amount, '−<0.001 METH');
  assert.equal(loss.tone, 'negative');
  // A prize below the stake is a partial loss, and a prize equal to it moves nothing.
  const partial = receiptSummary({ ...receipt, payout: '400000000000000' }, contract);
  assert.deepEqual([partial.title, partial.amount, partial.tone], ['Casino bet lost', '−600 METH', 'negative']);
  const even = receiptSummary({ ...receipt, payout: receipt.stake }, contract);
  assert.deepEqual([even.title, even.amount, even.tone], ['Casino bet broke even', '+0 METH', 'neutral']);
});

test('reorged, reverted, replaced and unknown receipts never advertise a confirmed payment', () => {
  for (const status of ['orphaned', 'reverted', 'replaced', 'pending', undefined]) {
    const summary = receiptSummary({ kind: 'withdrawal', amount: '1000000000000000000', status }, contract);
    assert.equal(summary.amount, '0 METH');
    assert.equal(summary.amountLabel, 'No confirmed payment');
    assert.notEqual(summary.tone, 'positive');
    if (status === 'orphaned') assert.match(summary.notice!, /no longer confirmed/);
  }
  const rejected = receiptSummary(
    { status: 'rejected', kind: 'casino-bet', amount: '100', reason: 'Capacity too low' },
    contract,
  );
  assert.deepEqual([rejected.status, rejected.amount, rejected.notice], ['Nothing paid', '0 METH', 'Capacity too low']);
});

test('closures and actual collections remain distinct from off-chain payments', () => {
  const closure = receiptSummary({ kind: 'closure', amount: '1500000000000', status: 'confirmed' }, contract);
  assert.deepEqual([closure.amount, closure.amountLabel], ['1.5 METH', 'Claim recorded']);
  assert.match(closure.notice!, /Collect it under Wallet → Waiting to be paid/);
  assert.equal(
    receiptSummary({ kind: 'withdrawal', amount: '123', status: 'confirmed' }, contract).amountLabel,
    'Paid out',
  );
  // Starting or challenging a close moves no ETH.
  for (const kind of ['close-started', 'dispute'])
    assert.equal(receiptSummary({ kind, amount: '0', status: 'confirmed' }, contract).amountLabel, 'No payment');
  const payment = receiptSummary({ kind: 'payment', amount: '123', status: 'signed', balance: '456' }, contract);
  assert.equal(payment.amountLabel, 'Sent');
  assert.equal(payment.status, 'Signed off-chain');
  assert.match(
    payment.description!,
    /A payment this game charged, paid into the casino's bankroll\. Balance 0\.000000000456 METH/,
  );
});

test('receipt JSON handles bigint and malformed payloads', () => {
  assert.deepEqual(JSON.parse(activityJSON({ value: 123n })), { value: '123' });
  const circular: any = {};
  circular.self = circular;
  assert.match(activityJSON(circular), /could not be displayed/);
});

test('a withdrawal reads as paid once paid, and one paying the contract as going into the channel as deposits', () => {
  const sent = {
    kind: 'withdrawal',
    status: 'signed',
    withdrawal: '0x' + 'a'.repeat(64),
    to: '0x3333333333333333333333333333333333333333',
    amount: '1500',
    balance: '0',
  };
  const paid = receiptSummary({ ...sent, recorded: true, paid: true, owed: '0' }, contract);
  assert.deepEqual([paid.title, paid.status, paid.amountLabel], ['Withdrawn', 'Paid on-chain', 'Paid out']);
  assert.match(paid.description!, /^From your balance to 0x3333.*\. The contract has paid it\. Balance 0 METH$/);
  const lockIn = { ...sent, kind: 'lock-in', to: contract },
    waiting = receiptSummary(lockIn, contract),
    locked = receiptSummary({ ...lockIn, recorded: true, paid: true, owed: '0' }, contract);
  assert.deepEqual([waiting.title, waiting.status, waiting.tone], ['Locking in', 'Waiting to be paid', 'warning']);
  assert.deepEqual(
    [locked.title, locked.status, locked.amountLabel, locked.tone],
    ['Balance locked in', 'In as deposits', 'Locked in', 'positive'],
  );
  assert.match(locked.description!, /^All of your balance into your own channel, as deposits the contract holds\./);
  // A withdrawal whose claim its account collects into the contract names that, not the address it first paid.
  const redirected = receiptSummary({ ...sent, to: contract, recorded: true, owed: '500' }, contract);
  assert.match(redirected.description!, /^From your balance into your own channel, as deposits the contract holds\./);
  // One that paid the casino its fee for sending it says so.
  const paying = receiptSummary({ ...sent, fee: '2' }, contract);
  assert.match(paying.description!, /Your balance paid the casino .* METH for sending it\./);
});

test('a transfer reads as sent to the player it named, and one collected as received from the player who sent it', () => {
  const bob = '~3byt9ocwnnzaxanmiz3stocj',
    sent = receiptSummary(
      {
        kind: 'transfer',
        status: 'signed',
        amount: '1500',
        balance: '500',
        name: '@bob',
        details: { id: '0x' + 'c'.repeat(64), counterparty: bob },
      },
      contract,
    );
  assert.deepEqual([sent.title, sent.amountLabel, sent.tone], ['Transferred', 'Sent', 'neutral']);
  assert.match(
    sent.description!,
    /^To @bob, off-chain: .* nothing about it goes on-chain\. Balance 0\.0000000005 METH$/,
  );
  // A receipt without the name it went by names the uname.
  const unnamed = receiptSummary(
    { kind: 'transfer', status: 'signed', amount: '1', details: { counterparty: bob } },
    contract,
  );
  assert.match(unnamed.description!, new RegExp(`^To ${bob},`));
  const received = receiptSummary(
    {
      kind: 'transfer-in',
      status: 'signed',
      amount: '1500',
      balance: '2000',
      name: '@alice',
      details: { id: '0x' + 'd'.repeat(64), counterparty: '~' + 'k'.repeat(24) },
    },
    contract,
  );
  assert.deepEqual(
    [received.title, received.amountLabel, received.tone],
    ['Transfer received', 'Received', 'positive'],
  );
  assert.match(received.description!, /^From @alice, collected into your balance\./);
});

test("a deposit's network fee reads as paid into the balance by the casino", () => {
  const paid = receiptSummary(
    { kind: 'deposit-fee', status: 'signed', amount: '5', details: { id: '0x' + 'b'.repeat(64) }, balance: '15' },
    contract,
  );
  assert.deepEqual([paid.title, paid.amountLabel, paid.tone], ['Network fee paid', 'Received', 'positive']);
  assert.match(paid.description!, /which the casino paid into your balance/);
});

test('ETH arriving at the address and what a deposit adds each read as their own step', () => {
  const received = receiptSummary({ kind: 'received', status: 'confirmed', amount: '2000000000000000000' }, contract);
  assert.deepEqual(
    [received.title, received.amount, received.amountLabel],
    ['Received at your address', '2,000,000 METH', 'ETH received'],
  );
  const added = receiptSummary({ kind: 'taken-in', status: 'signed', amount: '5000000000000', balance: '5' }, contract);
  assert.deepEqual([added.title, added.amount, added.amountLabel], ['Added to your balance', '5 METH', 'Added']);
});
