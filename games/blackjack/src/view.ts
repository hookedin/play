import type { RoundEvent } from '@hookedin/play/sdk/round';
import { addCard } from '@hookedin/play/sdk/engine';
export interface Card {
  face: number;
  suit: number;
}
export function cardHand(cards: readonly Card[]) {
  return cards.reduce(
    (hand, card) => addCard(hand, Math.min(card.face, 10) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10),
    { total: 0, soft: false },
  );
}
/** Replay only resolved, persisted card labels. No fresh display randomness. */
export function blackjackTable(events: readonly RoundEvent[]) {
  const hands: Card[][] = [[]],
    dealer: Card[] = [],
    doubled = [false, false];
  let split = false,
    insured = false,
    dealerBlackjack = false;
  for (const event of events) {
    if (event.action === 'split') {
      const [a, b] = hands[0]!;
      hands.splice(0, 1, [a!], [b!]);
      split = true;
    }
    if (event.action === 'insurance') insured = true;
    const p = /^player:([01]):(\d+):([0-3])$/.exec(event.label ?? '');
    const d = /^dealer(?:-blackjack)?:(\d+):([0-3])$/.exec(event.label ?? '');
    if (p) {
      const index = Number(p[1]);
      hands[index]!.push({ face: Number(p[2]), suit: Number(p[3]) });
      if (event.action === 'double') doubled[index] = true;
    }
    if (d) {
      dealer.push({ face: Number(d[1]), suit: Number(d[2]) });
      dealerBlackjack ||= event.label!.startsWith('dealer-blackjack:');
    }
  }
  return { hands, dealer, doubled, split, insured, dealerBlackjack };
}
