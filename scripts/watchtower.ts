import fs from 'node:fs';
import { Contract, Wallet } from 'ethers';
import { ChainObserver, createRpcProvider, requireIndependentRpc } from '../protocol/chain-observer.ts';
import { verifyDeployment } from '../protocol/deployment.ts';
import { DisputeWorker } from '../protocol/dispute-worker.ts';
import { acquireServerLock } from '../protocol/file-lock.ts';
import { json } from '../protocol/protocol.ts';
import artifact from '../client/contract-artifact.ts';
const args = process.argv.slice(2),
  arg = (name: any) => args[args.indexOf(name) + 1];
let provider,
  witnessProvider,
  unlock,
  stopping = false;
try {
  if (!args.includes('--deployment') || !args.includes('--journal') || !args.includes('--evidence'))
    throw new Error(
      'Use --deployment trusted.json --journal private/outbox.json --evidence bundle.json; HOOKEDIN_RELAYER_KEY signs only recovery transactions.',
    );
  const deployment = JSON.parse(fs.readFileSync(arg('--deployment'), 'utf8'));
  if (BigInt(deployment.chainId) !== 31337n) requireIndependentRpc(deployment.rpcUrl, deployment.witnessRpcUrl);
  if (!process.env.HOOKEDIN_RELAYER_KEY)
    throw new Error('Fund and configure HOOKEDIN_RELAYER_KEY separately from the settlement signer');
  provider = createRpcProvider(deployment.rpcUrl);
  witnessProvider = deployment.witnessRpcUrl ? createRpcProvider(deployment.witnessRpcUrl) : undefined;
  const finality = BigInt(deployment.chainId) === 31337n ? 1 : 2;
  const observer = new ChainObserver({ provider, witnessProvider, chainId: deployment.chainId, finality });
  await verifyDeployment({
    observer,
    provider,
    address: deployment.contractAddress,
    chainId: deployment.chainId,
    expected: deployment,
  });
  unlock = acquireServerLock(arg('--journal') + '.lock');
  const signer = new Wallet(process.env.HOOKEDIN_RELAYER_KEY, provider);
  const contract = new Contract(deployment.contractAddress, artifact.abi, signer);
  const worker = new DisputeWorker({
    contract,
    provider,
    observer,
    signer,
    file: arg('--journal'),
    chainId: deployment.chainId,
    confirmations: finality,
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });
  do {
    try {
      // Re-read every tick: the wallet's newest exported evidence replaces the file.
      const bundles = [JSON.parse(fs.readFileSync(arg('--evidence'), 'utf8'))];
      if (
        bundles.some(
          b =>
            String(b.chainId) !== String(deployment.chainId) ||
            b.casino.toLowerCase() !== deployment.contractAddress.toLowerCase(),
        )
      )
        throw new Error('Watchtower evidence belongs to another deployment');
      const observation = await observer.observe();
      const status = await worker.tick(bundles, observation);
      await observer.accept(observation);
      console.log(
        json({
          time: new Date().toISOString(),
          ...status,
          relayerBalance: String(await observer.balance(signer.address, observation.block)),
        }),
      );
    } catch (error: any) {
      console.error(json({ severity: 'critical', reason: error.shortMessage || error.message }));
      if (args.includes('--once')) throw error;
    }
    if (args.includes('--once')) break;
    await new Promise(resolve => setTimeout(resolve, 4000));
  } while (!stopping);
} catch (error: any) {
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
} finally {
  unlock?.();
  provider?.destroy();
  witnessProvider?.destroy();
}
