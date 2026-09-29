import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { anvil, deployment, signedIncrease, open, step, countersigned } from '../testing/contract.ts';
import { json, hashOperation } from '../protocol/protocol.ts';
/** The recovery CLI as a released checkout runs it, with the player's key: `cli(bundle, action, ...flags)` writes the
 * bundle, runs the action and returns the inspection it prints last. */
function recoveryCLI(t: any, env: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookedin-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Recovery uses the archived wallet artifact without compiler output.
  const recoveryRoot = path.join(dir, 'release');
  fs.mkdirSync(path.join(recoveryRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(recoveryRoot, 'client'));
  fs.cpSync('protocol', path.join(recoveryRoot, 'protocol'), { recursive: true });
  fs.copyFileSync('client/contract-artifact.ts', path.join(recoveryRoot, 'client/contract-artifact.ts'));
  fs.copyFileSync('scripts/verify-evidence.ts', path.join(recoveryRoot, 'scripts/verify-evidence.ts'));
  // The node_modules that provides ethers: this checkout's own, or its parent's when play is a submodule.
  const modules = fileURLToPath(import.meta.resolve('ethers')).replace(/(.*[\\/]node_modules)[\\/].*/, '$1');
  fs.symlinkSync(modules, path.join(recoveryRoot, 'node_modules'));
  const evidenceFile = path.join(dir, 'evidence.json'),
    walletFile = path.join(dir, 'wallet.json'),
    journal = path.join(dir, 'journal.json');
  fs.writeFileSync(walletFile, json({ wallets: { player: { privateKey: env.wallets[1].privateKey } } }), {
    mode: 0o600,
  });
  return (bundle: any, action: string, ...flags: string[]) => {
    fs.writeFileSync(evidenceFile, json(bundle));
    return new Promise<any>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          'scripts/verify-evidence.ts',
          evidenceFile,
          '--rpc',
          env.url,
          '--action',
          action,
          '--wallet-file',
          walletFile,
          '--journal',
          journal,
          ...flags,
        ],
        { cwd: recoveryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '',
        error = '';
      child.stdout.on('data', v => (output += v));
      child.stderr.on('data', v => (error += v));
      child.once('error', reject);
      child.once('exit', code =>
        code === 0 ? resolve(JSON.parse(output.trim().split('\n').at(-1)!)) : reject(new Error(error)),
      );
    });
  };
}
test('independent CLI closes, challenges, finalizes and collects without the casino API', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    ch = await open(f, env.wallets[1], 1000n),
    credit = await signedIncrease(f, ch, 500n),
    cli = recoveryCLI(t, env);
  const bundle = {
    chainId: 31337,
    casino: await f.contract.getAddress(),
    operator: f.owner.address,
    opening: ch.opening,
    evidence: ch.evidence,
  };
  assert.equal((await cli(bundle, 'start')).channelStatus, '2');
  bundle.evidence = credit.evidence;
  assert.equal((await cli(bundle, 'challenge')).closingSequence, '2');
  const deadline = (await f.contract.channels(ch.state.channelId)).deadline;
  await env.provider.send('evm_setNextBlockTimestamp', [Number(deadline)]);
  await env.provider.send('evm_mine', []);
  const finalized = await cli(bundle, 'finalize');
  assert.equal(finalized.claim.paid, '0');
  assert.equal(finalized.remaining, '1500');
  await (await f.contract.fundBankroll({ value: 500n })).wait();
  const collected = await cli(bundle, 'claim');
  assert.equal(collected.claim.paid, '1500');
  assert.equal(collected.remaining, '0');
  assert.equal((await cli(bundle, 'inspect')).paymentStatus, 'no unpaid amount');
});

test('the CLI inspects and collects a withdrawal the bundle lists, which a close of an empty balance leaves owed', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    recipient = Wallet.createRandom().address,
    ch = await open(f, env.wallets[1], 1000n),
    won = { ...ch, ...(await signedIncrease(f, ch, 500n)) },
    cli = recoveryCLI(t, env);
  // All of a winning balance withdrawn with no house cash: the deposits pay 1000 at once, and 500 of winnings stay owed
  // under the withdrawal's own ID. The channel's close is owed nothing.
  const out = await step(f, won, 5, 1500n, { recipient }),
    withdrawal = hashOperation(f.d, out.evidence.step.operation);
  await (await f.contract.withdraw(out.evidence)).wait();
  const bundle = {
    chainId: 31337,
    casino: await f.contract.getAddress(),
    operator: f.owner.address,
    opening: ch.opening,
    evidence: await countersigned(f, won, out),
    withdrawals: [withdrawal],
  };
  await cli(bundle, 'start');
  await env.provider.send('evm_increaseTime', [86401]);
  await env.provider.send('evm_mine', []);
  const closed = await cli(bundle, 'finalize');
  assert.deepEqual([closed.paymentStatus, closed.remaining], ['no unpaid amount', '0']);
  assert.deepEqual(closed.withdrawals, [
    {
      id: withdrawal,
      recipient,
      remaining: '500',
      collectable: '0',
      paymentStatus: 'unpaid; house cash does not reach it yet',
    },
  ]);
  // Nothing collectable sends nothing; once house cash reaches it, collecting pays the withdrawal's recipient.
  assert.equal((await cli(bundle, 'claim', '--claim', withdrawal)).withdrawals[0].remaining, '500');
  await (await f.contract.fundBankroll({ value: 500n })).wait();
  const collected = await cli(bundle, 'claim', '--claim', withdrawal);
  assert.deepEqual(
    [collected.withdrawals[0].remaining, collected.withdrawals[0].paymentStatus],
    ['0', 'no unpaid amount'],
  );
  assert.equal(await env.provider.getBalance(recipient), 1500n);
  await assert.rejects(cli(bundle, 'claim', '--claim', '0x' + '1'.repeat(64)), /lists no withdrawal/);
});
