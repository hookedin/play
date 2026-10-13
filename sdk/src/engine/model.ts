import type { Rational } from './rational.ts';

export interface GameOutcome {
  readonly next: string;
  readonly probability: Rational;
  readonly label?: string;
}

export interface GameAction {
  readonly id: string;
  /** Additional existing player cash committed when this action is chosen. */
  readonly additionalCash?: bigint;
  readonly outcomes: readonly GameOutcome[];
}

export type GameNode =
  | { readonly id: string; readonly kind: 'terminal'; readonly payout: bigint }
  | { readonly id: string; readonly kind: 'decision'; readonly actions: readonly GameAction[] };

/** A finite acyclic graph of public states. An action is chosen before its draw. */
export interface GameGraph {
  readonly root: string;
  readonly nodes: readonly GameNode[];
}
