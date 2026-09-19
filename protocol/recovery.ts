import type { JsonRpcProvider, InterfaceAbi, BlockTag } from 'ethers';
import type { EvidenceBundle } from './types.ts';
import { Contract } from 'ethers';
import { verifyEvidence, domain, initialState, hashState, same, plain } from './protocol.ts';
import { blockReference, readContract, requireCanonicalBlock } from './chain-observer.ts';

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
  const [owner, supported, channel, claim, cash, principal, reserved, allocated, recipient] = await Promise.all([
    read('owner'),
    read('supported', bundle.evidence),
    read('channels', channelId),
    read('claims', channelId),
    provider.send('eth_getBalance', [bundle.casino, blockReference(block)]).then(BigInt),
    read('protectedPrincipal'),
    read('reservedWinnings'),
    read('allocatedWinnings', channelId),
    read('claimRecipient', channelId),
  ]);
  if (!same(owner, bundle.operator)) throw new Error('Evidence operator differs from contract owner');
  const d = domain(bundle.chainId, bundle.casino);
  if (
    !Number(channel.status) ||
    !same(channel.player, bundle.opening.player) ||
    !same(channel.signer, bundle.opening.signer) ||
    !same(channel.initialHash, hashState(d, initialState(bundle.opening))) ||
    !same(hashState(d, supported.toObject()), hashState(d, verified.state))
  )
    throw new Error('Opening or evidence differs from the registered channel');
  await requireCanonicalBlock(provider, block);
  const finalized = Number(channel.status) === 3,
    remaining = BigInt(claim.amount) - BigInt(claim.paid);
  const houseCash = cash - principal - reserved,
    collectable = claim.protectedRemaining + allocated;
  return plain({
    ...verified,
    chainObservationsVerified: true,
    blockNumber: block.number,
    blockHash: block.hash,
    timestamp: block.timestamp,
    channelId,
    channelStatus: channel.status,
    challengeDeadline: channel.deadline,
    closingSequence: channel.closingSequence,
    closingStateHash: channel.closingHash,
    signedBalance: verified.state.balance,
    claim: Object.fromEntries(
      ['beneficiary', 'stateHash', 'amount', 'paid', 'protectedRemaining', 'winningsRemaining', 'finalizedAt'].map(
        key => [key, claim[key]],
      ),
    ),
    remaining,
    houseCash,
    reservedWinnings: reserved,
    allocatedWinnings: allocated,
    recipient,
    allocatedCollectable: collectable,
    paymentStatus: !finalized
      ? 'not finalized'
      : !remaining
        ? 'no unpaid amount'
        : collectable > 0n
          ? 'claim has funds reserved for collection'
          : houseCash > 0n
            ? 'unpaid; FIFO allocation pending'
            : 'unpaid; no unallocated house liquidity',
    classification: !finalized
      ? 'signed balance; no finalized payment obligation'
      : !remaining
        ? 'paid by this contract'
        : 'finalized unpaid claim',
    limitation:
      'Contract balances at this canonical block; no historical payment log, solvency guarantee, or evidence of unrelated external payments.',
  });
}
