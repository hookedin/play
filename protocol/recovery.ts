import type { JsonRpcProvider, InterfaceAbi, BlockTag } from 'ethers';
import type { EvidenceBundle } from './types.ts';
import { Contract } from 'ethers';
import { verifyEvidence, domain, hashState, same, plain, owed } from './protocol.ts';
import { readContract, requireCanonicalBlock } from './chain-observer.ts';

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
  const channelId = verified.state.channelId;
  const [owner, supported, channel, claim, collectable, recipient] = await Promise.all([
    read('owner'),
    read('supported', bundle.evidence),
    read('channels', channelId),
    read('claims', channelId),
    read('collectable', channelId),
    read('claimRecipient', channelId),
  ]);
  if (!same(owner, bundle.operator)) throw new Error('Evidence operator differs from contract owner');
  const d = domain(bundle.chainId, bundle.casino);
  // `supported` takes the channel's zero checkpoint unsigned, and any other only signed by both sides.
  if (
    !Number(channel.status) ||
    !same(channel.player, bundle.opening.player) ||
    !same(hashState(d, supported.toObject()), hashState(d, verified.state))
  )
    throw new Error('Opening or evidence differs from the registered channel');
  await requireCanonicalBlock(provider, block);
  const finalized = Number(channel.status) === 3,
    remaining = BigInt(claim.amount) - BigInt(claim.paid);
  return plain({
    ...verified,
    chainObservationsVerified: true,
    blockNumber: block.number,
    blockHash: block.hash,
    timestamp: block.timestamp,
    channelId,
    channelStatus: channel.status,
    challengeDeadline: channel.deadline,
    // The deposits the contract still holds for the channel, and what it has paid out of it.
    principal: channel.principal,
    paidOut: channel.paidOut,
    closingSequence: channel.closingSequence,
    closingStateHash: channel.closingHash,
    signedBalance: verified.state.balance,
    // What a close with this evidence would be owed: the signed balance, the deposits it has not taken in, and what it
    // withdrew that the contract has not paid.
    owed: owed(verified.state, channel.deposited, channel.paidOut),
    claim: Object.fromEntries(
      ['beneficiary', 'stateHash', 'amount', 'paid', 'protectedRemaining', 'winningsRemaining'].map(key => [
        key,
        claim[key],
      ]),
    ),
    remaining,
    recipient,
    // What collecting pays now: the claim's principal, and as much of its winnings as house cash reaches.
    collectable,
    paymentStatus: !finalized
      ? 'not finalized'
      : !remaining
        ? 'no unpaid amount'
        : collectable > 0n
          ? 'collectable now'
          : 'unpaid; house cash does not reach it yet',
    classification: !finalized
      ? 'signed balance; no finalized payment obligation'
      : !remaining
        ? 'paid by this contract'
        : 'finalized unpaid claim',
    limitation:
      'Contract balances at this canonical block; no historical payment log, solvency guarantee, or evidence of unrelated external payments.',
  });
}
