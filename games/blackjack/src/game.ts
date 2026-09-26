import { HookedIn } from '@hookedin/play/sdk/sdk';
import { RoundClient } from '@hookedin/play/sdk/round';
import type { RoundState } from '@hookedin/play/sdk/round';
import { blackjackState, createBlackjack } from '@hookedin/play/sdk/engine';
import { blackjackTable, cardHand } from './view.ts';
import type { Card } from './view.ts';
import { blackjackFunding } from '@hookedin/play/sdk/generated/blackjack-funding';
import { mountBank } from '@hookedin/play/sdk/bank';
const round = new RoundClient(HookedIn, setup => createBlackjack({ stake: BigInt(setup.stake) }), blackjackFunding);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const bank = mountBank($('bank'), { round });
const automatic = new Set(['deal', 'peek', 'deal-split', 'reveal', 'dealer-hit']);
let session: RoundState | null = null,
  busy = false,
  ready = false,
  asset = 'ETH';
const message = (value: string, error = false) => {
  $('status').textContent = value;
  $('status').dataset.error = String(error);
};
function cards(target: HTMLElement, values: readonly Card[], hidden = false) {
  target.replaceChildren();
  for (const card of values) {
    const element = document.createElement('div');
    element.className = `card${card.suit < 2 ? ' red' : ''}`;
    const face = document.createElement('span'),
      suit = document.createElement('span');
    suit.className = 'suit';
    face.textContent =
      ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' } as Record<number, string>)[card.face] ?? String(card.face);
    suit.textContent = ['♦', '♥', '♠', '♣'][card.suit];
    element.append(face, suit);
    target.append(element);
  }
  if (hidden || values.length === 0) {
    const back = document.createElement('div');
    back.className = 'card card-back';
    back.textContent = 'HookedIn';
    target.append(back);
  }
}
function render() {
  const active = Boolean(session && !session.terminal),
    state = blackjackState(session?.nodeId ?? '');
  const table = blackjackTable(session?.events ?? []),
    actions = session?.actions ?? [];
  bank.setBusy(busy || !ready);
  $<HTMLInputElement>('stake').disabled = busy || active;
  $('deal').classList.toggle('hidden', active && !actions.some(a => automatic.has(a)));
  $<HTMLButtonElement>('deal').disabled = busy || !ready;
  $('deal').textContent = busy
    ? 'Settling…'
    : !ready
      ? 'Connecting wallet…'
      : active
        ? 'Continue hand'
        : 'Deal me in ↗';
  for (const id of ['hit', 'stand', 'double', 'split', 'insurance', 'decline-insurance']) {
    const button = $<HTMLButtonElement>(id),
      cost = BigInt(session?.actionCosts[id] ?? 0);
    button.classList.toggle('hidden', !active || !actions.includes(id));
    const funded = session && BigInt(bank.balance.balance) >= BigInt(session.cash) + cost;
    // The wallet is asked for any shortfall on click, so wallet funding needs no game reload.
    button.disabled = busy || !ready;
    button.title =
      funded || !active
        ? ''
        : `Costs ${HookedIn.formatAmount(cost)} ${asset} more than this game has left; you will be asked to allow it.`;
    if (id === 'insurance') button.textContent = `Insurance · ${HookedIn.formatAmount(cost)} ${asset}`;
  }
  cards($('dealer-cards'), table.dealer, table.dealer.length === 1);
  const dealerTotal = table.dealer.length ? cardHand(table.dealer).total : 0;
  $('dealer-total').textContent = dealerTotal > 21 ? `BUST (${dealerTotal})` : dealerTotal ? String(dealerTotal) : '—';
  const hands = $('hands');
  hands.replaceChildren();
  for (const [index, hand] of table.hands.entries()) {
    const panel = document.createElement('div');
    panel.className = 'player-hand';
    if (active && state?.phase === 'player' && state.completed.length === index) panel.classList.add('active');
    const caption = document.createElement('div');
    caption.className = 'hand-caption';
    const total = hand.length ? cardHand(hand) : null;
    const name = table.split ? `HAND ${index + 1}` : 'YOUR HAND';
    caption.textContent = `${name} · ${total ? (total.total > 21 ? 'BUST' : `${total.soft ? 'SOFT ' : ''}${total.total}`) : '—'}`;
    const row = document.createElement('div');
    row.className = 'cards';
    cards(row, hand);
    const amount = document.createElement('div');
    amount.className = 'hand-kind';
    amount.textContent = session
      ? `${HookedIn.formatAmount(BigInt(session.setup.stake) * (table.doubled[index] ? 2n : 1n))} ${asset}${table.doubled[index] ? ' · DOUBLED' : ''}`
      : '';
    if (session?.terminal && total) {
      const natural = !table.split && hand.length === 2 && total.total === 21;
      const result =
        total.total > 21
          ? 'Loss'
          : table.dealerBlackjack
            ? natural
              ? 'Push'
              : 'Loss'
            : natural
              ? 'Blackjack'
              : dealerTotal > 21 || total.total > dealerTotal
                ? 'Win'
                : total.total === dealerTotal
                  ? 'Push'
                  : 'Loss';
      amount.textContent += ` · ${result}`;
    }
    panel.append(caption, row, amount);
    hands.append(panel);
  }
  $('cash-label').textContent = session?.terminal ? 'Net result' : 'Total wager';
  $('cash').textContent = session
    ? HookedIn.formatAmount(session.terminal ? BigInt(session.cash) - BigInt(session.contributed) : session.contributed)
    : '—';
  $('outcome').classList.toggle('hidden', !session?.terminal);
  if (session?.terminal) {
    const net = BigInt(session.cash) - BigInt(session.contributed);
    const natural = !table.split && table.hands[0]!.length === 2 && cardHand(table.hands[0]!).total === 21;
    $('outcome').textContent =
      `${table.dealerBlackjack ? 'Dealer blackjack' : natural ? 'Blackjack' : net > 0n ? 'You win' : net === 0n ? 'Break even' : 'Net loss'} · ${HookedIn.formatAmount(session.cash)} ${asset} returned`;
  }
  $('insurance-note').textContent = table.insured
    ? `Insurance ${table.dealerBlackjack ? 'wins' : active && state?.phase === 'insurance' ? 'pending' : 'loses'} · ${HookedIn.formatAmount(BigInt(session!.setup.stake) / 2n)} ${asset}`
    : '';
  document.querySelector('.table')!.classList.toggle('busy', busy);
}
async function finishAutomatic() {
  let moves = 0;
  while (session && !session.terminal && session.actions.length === 1 && automatic.has(session.actions[0]!)) {
    if (++moves > 64) throw new Error('Unexpected deal sequence. Reconnect the game.');
    session = await round.action(session.actions[0]!);
    render();
  }
}
function status() {
  if (session?.terminal)
    message(
      `Hand settled. ${HookedIn.formatAmount(session.cash)} ${asset} returned from ${HookedIn.formatAmount(session.contributed)} ${asset} wagered.`,
    );
  else if (session?.actions.includes('insurance'))
    message('Dealer shows an Ace. Insurance costs half your initial bet and pays 2:1 if the dealer has blackjack.');
  else message('Your move. Choose hit, stand, double, or split when available.');
}
async function play(action?: string) {
  if (busy || !ready) return;
  busy = true;
  render();
  message('Preparing your hand…');
  try {
    if (!session || session.terminal) {
      const stake = HookedIn.parseAmount($<HTMLInputElement>('stake').value);
      if (BigInt(stake) % 2n)
        throw new Error('Stake must be an even number of wei for exact blackjack and insurance payouts.');
      session = await round.start({ stake, rules: 'stake-originals-v1' });
    } else if (action) session = await round.action(action);
    await finishAutomatic();
    render();
    status();
  } catch (error: any) {
    try {
      session = await round.restore();
    } catch {}
    message(error.message, true);
  } finally {
    busy = false;
    render();
  }
}
bank.onChange(() => render());
$('deal').addEventListener('click', () => play());
for (const id of ['hit', 'stand', 'double', 'split', 'insurance', 'decline-insurance'])
  $('' + id).addEventListener('click', () => play(id));
async function recover() {
  try {
    const startup = await HookedIn.initializeGame({
      stakeInput: $<HTMLInputElement>('stake'),
      assetLabels: document.querySelectorAll('[data-asset]'),
    });
    asset = startup.asset;
    bank.update(startup.state);
    // Ready before the hand is restored: a hand this page cannot finish is let go with a word, and the
    // player plays on.
    ready = true;
    session = await round.restore();
    if (session) status();
    else message('Set your stake and deal.');
    if (session?.terminal && BigInt(session.balance) === 0n)
      message('Your last hand was restored. Its value is already in your wallet; add funds to keep playing.');
    round.watch(() => {
      if (busy) return;
      session = round.state();
      render();
    });
  } catch (error: any) {
    message(error.message, true);
  } finally {
    render();
  }
}
render();
void recover();
