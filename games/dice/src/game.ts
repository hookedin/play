import { HookedIn } from '@hookedin/play/sdk/sdk';
import { RoundClient } from '@hookedin/play/sdk/round';
import type { RoundState } from '@hookedin/play/sdk/round';
import { mountBank } from '@hookedin/play/sdk/bank';
import { CHANCE_MAX, CHANCE_MIN, diceGraph, winPayout } from './rules.ts';

/** What Auto cycles through: the rolls one press plays, where 0 is a single roll. */
const AUTO = [0, 10, 50, 100];
/** Rolls the history keeps. */
const HISTORY = 10;
const round = new RoundClient(HookedIn, diceGraph);
(() => {
  'use strict';
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const bank = mountBank($('bank'), { round });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stakeInput = $<HTMLInputElement>('stake'),
    slider = $<HTMLInputElement>('chance'),
    chanceText = $<HTMLInputElement>('chance-text'),
    play = $<HTMLButtonElement>('play'),
    autoButton = $<HTMLButtonElement>('auto');
  let session: RoundState | null = null,
    // A press is being played: one roll, or a run of Auto.
    running = false,
    ready = false,
    connecting = true,
    asset = 'ETH',
    auto = 0,
    // Rolls to go in this run of Auto, the one under way included.
    left = 0,
    // The round last added to the history.
    shown = '';
  const chance = () => Number(slider.value);
  const percent = (bps: number) => (bps / 100).toFixed(2);
  function message(value: string, error = false) {
    $('status').textContent = value;
    $('status').dataset.error = String(error);
  }
  /** The stake as typed, or null while it is not an amount. */
  function stake() {
    try {
      return BigInt(HookedIn.parseAmount(stakeInput.value));
    } catch {
      return null;
    }
  }
  function odds() {
    const bps = chance(),
      amount = stake();
    $('rail').style.setProperty('--chance', `${bps / 100}%`);
    slider.setAttribute('aria-valuetext', `${percent(bps)}%`);
    // Truncated, never rounded up: the profit below is the exact figure.
    $('multiplier').textContent = (Math.floor(99000000 / bps) / 10000).toFixed(4);
    $('profit').textContent = amount === null ? '–' : HookedIn.formatAmount(winPayout(amount, bps) - amount, 9);
    if (!shown) $('result-note').textContent = `Roll under ${percent(bps)} to win`;
  }
  function render() {
    const open = Boolean(session && !session.terminal),
      locked = running || open;
    play.disabled = !ready || (running && !left);
    play.textContent = !ready
      ? connecting
        ? 'Connecting wallet…'
        : 'Wallet unavailable'
      : left
        ? `Stop · ${left} left`
        : open
          ? 'Resume roll'
          : auto
            ? `Roll ${auto} times`
            : 'Roll dice';
    autoButton.disabled = !ready || locked;
    autoButton.textContent = auto ? `Auto · ${auto}` : 'Auto';
    autoButton.setAttribute('aria-pressed', String(auto > 0));
    for (const id of ['stake', 'chance', 'chance-text', 'half', 'double']) $<HTMLInputElement>(id).disabled = locked;
    bank.setBusy(!ready || running);
    $('die').classList.toggle('rolling', running);
  }
  /** A finished roll: the verified outcome read on a 0–100 scale, where under the win chance wins. */
  function show(state: RoundState) {
    if (!/^[0-9]+$/.test(String(state.settlement?.outcome))) return;
    const value = Number((BigInt(state.settlement.outcome) * 10000n) >> 64n) / 100,
      won = state.nodeId === 'dice:win',
      net = BigInt(state.cash) - BigInt(state.contributed);
    $('roll').textContent = value.toFixed(2);
    $('roll').dataset.won = String(won);
    $('result-note').textContent = `${won ? '+' : '−'}${HookedIn.formatAmount(won ? net : -net, 9)} ${asset}`;
    $('die').classList.toggle('lost', !won);
    const pin = $('pin');
    pin.hidden = false;
    pin.dataset.won = String(won);
    pin.style.setProperty('--at', String(value / 100));
    if (state.id === shown) return;
    shown = state.id;
    // A roll can settle at once; the die still tumbles for it.
    if (!reducedMotion)
      $('die').animate([{ rotate: '-200deg', scale: 0.85 }, {}], { duration: 300, easing: 'ease-out' });
    const past = Object.assign(document.createElement('li'), { textContent: value.toFixed(2) });
    past.dataset.won = String(won);
    $('history').prepend(past);
    while ($('history').children.length > HISTORY) $('history').lastElementChild!.remove();
  }
  /** One roll: a new round, or the one left open. False once the player has been told why it failed. */
  async function roll() {
    message('');
    try {
      if (!session || session.terminal)
        session = await round.start({ stake: HookedIn.parseAmount(stakeInput.value), chanceBps: chance() });
      if (!session.terminal) session = await round.action('roll');
      show(session);
      return true;
    } catch (error: any) {
      try {
        session = await round.restore();
      } catch {}
      message(error.message, true);
      return false;
    }
  }
  /** Roll once, or Auto's count; pressed during a run, it stops after the roll under way. */
  async function press() {
    if (!ready) return;
    if (running) {
      left = 0;
      return render();
    }
    running = true;
    // A roll left open is finished on its own.
    left = session && !session.terminal ? 0 : auto;
    render();
    // Auto shows each roll for a moment before the next.
    while ((await roll()) && left && --left) {
      render();
      await new Promise(resolve => setTimeout(resolve, 250));
      if (!left) break;
    }
    running = false;
    left = 0;
    render();
  }
  async function recover() {
    try {
      const startup = await HookedIn.initializeGame({
        stakeInput,
        assetLabels: document.querySelectorAll('[data-asset]'),
      });
      bank.update(startup.state);
      asset = startup.asset;
      // Ready before the round is restored: a round this page cannot finish is let go with a word, and
      // the player plays on.
      ready = true;
      const state = await round.restore();
      if (state?.nodeId.startsWith('dice:')) {
        session = state;
        // The track shows the odds the round was played at.
        slider.value = String(state.setup.chanceBps);
        chanceText.value = percent(chance());
        if (state.terminal) show(state);
        else message('A roll is still open. Resume it to see how it landed.');
      }
      round.watch(() => {
        if (running) return;
        session = round.state();
        if (session?.terminal) show(session);
        render();
      });
    } catch (error: any) {
      message(error.message, true);
    } finally {
      connecting = false;
      odds();
      render();
    }
  }
  /** A new win chance: the slider snaps to the rules' ends, and a typed one to the slider's steps. */
  function setChance(bps: number) {
    if (Number.isFinite(bps)) slider.value = String(Math.min(CHANCE_MAX, Math.max(CHANCE_MIN, bps)));
    chanceText.value = percent(chance());
    $('pin').hidden = true;
    odds();
  }
  slider.addEventListener('input', () => setChance(chance()));
  chanceText.addEventListener('change', () => setChance(Math.round(parseFloat(chanceText.value) * 2) * 50));
  stakeInput.addEventListener('input', odds);
  function scaleStake(up: boolean) {
    const amount = stake();
    if (amount === null) return;
    stakeInput.value = HookedIn.exactAmount(up ? amount * 2n : amount / 2n || 1n);
    odds();
  }
  $('half').addEventListener('click', () => scaleStake(false));
  $('double').addEventListener('click', () => scaleStake(true));
  autoButton.addEventListener('click', () => {
    auto = AUTO[(AUTO.indexOf(auto) + 1) % AUTO.length];
    render();
  });
  play.addEventListener('click', press);
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat) return;
    // Space rolls unless it is typing.
    if (event.target instanceof HTMLInputElement && event.target.type !== 'range') return;
    event.preventDefault();
    void press();
  });
  odds();
  render();
  void recover();
})();
