/**
 * The verifier, docs/verify.html, works a bet out again with its own keccak256 and nothing else: it must agree with
 * ethers and with the protocol the wallet and the contract run, on every input.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hexlify, keccak256, randomBytes } from 'ethers';
import { drawStep, landStep, outcome, roundId, seedHash } from '../protocol/protocol.ts';
import { admits } from '../protocol/risk.ts';
import { splitStep } from '../sdk/src/engine/transition.ts';

const html = readFileSync(new URL('../docs/verify.html', import.meta.url), 'utf8'),
  page: any = vm.createContext({ TextEncoder });
vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)![1]!, page);
const random32 = () => hexlify(randomBytes(32));

test('its keccak256 is keccak256, at every length around the rate', () => {
  for (const length of [0, 1, 31, 32, 135, 136, 137, 271, 272, 500]) {
    const bytes = randomBytes(length);
    assert.equal(page.hex(page.keccak256(bytes)), keccak256(bytes), `${length} bytes`);
  }
});

test("it works out a bet's hashes, outcome and drawn step as the protocol does", () => {
  for (let i = 0; i < 40; i++) {
    const seed = random32(),
      secret = random32(),
      weights = Array.from({ length: 1 + (i % 9) }, (_, k) => BigInt(k * 977 + 1) ** BigInt(1 + 7 * (i % 30)));
    assert.equal(page.hashOf(seed), seedHash(seed));
    assert.equal(page.hashOf(secret), roundId(secret));
    assert.equal(page.outcome(seed, secret), outcome(seed, secret).value);
    assert.equal(BigInt(page.drawStep(seed, weights)), drawStep(seed, weights));
    const results = weights.map((weight, k) => ({ weight, cash: BigInt(k % 3) * 1000n })),
      ours = page.landStep(
        seed,
        results.map(result => [result.weight, result.cash]),
        1000n,
      ),
      theirs = results.some(result => result.cash === 1000n) ? landStep(seed, results, 1000n) : null;
    assert.deepEqual(ours && [BigInt(ours.result), ours.draw], theirs && [theirs.result, theirs.draw]);
  }
});

test('it checks that the ways the wallet split a table into pay each amount exactly as often as the table', () => {
  const results = [
      { weight: 4n, cash: 0n },
      { weight: 3n, cash: 500n },
      { weight: 2n, cash: 2000n },
      { weight: 1n, cash: 3000n },
    ],
    ways = splitStep({ admits, bankroll: 10n ** 9n, cash: 1000n, results }).map(way =>
      'stake' in way ? [way.weight, way.stake, way.chance, way.prize] : [way.weight],
    ),
    table = results.map(result => [result.weight, result.cash]);
  assert.ok(ways.length > 2);
  assert.equal(page.realizes(1000n, table, ways), true);
  // One outcome more on a way's chance pays its prize a little more often than the table says.
  const [first, ...rest] = ways as bigint[][];
  assert.equal(page.realizes(1000n, table, [[first![0]!, first![1]!, first![2]! + 1n, first![3]!], ...rest]), false);
  assert.equal(page.realizes(1000n, table, [...ways, [1n]]), false);
});

test('its roll falls under the line exactly when the outcome is below the chance', () => {
  const space = 1n << 64n,
    under = (value: bigint, chance: bigint) => {
      const { rolled, under } = page.roll(value, chance);
      return Number(rolled) < Number(under) || (rolled.length > 10 && rolled < under);
    };
  // Dice's 49.50%, one outcome either side of it, reads 49.50.
  for (const chance of [(space * 495n) / 1000n, (space * 495n) / 1000n + 1n])
    assert.deepEqual({ ...page.roll((space * 4217n) / 10000n + 1n, chance) }, { rolled: '42.17', under: '49.50' });
  for (const chance of [1n, (space * 495n) / 1000n, (space * 495n) / 1000n + 1n, space - 1n])
    for (const value of [0n, chance - 1n, chance, chance + 1n, space - 1n])
      if (value >= 0n && value < space && value !== chance) assert.equal(under(value, chance), value < chance);
});
