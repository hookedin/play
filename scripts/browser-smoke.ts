import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { createStaticServer } from './static.ts';
const app = createStaticServer(fileURLToPath(new URL('../dist', import.meta.url)));
/** A browser test is bundled like the wallet itself: our modules inline, ethers from the served release. */
const testScript = (name: string) =>
  buildSync({
    entryPoints: [fileURLToPath(new URL(`../test/${name}.ts`, import.meta.url))],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    alias: { ethers: '/vendor/ethers.js' },
    external: ['/vendor/ethers.js'],
  }).outputFiles[0].text;
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/__test-funding?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><title>HookedIn two-tab funding validation</title><pre id="result">Waiting for the other test tab…</pre><script type="module" src="/__test-funding.js"></script>',
    );
  } else if (req.url === '/__test-funding.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(testScript('browser-funding'));
  } else if (req.url === '/__test') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self'; worker-src 'self'; object-src 'none'",
    });
    res.end(
      '<!doctype html><title>HookedIn browser validation</title><pre id="result">Running browser wallet and IndexedDB checks…</pre><script type="module" src="/__test.js"></script>',
    );
  } else if (req.url === '/__test.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(testScript('browser-smoke'));
  } else app.emit('request', req, res);
});
server.listen(Number(process.env.PORT || 14187), '127.0.0.1');
