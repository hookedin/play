// Compile-time checks for the application APIs. This file is never executed.
import type { Domain, Opening, Checkpoint, Operation, EvidenceBundle, Json } from '../protocol/types.ts';
import type { Store } from '../client/storage.ts';
import { baseState, operation, deriveState, verifyEvidence, plain, KIND } from '../protocol/protocol.ts';
import * as read from '../protocol/read.ts';

function checkProtocol(d: Domain, opening: Opening, state: Checkpoint, op: Operation, bundle: EvidenceBundle) {
  baseState(opening.player, opening.index);
  deriveState(d, state, op);
  verifyEvidence(bundle);
  operation(d, state, { amount: 1n, kind: KIND.debit });
  plain({ amount: 1n, states: [state] }) satisfies { amount: string; states: Json<Checkpoint>[] };
  read.checkpoint(plain(state)) satisfies Checkpoint;
  read.object<{ amount: bigint; note?: string }>({ amount: read.whole, note: read.optional(read.text) });
  // @ts-expect-error A reader's shape names every field of its type, each with a reader of that field's type.
  read.object<{ amount: bigint; note?: string }>({ amount: read.text });
  // @ts-expect-error An opening cannot replace a signed checkpoint.
  deriveState(d, opening, op);
  // @ts-expect-error Signed amounts are bigints, not decimal strings.
  operation(d, state, { amount: '1' });
  // @ts-expect-error Signed amounts must be integers, not boolean flags.
  operation(d, state, { amount: true });
  // @ts-expect-error Evidence requires its opening and deployment identity.
  verifyEvidence({ evidence: bundle.evidence });
}

async function checkStorage(store: Store) {
  const value = await store.get<{ sequence: number }>('test');
  value?.sequence satisfies number | undefined;
}

void checkProtocol;
void checkStorage;
