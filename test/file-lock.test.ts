import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireFileLock } from '../protocol/file-lock.ts';

/** Two processes running `source` at once; resolves with the first line each prints. */
async function contenders(t: any, source: any, args: any) {
  const children: any[] = [];
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit');
        child.kill();
        await ended;
      }
  });
  return Promise.all(
    [0, 1].map(
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          children.push(child);
          let out = '',
            err = '';
          const timer = setTimeout(() => reject(new Error('Lock contender timed out: ' + err)), 10000);
          child.stdout.on('data', data => {
            out += data;
            if (out.includes('\n')) {
              clearTimeout(timer);
              try {
                resolve(JSON.parse(out.split('\n')[0]));
              } catch (e) {
                reject(e);
              }
            }
          });
          child.stderr.on('data', data => {
            err += data;
          });
          child.on('error', error => {
            clearTimeout(timer);
            reject(error);
          });
        }),
    ),
  );
}

test('one process holds a lock file at a time, and a stale lock is never removed automatically', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookedin-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const moduleURL = new URL('../protocol/file-lock.ts', import.meta.url).href;
  const source = `import { acquireFileLock } from ${JSON.stringify(moduleURL)};
    try { acquireFileLock(process.argv[1]); console.log(JSON.stringify({ acquired: true })); }
    catch (error) { console.log(JSON.stringify({ acquired: false, error: error.message })); }
    setInterval(() => {}, 1000);`;
  const live = await contenders(t, source, [path.join(dir, 'live')]);
  assert.equal(live.filter(r => (r as any).acquired).length, 1);
  const dead = spawn(process.execPath, ['-e', '']);
  await once(dead, 'exit');
  const file = path.join(dir, 'stale');
  fs.writeFileSync(file, String(dead.pid));
  const inode = fs.statSync(file).ino;
  const stale = await contenders(t, source, [file]);
  assert.equal(stale.filter(r => (r as any).acquired).length, 0);
  assert.ok(stale.every(r => /Stale lock.*supervised removal/.test((r as any).error)));
  assert.equal(fs.statSync(file).ino, inode);
  fs.unlinkSync(file); // The documented supervised restart procedure.
  const reclaimed = acquireFileLock(file);
  assert.throws(() => acquireFileLock(file), /holds the lock/);
  reclaimed();
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(path.join(dir, 'partial'), '');
  assert.throws(() => acquireFileLock(path.join(dir, 'partial')), /Incomplete lock/);
  fs.symlinkSync(file, path.join(dir, 'symlink'));
  assert.throws(() => acquireFileLock(path.join(dir, 'symlink')), /Invalid lock/);
  fs.symlinkSync(dir, path.join(dir, 'alias'));
  const unlock = acquireFileLock(path.join(dir, 'canonical'));
  assert.throws(() => acquireFileLock(path.join(dir, 'alias', 'canonical')), /holds the lock/);
  unlock();
  const next = acquireFileLock(path.join(dir, 'canonical'));
  unlock();
  assert.ok(fs.existsSync(path.join(dir, 'canonical')));
  next();
});
