import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, ZeroAddress } from 'ethers';
import { validateWithdrawal } from '../client/withdrawal.ts';

const input = {
  destination: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
  ownAddress: '0x1111111111111111111111111111111111111111',
  amount: '0.01',
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
  for (const amount of ['1.0000000000000000000', '0.0000000000000000001']) {
    const result = validateWithdrawal({ ...input, amount });
    assert.equal(result.amount, null, 'a nineteenth decimal must never be rounded');
    assert.match(result.error!, /18 decimal/);
  }
  for (const amount of ['0.000000000000000001', '.5', ' 1.0 ', '2', '2.']) {
    const result = validateWithdrawal({ ...input, amount });
    assert.equal(result.amount, parseEther(amount.trim()));
    assert.equal(result.error, null);
  }
  const excess = validateWithdrawal({ ...input, amount: '2.000000000000000001' });
  assert.equal(excess.amount, parseEther('2.000000000000000001'));
  assert.match(excess.error!, /At most 2 ETH can be withdrawn\./);
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
