/** What the local wallet's page and serve's Node side (local-wallet.ts and local-casino.ts) send each other: what the
 * bridge carries, as JSON in which every string and every bigint is marked as what it is, so neither is read as the
 * other. */
export const encode = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `n${v}` : typeof v === 'string' ? `s${v}` : v));
export const decode = (text: string) =>
  JSON.parse(text, (_, v) => {
    if (typeof v !== 'string') return v;
    if (v[0] === 's') return v.slice(1);
    if (/^n(0|-?[1-9][0-9]*)$/.test(v)) return BigInt(v.slice(1));
    throw new Error('Neither a string nor a bigint, as the local wallet sends them');
  });
