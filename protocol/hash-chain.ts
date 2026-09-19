import { keccak256 } from 'ethers';

export function bytes32(value: unknown, name = 'value') {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${name} must be bytes32`);
  }
  return value.toLowerCase();
}

export function hashChainLink(preimage: string) {
  return keccak256(bytes32(preimage, 'preimage'));
}

/** The first preimage opens root; each later preimage opens its predecessor. */
export function generateHashChain(seed: string, length: number) {
  bytes32(seed, 'seed');
  if (!Number.isSafeInteger(length) || length < 1) throw new RangeError('length must be a positive safe integer');
  let root = seed.toLowerCase();
  const preimages = [];
  for (let index = 0; index < length; index += 1) {
    preimages.push(root);
    root = hashChainLink(root);
  }
  return Object.freeze({ root, preimages: Object.freeze(preimages.reverse()) });
}
