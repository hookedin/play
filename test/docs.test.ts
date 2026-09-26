/**
 * The docs say what the code does: every bridge method, every error a game can be given and every name the SDK
 * exports has its entry in the reference, and every relative link in this repository's Markdown reaches a file and,
 * with an anchor, a heading in it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import GithubSlugger from 'github-slugger';
import { METHODS } from '../client/bridge.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
/** Markdown with its fenced code blocks removed, which hold no headings and no links. */
const prose = (text: string) => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
/** The part of a Markdown text under the heading `## title`, up to the next `## `. */
function section(text: string, title: string) {
  const start = text.indexOf(`\n## ${title}\n`);
  assert.notEqual(start, -1, `no "## ${title}"`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}
/** The codes in the first column of a text's tables, header rows left out. */
const codes = (text: string) =>
  text
    .split('\n')
    .filter((line, i, lines) => !lines[i + 1]?.startsWith('| -'))
    .flatMap(line => /^\| `([a-z-]+)`\s*\|/.exec(line)?.[1] ?? []);
/** The names of a text's `### \`name\`` entries. */
const entries = (text: string) => [...prose(text).matchAll(/^### `([^`]+)`$/gm)].map(match => match[1]).sort();

test('every bridge method has its entry', () => {
  assert.deepEqual(entries(section(read('docs/reference/bridge.md'), 'Methods')), [...METHODS].sort());
});

test('every error a game can be given is in the table, and nothing else', () => {
  const documented = codes(section(read('docs/reference/bridge.md'), 'Errors'));
  // A code the wallet does not know reaches the game as `failed`.
  const raised = new Set(['failed']);
  for (const file of fs.readdirSync(path.join(root, 'client')).filter(name => name.endsWith('.ts')))
    for (const [, code] of read(`client/${file}`).matchAll(/gameError\(\s*'([a-z-]+)'/g)) raised.add(code);
  for (const [, code] of read('sdk/src/sdk.ts').matchAll(/new HookedInError\('([a-z-]+)'/g)) raised.add(code);
  assert.deepEqual(documented.sort(), [...raised].sort());
});

/** Every name a module exports, types included, following `export * from`. */
function exported(file: string): string[] {
  const text = read(file),
    names: string[] = [];
  for (const [, name] of text.matchAll(
    /^export (?:declare )?(?:async )?(?:function\*?|const|let|class|interface|type|enum) ([A-Za-z_$][\w$]*)/gm,
  ))
    names.push(name);
  for (const [, list] of text.matchAll(/^export (?:type )?\{([^}]*)\}/gm))
    for (const item of list
      .split(',')
      .map(part => part.trim())
      .filter(Boolean))
      names.push(
        item
          .replace(/^type /, '')
          .split(/\s+as\s+/)
          .at(-1)!,
      );
  for (const [, from] of text.matchAll(/^export \* from '([^']+)'/gm))
    names.push(...exported(path.join(path.dirname(file), from)));
  return names;
}

test('every name each SDK entry point exports has its entry, and nothing else', () => {
  const pages: Record<string, string[]> = {
    'sdk/hookedin.md': ['sdk/src/sdk.ts'],
    'sdk/round.md': ['sdk/src/round.ts'],
    'sdk/engine.md': ['sdk/src/engine/index.ts', 'sdk/src/generated/blackjack-funding.ts'],
    'sdk/developer.md': ['sdk/src/developer.ts'],
    'sdk/steps.md': ['sdk/src/steps.ts'],
    'sdk/admits.md': ['sdk/src/admits.ts'],
    'sdk/outcome.md': ['sdk/src/outcome.ts'],
    'sdk/wire.md': ['sdk/src/wire.ts'],
    'sdk/bank-and-synth.md': ['sdk/src/bank.ts', 'sdk/src/synth.ts'],
    'sdk/game-wallet.md': ['testing/game-wallet.ts'],
  };
  for (const [page, sources] of Object.entries(pages))
    assert.deepEqual(entries(read(`docs/${page}`)), [...new Set(sources.flatMap(exported))].sort(), page);
});

/** Every Markdown file of the repository, not what is built or installed. */
const markdown = (dir = ''): string[] =>
  fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory())
      return ['node_modules', 'dist', 'build', '.git', '.wrangler'].includes(entry.name) ? [] : markdown(file);
    return entry.name.endsWith('.md') ? [file] : [];
  });

/** The anchors of a Markdown file's headings, as GitHub and the site make them. */
function anchors(file: string) {
  const slugger = new GithubSlugger();
  return new Set(
    [...prose(read(file)).matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) =>
      slugger.slug(heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')),
    ),
  );
}

test('every relative link reaches a file, and every anchor a heading', () => {
  const broken: string[] = [];
  for (const file of markdown()) {
    // Inline code holds examples, not links.
    const text = prose(read(file)).replace(/`[^`\n]*`/g, '');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [ref, anchor] = target.split('#');
      const linked = ref ? path.join(path.dirname(file), ref) : file;
      if (!fs.existsSync(path.join(root, linked))) broken.push(`${file}: ${target}`);
      else if (anchor !== undefined && linked.endsWith('.md') && !anchors(linked).has(anchor))
        broken.push(`${file}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});
