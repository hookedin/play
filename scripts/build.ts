import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');

/**
 * Build the wallet into dist/, the directory a static host serves as is, and return the settings it ships with.
 * Our own modules become one readable main.js with a source map. Two files stay separate so they can be checked
 * on their own: vendor/ethers.js is byte-identical to the npm release, and config.js is the deployment's settings.
 */
export async function buildWallet() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, 'vendor'), { recursive: true });

  await build({
    entryPoints: [path.join(root, 'client/main.ts')],
    outfile: path.join(dist, 'main.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    legalComments: 'inline',
    plugins: [
      {
        name: 'separate-files',
        setup(build) {
          build.onResolve({ filter: /^ethers$/ }, () => ({ path: '/vendor/ethers.js', external: true }));
          build.onResolve({ filter: /\/config\.ts$/ }, args =>
            args.importer.endsWith(path.join('client', 'main.ts')) ? { path: '/config.js', external: true } : null,
          );
        },
      },
    ],
  });

  // Wherever ethers is installed (here, or a parent checkout using this repository as a submodule).
  const ethers = fileURLToPath(new URL('../dist/ethers.min.js', import.meta.resolve('ethers')));
  fs.copyFileSync(ethers, path.join(dist, 'vendor/ethers.js'));
  for (const file of ['index.html', 'style.css'])
    fs.copyFileSync(path.join(root, 'client', file), path.join(dist, file));
  fs.cpSync(path.join(root, 'brand'), path.join(dist, 'brand'), { recursive: true, filter: f => !f.endsWith('.md') });
  fs.copyFileSync(path.join(root, 'client/_headers'), path.join(dist, '_headers'));

  // HOOKEDIN_CLIENT_CONFIG names a JSON file with this deployment's settings; without it the defaults ship.
  const configFile = process.env.HOOKEDIN_CLIENT_CONFIG;
  const config = configFile
    ? JSON.parse(fs.readFileSync(configFile, 'utf8'))
    : (await import('../client/config.ts')).default;
  fs.writeFileSync(path.join(dist, 'config.js'), `export default ${JSON.stringify(config)};\n`);
  return config;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(`Built wallet for ${(await buildWallet()).network} into dist/`);
