import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { anvil, deployment, signedIncrease, open, step } from '../testing/contract.ts';
import { json } from '../protocol/protocol.ts';
test('independent CLI closes, challenges, finalizes and collects without casino API or channel key', async t => {
  const env = await anvil();
  t.after(() => env.close());
  const f = await deployment(env),
    ch = await open(f, env.wallets[1], 1000n, {
      signer: env.wallets[4].address,
    }),
    credit = await signedIncrease(f, { ...ch, player: env.wallets[4] }, 500n);
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
  const bundle = {
    chainId: 31337,
    casino: await f.contract.getAddress(),
    operator: f.owner.address,
    opening: ch.opening,
    evidence: ch.evidence,
  };
  fs.writeFileSync(evidenceFile, json(bundle));
  fs.writeFileSync(walletFile, json({ wallets: { player: { privateKey: env.wallets[1].privateKey } } }), {
    mode: 0o600,
  });
  async function cli(action: any) {
    return new Promise((resolve, reject) => {
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
        ],
        { cwd: recoveryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '',
        error = '';
      child.stdout.on('data', v => (output += v));
      child.stderr.on('data', v => (error += v));
      child.once('error', reject);
      child.once('exit', code =>
        code === 0 ? resolve(JSON.parse(output.trim().split('\n').at(-1) as any)) : reject(new Error(error)),
      );
    });
  }
  assert.equal(((await cli('start')) as any).channelStatus, '2');
  bundle.evidence = credit.evidence;
  fs.writeFileSync(evidenceFile, json(bundle));
  assert.equal(((await cli('challenge')) as any).closingSequence, '1');
  const deadline = (await f.contract.channels(ch.state.channelId)).deadline;
  await env.provider.send('evm_setNextBlockTimestamp', [Number(deadline)]);
  await env.provider.send('evm_mine', []);
  const finalized = await cli('finalize');
  assert.equal((finalized as any).claim.paid, '0');
  assert.equal((finalized as any).remaining, '1500');
  await (await f.contract.fundBankroll({ value: 500n })).wait();
  const collected = await cli('claim');
  assert.equal((collected as any).claim.paid, '1500');
  assert.equal((collected as any).remaining, '0');
  assert.equal(((await cli('inspect')) as any).paymentStatus, 'no unpaid amount');
});
