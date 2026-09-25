import { HookedIn } from '@hookedin/play/sdk/sdk';
import { RoundClient } from '@hookedin/play/sdk/round';
import { mountBank } from '@hookedin/play/sdk/bank';
import { minesGraph } from './rules.ts';
const round = new RoundClient(HookedIn, minesGraph);
(() => {
  'use strict';
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const tiles = [...document.querySelectorAll<HTMLButtonElement>('[data-tile]')];
  const bank = mountBank($('bank'), { round });
  let session: import('@hookedin/play/sdk/round').RoundState | null = null;
  let busy = false;
  let ready = false;
  let connecting = true;
  let asset = 'ETH';
  let picks: number[] = [];
  let exploded = -1;
  function message(value: string, error = false) {
    $('status').textContent = value;
    $('status').dataset.error = String(error);
  }
  function settled(state: import('@hookedin/play/sdk/round').RoundState) {
    return state.nodeId !== 'mines:loss'
      ? `Cashed out ${HookedIn.formatAmount(state.cash)} ${asset}.`
      : `You hit the mine. Lost ${HookedIn.formatAmount(state.contributed)} ${asset}.`;
  }
  function count() {
    return Number(/mines:(?:picks|payout):(\d+)/.exec(session?.nodeId || '')?.[1] || picks.length);
  }
  function render() {
    const active = Boolean(session && !session.terminal);
    const actions = session?.actions || [];
    bank.setBusy(busy || !ready);
    $<HTMLInputElement>('stake').disabled = busy || active;
    $<HTMLButtonElement>('play').disabled = !ready || busy || (active && !actions.includes('cash-out'));
    $<HTMLButtonElement>('play').textContent = !ready
      ? connecting
        ? 'Connecting wallet…'
        : 'Wallet unavailable'
      : busy
        ? 'Settling…'
        : active
          ? actions.includes('cash-out')
            ? 'Cash out ↗'
            : 'Choose a tile above ↑'
          : 'Start exploring ↗';
    $('cash').textContent = session ? HookedIn.formatAmount(session.cash) : '—';
    $('cash-label').textContent = session?.terminal ? 'Paid out' : 'Continuation value';
    tiles.forEach((tile, index) => {
      tile.disabled =
        !ready || busy || !active || !actions.includes('reveal') || picks.includes(index) || exploded === index;
      tile.classList.toggle('safe', picks.includes(index));
      tile.classList.toggle('mine', exploded === index);
      tile.querySelector('.tile-art')!.textContent = exploded === index ? '✹' : picks.includes(index) ? '◆' : '✦';
      tile.setAttribute(
        'aria-label',
        `Tile ${index + 1}${picks.includes(index) ? ': gem revealed' : exploded === index ? ': mine revealed' : ': reveal'}`,
      );
    });
    for (let i = 1; i <= 3; i++) $('step-' + i).classList.toggle('active', i <= count());
    if (!session) return;
    if (session.terminal) {
      const lost = session.nodeId === 'mines:loss';
      $('board-caption').textContent = lost
        ? 'A mine. A moment. A fresh start.'
        : `${count()} gem${count() === 1 ? '' : 's'}. Well played.`;
    } else
      $('board-caption').textContent =
        count() === 3
          ? 'Three gems. Time to collect.'
          : count()
            ? `${count()} gem${count() === 1 ? '' : 's'} found. Keep going or cash out.`
            : 'Choose any tile to begin.';
  }
  async function act(action: string, chosen = -1) {
    if (busy || !ready) return;
    busy = true;
    if (chosen >= 0) tiles[chosen].classList.add('pending');
    render();
    message('The wallet is verifying and settling the casino bet…');
    try {
      session = await round.action(action);
      if (chosen >= 0) {
        if (session.nodeId === 'mines:loss') exploded = chosen;
        else picks.push(chosen);
      }
      message(
        session.terminal
          ? settled(session)
          : `${count()} safe pick${count() === 1 ? '' : 's'}. ${count() === 3 ? 'Cash out to finish this round.' : 'Choose another tile or cash out.'}`,
      );
    } catch (error: any) {
      try {
        session = await round.restore();
      } catch {}
      message(error.message, true);
    } finally {
      busy = false;
      bank.update(round.account);
      tiles.forEach(tile => tile.classList.remove('pending'));
      render();
    }
  }
  tiles.forEach((tile, index) => tile.addEventListener('click', () => act('reveal', index)));
  $<HTMLButtonElement>('play').addEventListener('click', async () => {
    if (busy || !ready) return;
    if (session && !session.terminal) {
      await act('cash-out');
      return;
    }
    busy = true;
    render();
    message('Preparing your round using this game’s allocated balance.');
    try {
      const stake = HookedIn.parseAmount($<HTMLInputElement>('stake').value);
      session = await round.start({ stake });
      picks = [];
      exploded = -1;
      message('Your round is ready. Choose a tile to reveal your first outcome.');
    } catch (error: any) {
      try {
        session = await round.restore();
      } catch {}
      message(error.message, true);
    } finally {
      busy = false;
      bank.update(round.account);
      render();
    }
  });
  async function recover() {
    try {
      const startup = await HookedIn.initializeGame({
        stakeInput: $<HTMLInputElement>('stake'),
        assetLabels: document.querySelectorAll('[data-asset]'),
      });
      bank.update(startup.state);
      asset = startup.asset;
      // Ready before the round is restored: a round this page cannot finish is let go with a word, and
      // the player plays on.
      ready = true;
      const state = await round.restore();
      if (state && typeof state.nodeId === 'string' && state.nodeId.startsWith('mines:')) {
        session = state;
        // Positions have no effect on odds. After reload, arrange prior safe picks from the left.
        picks = Array.from({ length: count() }, (_, i) => i);
        render();
        message(
          state.terminal
            ? BigInt(state.balance) === 0n
              ? 'Your last round was restored. Its value is already in your wallet; add funds to keep playing.'
              : settled(state)
            : `Round restored. ${picks.length} prior safe picks are displayed from the left; tile positions do not change the odds.`,
        );
      }
      round.watch(() => {
        if (busy) return;
        session = round.state();
        picks = Array.from({ length: count() }, (_, i) => i);
        exploded = -1;
        render();
      });
    } catch (error: any) {
      message(error.message, true);
    } finally {
      connecting = false;
      render();
    }
  }
  render();
  recover();
})();
