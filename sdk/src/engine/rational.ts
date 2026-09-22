/** Exact probabilities: game rules state them as fractions, and nothing here ever rounds one. */
export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

const normalized = new WeakSet<object>();

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function fraction(n: bigint, d: bigint = 1n): Rational {
  if (typeof n !== 'bigint' || typeof d !== 'bigint') {
    throw new TypeError('fractions require bigint numerator and denominator');
  }
  if (d === 0n) throw new RangeError('fraction denominator cannot be zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const divisor = gcd(n, d);
  const result = Object.freeze({ n: n / divisor, d: d / divisor });
  normalized.add(result);
  return result;
}

function rational(value: Rational): Rational {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('probabilities must be exact { n, d } bigint fractions');
  }
  return normalized.has(value) ? value : fraction(value.n, value.d);
}

export function add(a: Rational, b: Rational): Rational {
  a = rational(a);
  b = rational(b);
  const common = gcd(a.d, b.d);
  return fraction(a.n * (b.d / common) + b.n * (a.d / common), (a.d / common) * b.d);
}

export function multiply(a: Rational, b: Rational): Rational {
  a = rational(a);
  b = rational(b);
  const left = gcd(a.n, b.d),
    right = gcd(b.n, a.d);
  return fraction((a.n / left) * (b.n / right), (a.d / right) * (b.d / left));
}

export function divide(a: Rational, b: Rational): Rational {
  a = rational(a);
  b = rational(b);
  return fraction(a.n * b.d, a.d * b.n);
}

export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  a = rational(a);
  b = rational(b);
  const delta = a.n * b.d - b.n * a.d;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
