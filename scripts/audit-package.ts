import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import artifact from '../client/contract-artifact.ts';
const compiled = JSON.parse(fs.readFileSync('build/contracts.json', 'utf8'));
const compilerInput = JSON.parse(fs.readFileSync('build/compile-input.json', 'utf8'));
if (
  artifact.runtime !==
  '0x' + compiled.contracts['contracts/HookedInCasino.sol'].HookedInCasino.evm.deployedBytecode.object
)
  throw new Error('Wallet artifact differs from compiled settlement runtime');
for (const [file, source] of Object.entries(compilerInput.sources as Record<string, { content: string }>))
  if (source.content !== fs.readFileSync(file, 'utf8'))
    throw new Error('Compile current contract sources before packaging');
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const target = path.resolve(
  process.argv[2] || `build/releases/${version}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
if (fs.existsSync(target) && fs.readdirSync(target).length)
  throw new Error('Use a fresh release directory; previous packages are immutable');
fs.mkdirSync(target, { recursive: true });
// The sources are every file git tracks, as the working tree holds them.
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of files) {
  const destination = path.join(target, 'sources', file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(file, destination);
}
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
// The report `npm test` writes: the gas each settlement path used.
const reports = ['settlement-gas.json'].filter(file => fs.existsSync(path.join('build', file)));
for (const file of reports) {
  fs.mkdirSync(path.join(target, 'verification'), { recursive: true });
  fs.copyFileSync(path.join('build', file), path.join(target, 'verification', file));
}
const manifest = {
  createdAt: new Date().toISOString(),
  version,
  compiler: compiled.compiler,
  compileInputSha256: hash(fs.readFileSync('build/compile-input.json')),
  compilerOutputSha256: hash(fs.readFileSync('build/contracts.json')),
  runtimeTemplateSha256: hash(artifact.runtime),
  validationNotice:
    'Reports retain their own dates and scope. Packaging hashes are provenance, not proof of independent review or infrastructure readiness.',
  sourceFiles: Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(file))])),
  verification: ['npm run build', 'npm test'],
  verificationReports: Object.fromEntries(reports.map(file => [file, hash(fs.readFileSync(path.join('build', file)))])),
  architecture: 'docs/overview/architecture.md',
  excludes:
    'Only the files git tracks are collected, so private keys, private databases, signing logs, local environment files and node_modules never are.',
};
const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
fs.writeFileSync(path.join(target, 'source-manifest.json'), manifestBytes);
fs.writeFileSync(path.join(target, 'contracts.json'), fs.readFileSync('build/contracts.json'));
fs.copyFileSync('build/compile-input.json', path.join(target, 'compile-input.json'));
console.log(JSON.stringify({ directory: target, sourceFiles: files.length, manifestSha256: hash(manifestBytes) }));
