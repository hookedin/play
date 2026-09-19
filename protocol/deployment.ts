import type { JsonRpcProvider } from 'ethers';
import type { ChainObserver } from './chain-observer.ts';
import type { Deployment, Integer } from './types.ts';
import { Contract, getAddress, keccak256 } from 'ethers';
import artifact from '../client/contract-artifact.ts';
import { same } from './protocol.ts';

/** The compiled HookedInCasino entry of build/contracts.json, for deployment scripts and tests. */
export function loadArtifact(source = 'contracts/HookedInCasino.sol', name = 'HookedInCasino') {
  // This module also runs in the wallet, so Node's filesystem is resolved only when called.
  const fs = process.getBuiltinModule('node:fs');
  return JSON.parse(fs.readFileSync(new URL('../build/contracts.json', import.meta.url), 'utf8')).contracts[source][
    name
  ];
}

/** ABI and runtime are from the wallet release, never the casino response. */
export async function verifyDeployment({
  observer,
  provider,
  address,
  chainId,
  expected,
}: {
  observer: ChainObserver;
  provider: JsonRpcProvider;
  address: string;
  chainId: Integer;
  expected?: Deployment | null;
}) {
  address = getAddress(address);
  if (BigInt(chainId) !== 31337n && !expected)
    throw new Error('Install an independently verified deployment manifest before funding');
  if (expected && (String(expected.chainId) !== String(chainId) || !same(expected.contractAddress, address)))
    throw new Error('Casino deployment differs from the pinned identity');
  const observation = await observer.observe();
  const contract = new Contract(address, artifact.abi, provider);
  // The immutables and the code are independent reads of one block: asked together, they travel as one batch.
  const [code, ...read] = await Promise.all([
    observer.corroborate('contract bytecode', p =>
      p.send('eth_getCode', [address, { blockHash: observation.block.hash, requireCanonical: true }]),
    ),
    ...artifact.immutables.map(({ name }) => observer.contractRead(contract, name, [], observation.block)),
  ]);
  const values: Record<string, string> = Object.fromEntries(artifact.immutables.map(({ name }, i) => [name, read[i]]));
  if (expected && !same(expected.operator, values.owner))
    throw new Error('Deployment operator identity differs from trusted manifest');
  let runtime = artifact.runtime.slice(2);
  for (const { name, locations } of artifact.immutables)
    for (const { start, length } of locations) {
      const value = values[name]
        .slice(2)
        .toLowerCase()
        .padStart(length * 2, '0');
      runtime = runtime.slice(0, start * 2) + value + runtime.slice((start + length) * 2);
    }
  if (!same(code, '0x' + runtime)) throw new Error('Unrecognized casino bytecode; funding disabled');
  if (expected?.runtimeHash && !same(expected.runtimeHash, keccak256(code)))
    throw new Error('Deployment runtime hash differs');
  await observer.accept(observation);
  return {
    chainId: String(chainId),
    contractAddress: address,
    operator: values.owner,
    runtimeHash: keccak256(code),
    abi: artifact.abi,
  };
}
