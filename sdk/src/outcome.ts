/** The rule every round's outcome follows, for a page, a server or anybody else that checks a round itself: a round is
 * named by the hash of the casino's secret, a seed by its own hash, and the outcome is theirs together. */
export { outcome, roundId, seedHash } from '../../protocol/protocol.ts';
