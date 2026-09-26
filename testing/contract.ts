/** Contract test harness: a throwaway Anvil chain, a deployment, and hand-signed channel evidence. No casino service. */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ContractFactory, JsonRpcProvider, HDNodeWallet, id, Wallet, ZeroHash } from 'ethers';
import {
  domain,
  channelId,
  ACCESS_TYPES,
  STATE_TYPES,
  OP_TYPES,
  CLOSE_TYPES,
  hashState,
  initialState,
  operation,
  deriveState,
  roundId,
  seedHash,
  checkpointEvidence,
} from '../protocol/protocol.ts';
import { assessBet } from '../protocol/risk.ts';
import { loadArtifact } from '../protocol/deployment.ts';
export async function anvil(chainId = 31337) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address()! as any).port;
  await new Promise(r => probe.close(r));
  const child = spawn(
    process.env.ANVIL_BIN || 'anvil',
    ['--port', String(port), '--chain-id', String(chainId), '--silent'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let error;
  child.on('error', e => (error = e));
  const provider = new JsonRpcProvider('http://127.0.0.1:' + port, undefined, {
    cacheTimeout: -1,
    batchStallTime: 0,
  });
  provider.pollingInterval = 10;
  for (let i = 0; ; i++) {
    if (error) throw error;
    try {
      await provider.send('eth_chainId', []);
      break;
    } catch {
      if (i > 100) throw new Error('Anvil unavailable');
      await new Promise(r => setTimeout(r, 30));
    }
  }
  const wallets = Array.from({ length: 10 }, (_, i) =>
    HDNodeWallet.fromPhrase(
      'test test test test test test test test test test test junk',
      undefined,
      "m/44'/60'/0'/0/" + i,
    ).connect(provider),
  );
  return {
    chainId,
    provider,
    wallets,
    url: 'http://127.0.0.1:' + port,
    async close() {
      provider.destroy();
      child.kill();
      await once(child, 'exit').catch(() => {});
    },
  };
}
export async function deployment(env: any) {
  const artifact = loadArtifact();
  const contract: any = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, env.wallets[0]).deploy();
  await contract.waitForDeployment();
  return {
    contract,
    d: domain(env.chainId, await contract.getAddress()),
    owner: env.wallets[0],
  };
}
let count = 0;
export function openingFor(player: string, signer: string, deposit: any) {
  return { channelId: channelId(player, signer, deposit), player, signer, deposit: String(deposit) };
}
export async function accessFor(d: any, opening: any, signer: any) {
  const message = { channelId: opening.channelId, expiresAt: Math.floor(Date.now() / 1000) + 120 };
  return { message, signature: await signer.signTypedData(d, ACCESS_TYPES, message) };
}
/** A casino bet's odds: it pays `prize` when the round's outcome falls below `chance`. */
export const below = (chance: any, prize: any) => ({ chance, prize });
/** A casino bet that wins `netWin` when the outcome falls below `chance`, priced by the casino's admission rule. */
export function assessBinary({ bankroll, stake, netWin, chance }: Record<string, bigint>) {
  const prize = stake + netWin,
    risk = assessBet({ bankroll, bet: { stake, chance, prize } });
  return {
    ...risk,
    stake,
    netWin,
    chance,
    prize,
    developerFee: risk.fee / 2n,
    casinoFee: risk.fee / 2n,
  };
}
export async function open(f: any, player: any, deposit = 1000n, overrides: any = {}) {
  const used = Number((await f.contract.channels(channelId(player.address, player.address, deposit))).status);
  const signer = used ? Wallet.createRandom() : player;
  const opening = openingFor(player.address, overrides.signer || signer.address, deposit);
  await (await f.contract.connect(player).openChannel(opening.signer, { value: deposit })).wait();
  const state = initialState(opening);
  return {
    opening,
    state,
    player,
    key: overrides.signer ? undefined : signer.privateKey,
    evidence: checkpointEvidence(state),
  };
}
export async function step(f: any, ch: any, kind: any, amount: any, extra = {}) {
  const signer = ch.key ? new Wallet(ch.key) : ch.player;
  // A bet names its round, the hash of a secret. `secret` settles it on a round shared with
  // another channel; otherwise every bet gets a round of its own.
  const { secret: shared, seed: given, ...terms } = extra as any;
  const secret = kind !== 1 ? ZeroHash : (shared ?? id('secret ' + ++count)),
    seed = kind !== 1 ? ZeroHash : (given ?? id('seed ' + count));
  // The contract reads nothing of what an operation means: its memo is any hash.
  const values = {
    kind,
    amount,
    memo: id('op ' + ++count),
    ...(kind === 1 ? { round: roundId(secret), seedHash: seedHash(seed) } : {}),
    ...terms,
  };
  const op = operation(f.d, ch.state, values);
  const next = deriveState(f.d, ch.state, op, secret, seed);
  const evidence = {
    ...ch.evidence,
    step: {
      operation: op,
      authorization: await signer.signTypedData(f.d, OP_TYPES, op),
      seed,
      secret,
      casinoSignature: await f.owner.signTypedData(f.d, STATE_TYPES, next),
    },
  };
  return { state: next, evidence };
}
export async function closeCoop(f: any, ch: any, evidence = ch.evidence) {
  const state = Number(evidence.step.operation.kind)
    ? deriveState(f.d, evidence.base, evidence.step.operation, evidence.step.secret, evidence.step.seed)
    : evidence.base;
  const message = {
    channelId: state.channelId,
    stateHash: hashState(f.d, state),
  };
  return (
    await f.contract.cooperativeClose(
      evidence,
      await ch.player.signTypedData(f.d, CLOSE_TYPES, message),
      await f.owner.signTypedData(f.d, CLOSE_TYPES, message),
    )
  ).wait();
}

// Joint checkpoints exercise settlement balances without a privileged credit operation.
export async function signedIncrease(f: any, ch: any, amount: any) {
  const state = {
    ...ch.state,
    sequence: String(BigInt(ch.state.sequence) + 1n),
    previousStateHash: hashState(f.d, ch.state),
    transitionHash: id('checkpoint:' + ++count),
    balance: String(BigInt(ch.state.balance) + amount),
  };
  const signer = ch.key ? new Wallet(ch.key) : ch.player;
  return {
    state,
    evidence: checkpointEvidence(
      state,
      await signer.signTypedData(f.d, STATE_TYPES, state),
      await f.owner.signTypedData(f.d, STATE_TYPES, state),
    ),
  };
}
