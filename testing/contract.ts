/** Contract test harness: a throwaway Anvil chain, a deployment, and hand-signed channel evidence. No casino service. */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ContractFactory, JsonRpcProvider, HDNodeWallet, id, ZeroHash } from 'ethers';
import {
  domain,
  channelId,
  ACCESS_TYPES,
  STATE_TYPES,
  OP_TYPES,
  hashState,
  baseState,
  operation,
  deriveState,
  roundId,
  seedHash,
  checkpointEvidence,
  disputedStep,
  quoteTerms,
  QUOTE_TYPES,
  OFFER_TYPES,
  offerTerms,
  KIND,
} from '../protocol/protocol.ts';
import { assessBet, MAX_BALANCE } from '../protocol/risk.ts';
import { loadArtifact } from '../protocol/deployment.ts';
import { gasLimitFor } from '../protocol/transaction-recovery.ts';
/** A local chain. It finalizes every block as it mines it, unless `epoch` says how many slots an epoch has: then the
 * finalized block is two epochs behind, as Ethereum's is. */
export async function anvil(chainId = 31337n, { epoch = 0 } = {}) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address()! as any).port;
  await new Promise(r => probe.close(r));
  const child = spawn(
    process.env.ANVIL_BIN || 'anvil',
    ['--port', String(port), '--chain-id', String(chainId), '--slots-in-an-epoch', String(epoch), '--silent'],
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
  // Each sends as the wallet does, with a fifth more gas than its estimate (gasLimitFor): an estimate holds for the block
  // it was made on, and what the payout limit allows moves with the time.
  const wallets = Array.from({ length: 10 }, (_, i) => {
    const wallet = HDNodeWallet.fromPhrase(
        'test test test test test test test test test test test junk',
        undefined,
        "m/44'/60'/0'/0/" + i,
      ).connect(provider),
      estimate = wallet.estimateGas.bind(wallet);
    wallet.estimateGas = async tx => gasLimitFor(await estimate(tx));
    return wallet;
  });
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
/** The casino contract, its signer the first wallet and its treasury the eighth, with no payout limit to speak of
 * unless one is given. */
export async function deployment(env: any, { payoutLimit = MAX_BALANCE - 1n } = {}) {
  const artifact = loadArtifact(),
    [signer, treasury] = [env.wallets[0], env.wallets[7]];
  const contract: any = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer).deploy(
    signer.address,
    treasury.address,
    payoutLimit,
  );
  await contract.waitForDeployment();
  return { contract, d: domain(env.chainId, await contract.getAddress()), signer, treasury };
}
let count = 0;
export function openingFor(player: string, index = 0n) {
  return { channelId: channelId(player, index), player, index };
}
export async function accessFor(d: any, signer: any) {
  const message = { player: signer.address, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 120) };
  return { message, signature: await signer.signTypedData(d, ACCESS_TYPES, message) };
}
/** A casino bet's odds: it pays `prize` when the round's outcome falls below `chance`. */
export const below = (chance: bigint, prize: bigint) => ({ chance, prize });
/** Whether a rejection is the contract's custom error `name`. */
export const reverts = (name: string) => (error: any) => error.revert?.name === name;
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
  };
}
/** An account's current channel at its base, with nothing on-chain: it takes play and money from the start. */
export async function current(f: any, player: any) {
  const address = player.address ?? player.target,
    opening = openingFor(address, await f.contract.channelIndex(address)),
    base = baseState(opening.player, opening.index);
  return { opening, state: base, player, base: checkpointEvidence(base), evidence: checkpointEvidence(base) };
}
/** Deposit into an account's current channel, from the account or anyone else. The channel is at its base, which takes
 * nothing in: its deposit is owed to a close all the same. */
export async function fund(f: any, player: any, deposit = 1000n, from = player) {
  const address = player.address ?? player.target,
    ch = await current(f, player);
  await (await f.contract.connect(from).deposit(address, { value: deposit })).wait();
  return ch;
}
/** A funded channel whose balance has taken its deposit in: a deposit operation, countersigned by the account. */
export async function open(f: any, player: any, deposit = 1000n, from = player) {
  const ch = await fund(f, player, deposit, from),
    taken = await step(f, ch, KIND.deposit, deposit);
  return { ...ch, state: taken.state, evidence: await countersigned(f, ch, taken) };
}
/** The checkpoint a step reached, as both sides sign it: the account countersigns the casino's signed result. */
export async function countersigned(f: any, ch: any, { state, evidence }: any) {
  return checkpointEvidence(
    state,
    await ch.player.signTypedData(f.d, STATE_TYPES, state),
    evidence.step && evidence.step.casinoSignature !== '0x' && evidence.step.operation.kind !== KIND.none
      ? evidence.step.casinoSignature
      : evidence.casinoSignature,
  );
}
/** A channel's on-chain record. */
export const channelAt = (f: any, opening: any) => f.contract.channels(opening.player, opening.index);
/** A finalized channel's claim: what its close was owed and what of it is paid, with what the contract still holds for it. */
export async function claimOf(f: any, opening: any) {
  const [c, claim] = await Promise.all([channelAt(f, opening), f.contract.claims(opening.channelId)]);
  const amount: bigint = c.closingBalance,
    protectedRemaining: bigint = claim.protectedRemaining,
    winningsRemaining: bigint = claim.winningsRemaining;
  return {
    beneficiary: claim.beneficiary as string,
    recipient: claim.recipient as string,
    amount,
    paid: amount - protectedRemaining - winningsRemaining,
    protectedRemaining,
    winningsRemaining,
  };
}
/** A close without the other side: started with `evidence`, then finalized once the challenge period is over. */
export async function forceClose(f: any, env: any, ch: any, evidence = ch.evidence, by = ch.player) {
  await (await f.contract.connect(by).startClose(evidence)).wait();
  await env.provider.send('evm_increaseTime', [7 * 86400 + 1]);
  await env.provider.send('evm_mine', []);
  return (await f.contract.finalizeClose(evidence.base.player, evidence.base.index)).wait();
}
export async function step(f: any, ch: any, kind: bigint, amount: bigint, extra = {}) {
  const signer = ch.player;
  // A bet names its round, the hash of a secret. `secret` settles it on a round shared with
  // another channel; otherwise every bet gets a round of its own.
  const { secret: shared, seed: given, ...terms } = extra as any;
  const secret = kind !== KIND.casinoBet ? ZeroHash : (shared ?? id('secret ' + ++count)),
    seed = kind !== KIND.casinoBet ? ZeroHash : (given ?? id('seed ' + count));
  // The contract reads nothing of what an operation means: its memo is any hash.
  const values = {
    kind,
    amount,
    memo: id('op ' + ++count),
    ...(kind === KIND.casinoBet ? { round: roundId(secret), seedHash: seedHash(seed) } : {}),
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
      casinoSignature: await f.signer.signTypedData(f.d, STATE_TYPES, next),
    },
  };
  return { state: next, evidence };
}
// Joint checkpoints exercise settlement balances without a privileged credit operation.
export async function signedIncrease(f: any, ch: any, amount: bigint) {
  const state = {
    ...ch.state,
    sequence: ch.state.sequence + 1n,
    previousStateHash: hashState(f.d, ch.state),
    transitionHash: id('checkpoint:' + ++count),
    balance: ch.state.balance + amount,
  };
  const signer = ch.player;
  return {
    state,
    evidence: checkpointEvidence(
      state,
      await signer.signTypedData(f.d, STATE_TYPES, state),
      await f.signer.signTypedData(f.d, STATE_TYPES, state),
    ),
  };
}
/** The casino's offer of `amount` of collateral for a channel at `price`, which `buy` buys from `buyer` on-chain and
 * `attempt` tries without sending. */
export async function offered(f: any, opening: any, amount: bigint, price: bigint, expiresAt: bigint) {
  const message = { player: opening.player, index: opening.index, amount, price, expiresAt };
  const offer = { message, signature: await f.signer.signTypedData(f.d, OFFER_TYPES, message) };
  return {
    offer,
    buy: async (buyer: any, value = price) =>
      (await f.contract.connect(buyer).buyCollateral(...offerTerms(offer), { value })).wait(),
    attempt: (buyer: any, value = price) =>
      f.contract.connect(buyer).buyCollateral.staticCall(...offerTerms(offer), { value }),
  };
}
/** The casino's quote for the casino bet that follows the channel's checkpoint, on the round of `secret`, and a bet on
 * it the account signed and the casino has not settled: the evidence and quote the account disputes it with. */
export async function disputedBet(
  f: any,
  ch: any,
  {
    virtualBankroll,
    expiresAt,
    stake,
    chance,
    prize,
    secret = id('secret ' + ++count),
    seed = id('seed ' + count),
  }: any,
) {
  const message = {
    previousStateHash: hashState(f.d, ch.state),
    round: roundId(secret),
    virtualBankroll,
    expiresAt,
  };
  const quote = { message, signature: await f.signer.signTypedData(f.d, QUOTE_TYPES, message) };
  const op = operation(f.d, ch.state, {
    kind: KIND.casinoBet,
    amount: stake,
    chance,
    prize,
    round: roundId(secret),
    seedHash: seedHash(seed),
    memo: id('op ' + ++count),
  });
  const authorization = await ch.player.signTypedData(f.d, OP_TYPES, op);
  return {
    op,
    secret,
    seed,
    quote,
    terms: quoteTerms(quote),
    evidence: { ...ch.evidence, step: disputedStep(op, authorization, seed) },
    /** The casino's settlement of it: the step with the round's secret and its signature of the result. */
    settled: async () => {
      const next = deriveState(f.d, ch.state, op, secret, seed);
      return {
        state: next,
        evidence: {
          ...ch.evidence,
          step: {
            operation: op,
            authorization,
            seed,
            secret,
            casinoSignature: await f.signer.signTypedData(f.d, STATE_TYPES, next),
          },
        },
      };
    },
  };
}
