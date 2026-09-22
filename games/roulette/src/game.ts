/**
 * Roulette where everyone at the table shares one spin. The page lays chips on the layout, turns the
 * whole layout into one bet, and asks the wallet to join the round the wheel's host has open. The
 * wallet takes the seat by itself; the host only opens and closes rounds. When the round is closed
 * the same request to the wallet returns the verified receipt, and the number is read from its
 * outcome. The table is for one asset: players with ETH share one wheel, players with test coins another.
 */
import { HookedIn } from '@hookedin/play/sdk/sdk';
import type { GameReceipt, PendingReceipt, Round } from '@hookedin/play/sdk/sdk';
import { mountBank } from '@hookedin/play/sdk/bank';
import { bet, colour, covers, pocket } from './table.ts';
import type { Chips, WireBet } from './table.ts';
import { mountWheel } from './wheel-view.ts';

/** A bet the wallet was asked to sign, saved first so that a reload finds its result under the same name. */
interface Saved extends WireBet {
  id: string;
  round: Round;
  chips: Record<string, string>;
}
interface Table {
  round: Round | null;
  closesAt: number | null;
  now: number;
  players: number;
  staked: string;
  last: { round: string; number: number } | null;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** Too late to join: a bet that arrives while the round closes has to be taken back again. */
const LAST_CALL_MS = 3000;

(() => {
  'use strict';
  const bank = mountBank($('bank')),
    wheel = mountWheel($<HTMLCanvasElement>('wheel'), matchMedia('(prefers-reduced-motion: reduce)').matches),
    stakeInput = $<HTMLInputElement>('stake');
  let scope = '',
    asset = 'ETH',
    assetId = 'eth',
    ready = false,
    working = false,
    spinning = false,
    chips: Chips = {},
    saved: Saved | null = null,
    table: Table | null = null,
    /** The server's clock minus this page's. */
    skew = 0,
    won: number | null = null;

  const message = (text: string, error = false) => {
    $('status').textContent = text;
    $('status').dataset.error = String(error);
  };
  const persist = () => (saved ? localStorage.setItem(scope, JSON.stringify(saved)) : localStorage.removeItem(scope));
  const total = () => Object.values(chips).reduce((sum, amount) => sum + amount, 0n);
  const remaining = () => (table?.closesAt ? table.closesAt - (Date.now() + skew) : Infinity);
  async function host(path: string, post = false): Promise<Table> {
    const response = await fetch(`./api${path}?asset=${assetId}`, post ? { method: 'POST', body: '{}' } : {});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'The wheel is unavailable.');
    return value;
  }

  // --- The layout ---------------------------------------------------------------------------

  function spot(id: string, label: string, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `spot ${className}`.trim();
    button.dataset.spot = id;
    if (/^\d+$/.test(id)) button.dataset.colour = colour(Number(id));
    else if (id === 'red' || id === 'black') button.dataset.colour = id;
    button.append(label);
    return button;
  }
  function buildLayout() {
    const cells: HTMLElement[] = [spot('0', '0', 'zero')];
    // Three rows of twelve, as on the felt: 3 6 9 … on top, 1 4 7 … at the bottom, a column bet at each row's end.
    for (const row of [3, 2, 1]) {
      for (let column = 0; column < 12; column++) cells.push(spot(String(column * 3 + row), String(column * 3 + row)));
      cells.push(spot(`column:${row}`, '2:1'));
    }
    const gap = () => Object.assign(document.createElement('span'), { className: 'gap' });
    cells.push(gap(), spot('dozen:1', '1 – 12', 'dozen'), spot('dozen:2', '13 – 24', 'dozen'));
    cells.push(spot('dozen:3', '25 – 36', 'dozen'), gap(), gap());
    for (const [id, label] of [
      ['low', '1 – 18'],
      ['even', 'Even'],
      ['red', 'Red'],
      ['black', 'Black'],
      ['odd', 'Odd'],
      ['high', '19 – 36'],
    ])
      cells.push(spot(id!, label!, 'outside'));
    $('layout').replaceChildren(...cells);
  }
  function chip(id: string, direction: 1 | -1) {
    if (locked()) return;
    let unit: bigint;
    try {
      unit = BigInt(HookedIn.parseAmount(stakeInput.value));
    } catch (error: any) {
      return message(error.message, true);
    }
    const amount = (chips[id] ?? 0n) + BigInt(direction) * unit;
    if (amount > 0n) chips[id] = amount;
    else delete chips[id];
    won = null;
    render();
  }
  /** The chips cannot move while a request is in flight or the wheel is turning. A bet that is in
   * the round is not in the way: changing the chips takes it back and places the new one at once. */
  const locked = () => working || spinning;
  /** The chips on the layout are exactly the bet the wallet is holding. */
  const unchanged = () =>
    Boolean(saved) && JSON.stringify(bet(chips)) === JSON.stringify({ stake: saved!.stake, prizes: saved!.prizes });

  // --- What the player sees ----------------------------------------------------------------

  function render() {
    for (const button of $('layout').querySelectorAll<HTMLElement>('.spot')) {
      const id = button.dataset.spot!,
        amount = chips[id];
      button.querySelector('.chip')?.remove();
      if (amount)
        button.append(
          Object.assign(document.createElement('span'), {
            className: 'chip',
            textContent: HookedIn.formatAmount(amount),
          }),
        );
      button.dataset.won = String(won !== null && Boolean(amount) && covers(id).includes(won));
    }
    $('layout').dataset.locked = String(locked());
    $('total').textContent = HookedIn.formatAmount(total(), 9);
    const left = remaining(),
      seconds = Math.max(0, Math.ceil(left / 1000)),
      // Chips the wallet is not yet holding: the bet to place, or the change to make to the one in the round.
      moved = Boolean(saved) && !unchanged() && total() > 0n;
    $('phase').textContent = spinning
      ? 'NO MORE BETS'
      : saved && !moved
        ? 'YOUR BET IS IN'
        : left < LAST_CALL_MS
          ? 'NO MORE BETS'
          : 'PLACE YOUR BETS';
    $('clock').textContent = Number.isFinite(left) ? `Spins in ${seconds}s` : 'Spins when the first chip is down';
    $('players').textContent = table?.players
      ? `${table.players} at the table · ${HookedIn.formatAmount(table.staked)} ${asset} down`
      : 'The table is open.';
    const place = $<HTMLButtonElement>('place');
    place.disabled = !ready || working || spinning || ((!saved || moved) && (!total() || left < LAST_CALL_MS));
    place.textContent = !ready
      ? 'Connecting wallet…'
      : spinning
        ? 'Spinning…'
        : moved
          ? 'Change my bet ↗'
          : saved
            ? 'Take my bet back'
            : 'Place bets ↗';
    $<HTMLButtonElement>('clear').disabled = locked() || !total();
    stakeInput.disabled =
      $<HTMLButtonElement>('bet-up').disabled =
      $<HTMLButtonElement>('bet-down').disabled =
        locked();
    bank.setBusy(working || spinning);
  }
  function remember(number: number) {
    const mark = Object.assign(document.createElement('span'), { textContent: String(number) });
    mark.dataset.colour = colour(number);
    $('history').prepend(mark);
    while ($('history').children.length > 10) $('history').lastElementChild!.remove();
  }

  // --- The bet -----------------------------------------------------------------------------

  /** The ball lands, then the money shows: the receipt is already verified by the wallet, and names
   * the chips that played, which are not the ones last asked for when a change met the spin. */
  async function land(receipt: GameReceipt) {
    const number = pocket(BigInt(receipt.outcome!)),
      payout = BigInt(receipt.payout ?? 0);
    saved = null;
    persist();
    spinning = true;
    bank.withhold(payout);
    render();
    await wheel.spin(number);
    bank.withhold(-payout);
    bank.hold(false);
    spinning = false;
    won = number;
    $('landed').textContent = String(number);
    $('landed').dataset.colour = colour(number);
    remember(number);
    message(
      payout
        ? `${number} ${colour(number)}. ${HookedIn.formatAmount(payout, 9)} ${asset} back from ${HookedIn.formatAmount(receipt.stake!, 9)} ${asset} of chips.`
        : `${number} ${colour(number)}. Nothing on it this time.`,
    );
    render();
  }
  /** A bet the casino declined, or one taken back: the chips are the player's again. */
  function returned(receipt: GameReceipt, wanted = false) {
    saved = null;
    persist();
    bank.hold(false);
    if (wanted) message('Your bet is back on the table. Change it, or place it again.');
    else message(receipt.reason ? `${receipt.reason}. Your chips are back.` : 'Your chips are back.', true);
    render();
  }
  async function settle(result: GameReceipt | PendingReceipt, wanted = false) {
    if (result.status === 'pending') {
      // Tell the wheel a seat was taken, so that the clock starts now and not at its next look.
      table = await host('/table/seated', true).catch(() => table);
      message('Your bet is in. You can take it back until the wheel spins.');
      return render();
    }
    return result.status === 'rejected' ? returned(result, wanted) : land(result);
  }
  async function place() {
    const terms = bet(chips),
      round = table?.round;
    if (!round) throw new Error('The wheel is not ready. Try again in a moment.');
    const limit = BigInt((await HookedIn.balance()).balance);
    if (BigInt(terms.stake) > limit) {
      const funding = await HookedIn.requestFunds({ amount: BigInt(terms.stake) - limit });
      bank.update(funding);
      if (BigInt(funding.balance) < BigInt(terms.stake)) throw new Error('Add enough money to cover your chips.');
    }
    saved = {
      // Changing the chips keeps the bet's name: the wallet takes the seat back and places the new
      // bet on the same round in one request, so the table never loses the place.
      id: saved && saved.round.id === round.id ? saved.id : crypto.randomUUID(),
      ...terms,
      round,
      chips: Object.fromEntries(Object.entries(chips).map(([id, amount]) => [id, String(amount)])),
    };
    persist();
    await ask();
  }
  /** Ask the wallet for the saved bet: a seat while the round is open, its receipt once it is closed. */
  async function ask() {
    const { id, stake, prizes, round } = saved!;
    bank.hold(true);
    try {
      await settle(await HookedIn.bet({ id, stake, prizes, ...(round ? { round } : {}) }));
    } catch (error) {
      // The wallet may hold the signed bet although the round would not take it. Nothing can follow
      // it until it is taken back, and if the round took it after all, this is its result.
      if (!(await HookedIn.balance()).pending) {
        saved = null;
        persist();
        bank.hold(false);
        throw error;
      }
      await settle(await HookedIn.cancel(id));
    }
  }
  async function act(work: () => Promise<void>) {
    if (working) return;
    working = true;
    render();
    try {
      await work();
    } catch (error: any) {
      message(error.message, true);
    } finally {
      working = false;
      render();
    }
  }

  // --- The table ---------------------------------------------------------------------------

  async function watch() {
    try {
      table = await host('/table');
      skew = table.now - Date.now();
      // The round this bet sits in was closed: the wallet has its result.
      if (saved?.round && table.last?.round === saved.round.id && !working && !spinning) await act(ask);
    } catch (error: any) {
      if (!saved) message(error.message, true);
    }
    render();
    setTimeout(watch, 1000);
  }
  async function start() {
    try {
      const startup = await HookedIn.initializeGame({
        stakeInput,
        assetLabels: document.querySelectorAll('[data-asset]'),
      });
      asset = startup.asset;
      assetId = startup.assetId;
      scope = startup.scope;
      bank.update(startup.state);
      saved = JSON.parse(localStorage.getItem(scope) ?? 'null');
      ready = true;
      if (saved) {
        chips = Object.fromEntries(Object.entries(saved.chips).map(([id, amount]) => [id, BigInt(amount)]));
        const receipt = await HookedIn.receipt(saved.id);
        // Settled while away, still seated, or never signed at all.
        if (receipt) await settle(receipt);
        else if (startup.state.pending) await act(ask);
        else {
          saved = null;
          persist();
        }
      }
      if (!saved) message('Put chips on the layout. Everyone shares the spin.');
    } catch (error: any) {
      message(error.message, true);
    }
    render();
    void watch();
  }

  buildLayout();
  $('layout').addEventListener('click', event => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('.spot')?.dataset.spot;
    if (id) chip(id, event.shiftKey ? -1 : 1);
  });
  $('layout').addEventListener('contextmenu', event => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('.spot')?.dataset.spot;
    if (!id) return;
    event.preventDefault();
    chip(id, -1);
  });
  $('place').addEventListener('click', () =>
    act(async () => {
      // Nothing new on the layout: take the bet back. If the wheel got there first, this is its result.
      if (saved && (unchanged() || !total())) return settle(await HookedIn.cancel(saved.id), true);
      return place();
    }),
  );
  $('clear').addEventListener('click', () => {
    chips = {};
    won = null;
    render();
  });
  $('bet-up').addEventListener('click', () => HookedIn.stepStake(stakeInput, true));
  $('bet-down').addEventListener('click', () => HookedIn.stepStake(stakeInput, false));
  render();
  void start();
})();
