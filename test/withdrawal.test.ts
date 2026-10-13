import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, parseUnits, ZeroAddress } from 'ethers';
import { inUnit, typedIn, validateWithdrawal } from '../client/withdrawal.ts';

const input = {
  destination: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
  ownAddress: '0x1111111111111111111111111111111111111111',
  amount: '10000',
  maximum: parseEther('2'),
  channel: true,
};

test('channel withdrawal requires an explicit positive decimal amount without rounding', () => {
  for (const amount of [
    '',
    ' ',
    '0',
    '0.000',
    '-1',
    '+1',
    '1e-3',
    '0x10',
    '1,000',
    'NaN',
    'Infinity',
    '1.1.1',
    '9'.repeat(1000),
  ]) {
    const result = validateWithdrawal({ ...input, amount });
    assert.equal(result.amount, null, amount);
    assert.ok(result.error, amount);
  }
  // In METH, as the wallet counts, or in ETH: a decimal past the wei is never rounded.
  for (const [unit, amount, decimals] of [
    ['METH', '1.0000000000000', 12],
    ['METH', '0.0000000000001', 12],
    ['ETH', '0.0000000000000000001', 18],
  ] as const) {
    const result = validateWithdrawal({ ...input, unit, amount });
    assert.equal(result.amount, null, 'a decimal past the wei must never be rounded');
    assert.match(result.error!, new RegExp(`in ${unit} above zero, with at most ${decimals} decimal`));
  }
  for (const amount of ['0.000000000001', '.5', ' 1.0 ', '2', '2.']) {
    const result = validateWithdrawal({ ...input, amount });
    assert.equal(result.amount, parseUnits(amount.trim(), 12));
    assert.equal(result.error, null);
  }
  assert.equal(validateWithdrawal({ ...input, unit: 'ETH', amount: '0.000000000000000001' }).amount, 1n);
  const excess = validateWithdrawal({ ...input, amount: '2000000.000000000001' });
  assert.equal(excess.amount, parseEther('2.000000000000000001'));
  assert.match(excess.error!, /At most 2,000,000 METH can be withdrawn\./);
  assert.match(validateWithdrawal({ ...input, unit: 'ETH', amount: '2.1' }).error!, /At most 2 ETH can be withdrawn\./);
});

test('an amount reads the same in either unit', () => {
  const wei = parseEther('0.0123456789');
  assert.equal(inUnit(wei, 'METH'), '12,345.6789');
  assert.equal(inUnit(wei, 'METH', true), '12345.6789');
  assert.equal(inUnit(wei, 'ETH'), '0.0123456789');
  assert.equal(inUnit(parseEther('1'), 'ETH'), '1');
  assert.equal(typedIn(inUnit(wei, 'ETH'), 'ETH'), wei);
  assert.equal(typedIn(inUnit(wei, 'METH', true), 'METH'), wei);
  assert.equal(typedIn('0', 'ETH'), null);
});

test('withdrawal validates destination checksum and refuses zero and own addresses', () => {
  for (const destination of ['', '0x1234', input.destination.replace('8ba1', '8Ba1'), ZeroAddress, input.ownAddress])
    assert.ok(validateWithdrawal({ ...input, destination }).error, destination);
  for (const destination of [input.destination.toLowerCase(), ` ${input.destination} `]) {
    const result = validateWithdrawal({ ...input, destination });
    assert.equal(result.to, input.destination);
    assert.equal(result.error, null);
  }
  assert.match(
    validateWithdrawal({ ...input, contractAddress: input.destination.toLowerCase() }).error!,
    /casino contract/,
  );
  assert.match(
    validateWithdrawal({ ...input, ownAddress: input.destination.toLowerCase() }).error!,
    /your deposit address/,
  );
});

test('deposit-address withdrawal sweeps its funds minus network fees and ignores a hidden amount', () => {
  for (const amount of ['', '0', 'invalid', '999']) {
    const result = validateWithdrawal({ ...input, channel: false, amount });
    assert.equal(result.to, input.destination);
    assert.equal(result.amount, null, 'the transaction calculates the transferable amount after its fee');
    assert.equal(result.error, null);
  }
  assert.match(validateWithdrawal({ ...input, channel: false, maximum: 0n }).error!, /empty/);
});
