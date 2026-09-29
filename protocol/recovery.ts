import type { JsonRpcProvider, InterfaceAbi, BlockTag } from 'ethers';
import type { EvidenceBundle } from './types.ts';
import { Contract, ZeroAddress, ZeroHash } from 'ethers';
import {
  verifyEvidence,
  verifyStep,
  domain,
  hashState,
  hashOperation,
  same,
  plain,
  owed,
  withdrawalRecorded,
  KIND,
} from './protocol.ts';
import { readContract, requireCanonicalBlock } from './chain-observer.ts';
import { mapBounded } from './concurrency.ts';

/** How a claim stands: paid in full, collectable now, or waiting for house cash to reach its winnings. */
const standing = (remaining: bigint, collectable: bigint) =>
  !remaining ? 'no unpaid amount' : collectable > 0n ? 'collectable now' : 'unpaid; house cash does not reach it yet';

/** Settlement needs current contract state, never historical event availability. */
export async function inspectEvidence(
  bundle: EvidenceBundle,
  provider: JsonRpcProvider,
  abi: InterfaceAbi,
  blockTag: BlockTag = 'latest',
) {
  const verified = verifyEvidence(bundle);
  if (BigInt(await provider.send('eth_chainId', [])) !== BigInt(bundle.chainId))
    throw new Error('Recovery RPC is on another chain');
  const contract = new Contract(bundle.casino, abi, provider),
    block = await provider.getBlock(blockTag);
  if (!block?.hash) throw new Error('Recovery block unavailable');
  const read = (method: string, ...args: unknown[]) => readContract(provider, contract, method, args, block);
  const d = domain(bundle.chainId, bundle.casino),
    channelId = verified.state.channelId;
  const [owner, supported, channel, claim, collectable] = await Promise.all([
    read('owner'),
    read('supported', bundle.evidence),
    read('channels', channelId),
    read('claims', channelId),
    read('collectable', channelId),
  ]);
  // The account's withdrawals the bundle holds, each the account's operation with the casino's signature after it, and
  // a claim of its own once recorded. One never recorded is not owed to its recipient: a close returns it.
  const withdrawals = await mapBounded(bundle.withdrawals ?? [], async proof => {
    const op = proof.step.operation;
    if (Number(op.kind) !== KIND.withdrawal) throw new Error('A withdrawal in the bundle is not one');
    verifyStep(d, proof.base, proof.step, bundle.opening.player, bundle.operator);
    const id = hashOperation(d, op),
      [claim, collectable, channel] = await Promise.all([
        read('claims', id),
        read('collectable', id),
        read('channels', op.channelId),
      ]),
      remaining = BigInt(claim.protectedRemaining) + BigInt(claim.winningsRemaining);
    return {
      id,
      amount: op.amount,
      // Whom it pays: the claim's recipient once it holds one, which the account can change.
      recipient: same(claim.recipient, ZeroAddress) ? op.recipient : claim.recipient,
      remaining,
      collectable,
      paymentStatus: withdrawalRecorded(channel.claimed, proof) ? standing(remaining, collectable) : 'not recorded',
    };
  });
  if (!same(owner, bundle.operator)) throw new Error('Evidence operator differs from contract owner');
  // `supported` takes the channel's zero checkpoint unsigned, and any other only signed by both sides.
  if (
    !Number(channel.status) ||
    !same(channel.player, bundle.opening.player) ||
    !same(hashState(d, supported.toObject()), hashState(d, verified.state))
  )
    throw new Error('Opening or evidence differs from the registered channel');
  await requireCanonicalBlock(provider, block);
  // A finalized channel's claim is for what its close was owed, on the checkpoint it finalized.
  const finalized = Number(channel.status) === 3,
    amount = finalized ? BigInt(channel.closingBalance) : 0n,
    remaining = BigInt(claim.protectedRemaining) + BigInt(claim.winningsRemaining);
  return plain({
    ...verified,
    chainObservationsVerified: true,
    blockNumber: block.number,
    blockHash: block.hash,
    timestamp: block.timestamp,
    channelId,
    channelStatus: channel.status,
    challengeDeadline: channel.deadline,
    // The deposits the contract still holds for the channel, and what its withdrawals have made into claims.
    principal: channel.principal,
    claimed: channel.claimed,
    closingSequence: channel.closingSequence,
    closingStateHash: channel.closingHash,
    signedBalance: verified.state.balance,
    // What a close with this evidence would be owed: the signed balance, the deposits it has not taken in, and what it
    // withdrew that is not yet a claim.
    owed: owed(verified.state, channel.deposited, channel.claimed),
    claim: {
      beneficiary: claim.beneficiary,
      stateHash: finalized ? channel.closingHash : ZeroHash,
      amount,
      paid: amount - remaining,
      protectedRemaining: claim.protectedRemaining,
      winningsRemaining: claim.winningsRemaining,
    },
    remaining,
    recipient: claim.recipient,
    // What collecting pays now: the claim's principal, and as much of its winnings as house cash reaches.
    collectable,
    paymentStatus: finalized ? standing(remaining, collectable) : 'not finalized',
    classification: !finalized
      ? 'signed balance; no finalized payment obligation'
      : !remaining
        ? 'paid by this contract'
        : 'finalized unpaid claim',
    withdrawals,
    limitation:
      'Contract balances at this canonical block; no historical payment log, solvency guarantee, or evidence of unrelated external payments.',
  });
}
