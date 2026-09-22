import { HookedIn } from '@hookedin/play/sdk/sdk';
import { mountBank } from '@hookedin/play/sdk/bank';
import { createSynth } from '@hookedin/play/sdk/synth';
import { DropClient } from './drop.ts';
import type { DropConfig, Landed } from './drop.ts';
import { RISKS, ROWS, multipliers } from './tables.ts';
import type { Risk, Rows } from './tables.ts';
import { mountBoard } from './board.ts';

const AUTO = [0, 10, 50, 100];
/** Taps ahead of the wallet wait here; more would only hide how many balls are still to come. */
const QUEUE = 20;
const drops = new DropClient(HookedIn);
(() => {
  'use strict';
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bank = mountBank($('bank'));
  const synth = createSynth();
  const stakeInput = $<HTMLInputElement>('stake');
  let lastTick = 0;
  const board = mountBoard($<HTMLCanvasElement>('board'), {
    reducedMotion,
    onPeg(row, rows) {
      // Many balls share the board; keep the patter light.
      const now = performance.now();
      if (now - lastTick < 28) return;
      lastTick = now;
      synth.tone(620 + (row / rows) * 900, 0, 0.05, { type: 'triangle', gain: 0.03 });
    },
  });
  let rows: Rows = 12,
    risk: Risk = 'medium',
    ready = false,
    connecting = true,
    asset = 'ETH',
    fast = false,
    auto = 0,
    queued = 0,
    working = false,
    stats = { balls: 0, best: 0, net: 0n };

  function message(value: string, error = false) {
    $('status').textContent = value;
    $('status').dataset.error = String(error);
  }
  const times = (hundredths: number) => `${Number((hundredths / 100).toFixed(2))}×`;
  function segments<T extends string | number>(
    id: string,
    values: readonly T[],
    current: () => T,
    choose: (value: T) => void,
  ) {
    $(id).replaceChildren(
      ...values.map(value => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'segment';
        button.textContent = String(value);
        button.setAttribute('role', 'radio');
        button.addEventListener('click', () => {
          choose(value);
          render();
        });
        button.dataset.value = String(value);
        return button;
      }),
    );
    return () => {
      for (const button of $(id).children as Iterable<HTMLButtonElement>) {
        button.setAttribute('aria-checked', String(button.dataset.value === String(current())));
        button.disabled = busy();
      }
    };
  }
  /** The board cannot change under a ball, and a saved ball keeps its own board. */
  const busy = () => working || board.flying > 0 || Boolean(drops.pending);
  function setBoard(nextRows: Rows, nextRisk: Risk) {
    rows = nextRows;
    risk = nextRisk;
    board.configure(rows, multipliers(rows, risk));
  }
  const renderRisk = segments(
    'risk',
    RISKS,
    () => risk,
    value => setBoard(rows, value),
  );
  const renderRows = segments(
    'rows',
    ROWS,
    () => rows,
    value => setBoard(value, risk),
  );

  function render() {
    renderRisk();
    renderRows();
    const locked = busy();
    stakeInput.disabled = $<HTMLButtonElement>('bet-up').disabled = $<HTMLButtonElement>('bet-down').disabled = locked;
    const drop = $<HTMLButtonElement>('drop');
    drop.disabled = !ready;
    drop.textContent = !ready
      ? connecting
        ? 'Connecting wallet…'
        : 'Wallet unavailable'
      : drops.pending && !working
        ? 'Drop the saved ball ↓'
        : queued
          ? `Drop ball ↓ · ${queued} waiting`
          : 'Drop ball ↓';
    $<HTMLButtonElement>('auto').disabled = !ready;
    $('auto').textContent = auto ? `Auto · ${auto}` : 'Auto';
    $('auto').setAttribute('aria-pressed', String(auto > 0));
    $('stat-drops').textContent = String(stats.balls);
    $('stat-best').textContent = stats.best ? times(stats.best) : '—';
    $('stat-net').textContent = `${stats.net > 0n ? '+' : ''}${HookedIn.formatAmount(stats.net, 9)}`;
    $('stat-net').dataset.sign = stats.net > 0n ? 'up' : stats.net < 0n ? 'down' : '';
    bank.setBusy(working);
  }

  function celebrate(hundredths: number) {
    if (hundredths < 100) return synth.tone(190, 0, 0.16, { type: 'sine', gain: 0.1, to: 110 });
    const scale = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568, 2093],
      notes = hundredths >= 2500 ? 7 : hundredths >= 500 ? 5 : hundredths >= 200 ? 3 : 2;
    synth.melody(scale.slice(0, notes), 0.075, { type: 'triangle', gain: 0.12 });
    if (hundredths < 2500) return;
    synth.noise(0, 0.7, 0.05, 5000);
    if (reducedMotion) return;
    $('flash').classList.remove('hidden');
    setTimeout(() => $('flash').classList.add('hidden'), 900);
  }
  /** The ball falls after the money has settled; its winnings join the shown balance when it lands. */
  function fly(landed: Landed) {
    if (landed.rows !== rows || landed.risk !== risk) setBoard(landed.rows, landed.risk);
    const payout = BigInt(landed.payout),
      bucket = landed.turns.filter(Boolean).length,
      hundredths = multipliers(landed.rows, landed.risk)[bucket];
    bank.withhold(payout);
    void board.launch(landed.turns, fast).then(() => {
      bank.withhold(-payout);
      stats = {
        balls: stats.balls + 1,
        best: Math.max(stats.best, hundredths),
        net: stats.net + payout - BigInt(landed.stake),
      };
      // Only wins rise off the board; the centre would otherwise be a blur of small numbers.
      if (hundredths > 100) board.pop(bucket, times(hundredths), hundredths >= 500);
      celebrate(hundredths);
      const chip = Object.assign(document.createElement('span'), { className: 'chip', textContent: times(hundredths) });
      chip.dataset.tier = hundredths >= 500 ? 'hot' : hundredths >= 100 ? 'warm' : 'cold';
      $('ticker').prepend(chip);
      while ($('ticker').children.length > 9) $('ticker').lastElementChild!.remove();
      message(
        `${times(hundredths)}: ${HookedIn.formatAmount(payout, 9)} ${asset} back from a ${HookedIn.formatAmount(landed.stake, 9)} ${asset} ball.`,
      );
      render();
    });
  }

  /** Wagers settle one at a time; balls fall together. Each tap queues one more ball. */
  async function work() {
    if (working) return;
    working = true;
    render();
    try {
      while (queued > 0 || auto > 0) {
        if (queued > 0) queued--;
        else auto--;
        const config: DropConfig = { rows, risk, stake: HookedIn.parseAmount(stakeInput.value) };
        board.hover(true);
        bank.hold(true);
        let landed: Landed;
        try {
          landed = await drops.drop(config);
        } finally {
          board.hover(false);
        }
        fly(landed);
        bank.hold(false);
        render();
        await new Promise(resolve => setTimeout(resolve, fast ? 90 : 220));
      }
    } catch (error: any) {
      queued = auto = 0;
      message(error.message, true);
    } finally {
      bank.hold(false);
      working = false;
      render();
    }
  }
  function request() {
    if (!ready) return;
    synth.unlock();
    if (queued < QUEUE) queued++;
    render();
    void work();
  }

  async function recover() {
    try {
      const startup = await HookedIn.initializeGame({
        stakeInput,
        assetLabels: document.querySelectorAll('[data-asset]'),
      });
      asset = startup.asset;
      bank.update(startup.state);
      const landed = await drops.restore();
      ready = true;
      if (landed) {
        fly(landed);
        message('Your last ball settled while you were away. Here it comes.');
      } else if (drops.pending) {
        setBoard(drops.pending.rows, drops.pending.risk);
        stakeInput.value = HookedIn.exactAmount(drops.pending.stake);
        message('A ball is still waiting for its wager. Drop to finish it.');
      }
    } catch (error: any) {
      message(error.message, true);
    } finally {
      connecting = false;
      render();
    }
  }

  $('drop').addEventListener('click', request);
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    request();
  });
  $('bet-up').addEventListener('click', () => HookedIn.stepStake(stakeInput, true));
  $('bet-down').addEventListener('click', () => HookedIn.stepStake(stakeInput, false));
  $('fast').addEventListener('click', () => {
    fast = !fast;
    $('fast').setAttribute('aria-pressed', String(fast));
  });
  // Cycle to a count; the run starts after a moment, and pressing it during a run stops it.
  let autoTimer = 0;
  $('auto').addEventListener('click', () => {
    synth.unlock();
    clearTimeout(autoTimer);
    auto = working ? 0 : (AUTO[(AUTO.indexOf(auto) + 1) % AUTO.length] ?? 0);
    if (auto) autoTimer = window.setTimeout(() => void work(), 900);
    render();
  });
  const renderMute = () => {
    $('mute').textContent = synth.muted ? 'Sound off' : 'Sound on';
    $('mute').setAttribute('aria-pressed', String(synth.muted));
  };
  $('mute').addEventListener('click', () => {
    synth.setMuted(!synth.muted);
    synth.unlock();
    renderMute();
  });

  setBoard(rows, risk);
  renderMute();
  render();
  void recover();
})();
