// Compile-time checks for the application APIs. This file is never executed.
import type { Domain, Opening, Checkpoint, Operation, EvidenceBundle } from '../protocol/types.ts';
import type { Store } from '../client/storage.ts';
import type { CasinoWallet, WalletChannel } from '../client/wallet.ts';
import { initialState, operation, deriveState, verifyEvidence, plain } from '../protocol/protocol.ts';

function checkProtocol(d: Domain, opening: Opening, state: Checkpoint, op: Operation, bundle: EvidenceBundle) {
  initialState(opening);
  deriveState(d, state, op);
  verifyEvidence(bundle);
  operation(d, state, { amount: 1n, kind: 2 });
  plain({ amount: 1n, states: [state] }) satisfies { amount: string; states: Checkpoint[] };
  // @ts-expect-error An opening cannot replace a signed checkpoint.
  deriveState(d, opening, op);
  // @ts-expect-error Signed amounts must be integers, not boolean flags.
  operation(d, state, { amount: true });
  // @ts-expect-error Evidence requires its opening and deployment identity.
  verifyEvidence({ evidence: bundle.evidence });
}

async function checkStorage(store: Store) {
  const value = await store.get<{ sequence: number }>('test');
  value?.sequence satisfies number | undefined;
  await store.update<number>('counter', count => (count ?? 0) + 1);
  // @ts-expect-error A typed storage update must preserve the record type.
  await store.update<number>('counter', () => 'one');
}

void checkProtocol;
void checkStorage;

function checkSelectedChannel(wallet: CasinoWallet) {
  // @ts-expect-error An initialized wallet need not have an open channel.
  const unchecked: WalletChannel = wallet.channel;
  wallet.ready();
  const ready: WalletChannel = wallet.channel;
  return { unchecked, ready };
}
void checkSelectedChannel;
