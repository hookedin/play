import { HookedIn } from '@hookedin/play/sdk/sdk';
import { RoundClient } from '@hookedin/play/sdk/round';
import type { RoundState } from '@hookedin/play/sdk/round';
import { mountBank } from '@hookedin/play/sdk/bank';
import {
  BONUS_SPINS,
  MACHINES,
  PAYING,
  PAYS,
  distribution,
  evaluate,
  nodeOutcome,
  outcomeOf,
  payoutStakes,
  sampleStops,
  slotGraph,
} from './math.ts';
import type { SpinResult } from './math.ts';
import { mountReels } from './reels.ts';
import { createSound } from './sound.ts';

type Mode = 'base' | 'bonus';
/** Everything the game itself remembers between reloads; the money lives in the wallet. */
interface Saved {
  /** The last round whose result was applied here, so a reload never applies it twice. */
  applied: string | null;
  shown: { mode: Mode; stops: number[] } | null;
  bonus: { left: number; played: number; won: number; stake: string } | null;
}
const NAMES: Record<string, string> = {
  L: 'Lion',
  P: 'Pillars',
  S: 'Shears',
  T: 'Torch',
  A: 'Ace',
  K: 'King',
  Q: 'Queen',
  J: 'Jack',
};
/** A settled window with no win, shown before the first spin. */
const IDLE = [36, 27, 57, 49, 26];
const BIG = [
  { from: 150, title: 'EPIC WIN' },
  { from: 50, title: 'MEGA WIN' },
  { from: 20, title: 'BIG WIN' },
];
const AUTO = [0, 10, 25, 50, 100];

const round = new RoundClient(HookedIn, slotGraph);
(() => {
  'use strict';
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bank = mountBank($('bank'), { round });
  const reels = mountReels($('reels'), reducedMotion);
  const sound = createSound();
  const stakeInput = $<HTMLInputElement>('stake');
  let saved: Saved = { applied: null, shown: null, bonus: null },
    storageKey = '',
    session: RoundState | null = null,
    phase: 'connecting' | 'unavailable' | 'idle' | 'spinning' | 'presenting' | 'choosing' = 'connecting',
    asset = 'ETH',
    turbo = false,
    auto = 0,
    /** The player has started this bonus in this tab; its remaining spins follow one another. */
    rolling = false,
    /** The bonus that just played its last spin, kept on screen until its summary closes. */
    closing: Saved['bonus'] = null,
    skip = () => {};

  const persist = () => localStorage.setItem(storageKey, JSON.stringify(saved));
  const mode = (): Mode => (saved.bonus ? 'bonus' : 'base');
  const money = (stakes: number, stake: string) =>
    `${HookedIn.formatAmount(BigInt(stake) * BigInt(stakes), 9)} ${asset}`;
  function message(value: string, error = false) {
    $('status').textContent = value;
    $('status').dataset.error = String(error);
  }
  /** A pause the player can cut short by pressing spin. */
  const pause = (ms: number) =>
    new Promise<void>(resolve => {
      const timer = setTimeout(resolve, reducedMotion ? Math.min(ms, 200) : ms);
      skip = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  function render() {
    const bonus = saved.bonus ?? closing,
      idle = phase === 'idle',
      resumable = Boolean(session && !session.terminal);
    document.body.dataset.mode = bonus ? 'bonus' : 'base';
    $('mode-label').textContent = bonus ? 'Honey Bonus · multiplier reels' : 'Out of the strong, something sweet';
    $('feature-label').textContent = bonus
      ? `Spin ${Math.min(bonus.played + 1, bonus.played + bonus.left)} of ${bonus.played + bonus.left} · won ${bonus.won}×`
      : '';
    $<HTMLButtonElement>('spin').disabled = phase === 'connecting' || phase === 'unavailable' || phase === 'choosing';
    $('spin').dataset.phase = phase;
    $('spin-label').textContent =
      phase === 'connecting'
        ? 'Connecting…'
        : phase === 'unavailable'
          ? 'Offline'
          : phase === 'spinning'
            ? 'Stop'
            : phase === 'presenting'
              ? 'Skip'
              : resumable
                ? 'Resume'
                : bonus
                  ? 'Bonus spin'
                  : 'Spin';
    for (const id of ['bet-down', 'bet-up', 'buy'] as const)
      $<HTMLButtonElement>(id).disabled = !idle || Boolean(bonus) || resumable;
    stakeInput.disabled = !idle || Boolean(bonus) || resumable;
    if (bonus) stakeInput.value = HookedIn.exactAmount(bonus.stake);
    $<HTMLButtonElement>('auto').disabled = phase === 'connecting' || phase === 'unavailable';
    $('auto').textContent = auto ? `Auto · ${auto}` : 'Auto';
    $('auto').setAttribute('aria-pressed', String(auto > 0));
    bank.setBusy(!idle);
  }
  function showWin(stakes: number, stake: string) {
    $('win-multiple').textContent = stakes ? `${stakes}×` : '—';
    $('win-amount').textContent = stakes ? money(stakes, stake) : '';
  }

  /** Where the round's verified outcome fell inside the prize it hit, scaled to any number of choices. */
  const within = (state: RoundState) => (limit: bigint) => {
    const { outcome, rangeStart, rangeEnd } = state.settlement ?? {};
    if (outcome == null || rangeStart == null) return 0n;
    return ((BigInt(outcome) - BigInt(rangeStart)) * limit) / (BigInt(rangeEnd) - BigInt(rangeStart));
  };
  /** Apply a finished round to the game's own state exactly once, and read the reel stops that show it. */
  function settle(state: RoundState) {
    const outcome = nodeOutcome(state.nodeId);
    if (!outcome) throw new Error('This round belongs to another game.');
    if (saved.applied !== state.id) {
      const { pay, bonus: triggered } = outcomeOf(outcome.key);
      let bonus = saved.bonus;
      if (outcome.machine.name === 'bonus' && bonus)
        bonus = { ...bonus, left: bonus.left - 1, played: bonus.played + 1, won: bonus.won + pay };
      if (triggered)
        bonus = { played: 0, won: 0, stake: state.setup.stake, ...bonus, left: (bonus?.left ?? 0) + BONUS_SPINS };
      saved = {
        applied: state.id,
        shown: { mode: outcome.machine.name, stops: sampleStops(outcome.machine, outcome.key, within(state)) },
        bonus,
      };
      persist();
    }
    return { machine: outcome.machine, stops: saved.shown!.stops, key: outcome.key };
  }

  const coins = (() => {
    const canvas = $<HTMLCanvasElement>('coins'),
      context = canvas.getContext('2d')!;
    let particles: { x: number; y: number; vx: number; vy: number; size: number; spin: number }[] = [],
      frame = 0;
    function draw() {
      frame = 0;
      context.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of particles) {
        p.vy += 0.35;
        p.x += p.vx;
        p.y += p.vy;
        p.spin += 0.25;
        const squash = Math.abs(Math.cos(p.spin));
        context.fillStyle = squash > 0.5 ? '#ffd76a' : '#d99a1c';
        context.beginPath();
        context.ellipse(p.x, p.y, p.size, p.size * Math.max(0.15, squash), 0, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = '#8a5a0c';
        context.stroke();
      }
      particles = particles.filter(p => p.y < canvas.height + 30);
      if (particles.length) frame = requestAnimationFrame(draw);
    }
    return {
      burst(count: number) {
        if (reducedMotion) return;
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
        for (let i = 0; i < count; i++)
          particles.push({
            x: canvas.width / 2 + (Math.random() - 0.5) * canvas.width * 0.5,
            y: canvas.height * 0.55,
            vx: (Math.random() - 0.5) * 11,
            vy: -7 - Math.random() * 11,
            size: 7 + Math.random() * 7,
            spin: Math.random() * 6,
          });
        if (!frame) frame = requestAnimationFrame(draw);
      },
    };
  })();

  /** Count the win up. Pressing spin jumps to the final figure. */
  function countUp(stakes: number, stake: string, seconds: number, big: HTMLElement | null) {
    return new Promise<void>(resolve => {
      const start = performance.now();
      let done = false,
        lastTick = 0;
      const finish = () => {
        if (done) return;
        done = true;
        showWin(stakes, stake);
        if (big) big.textContent = `${stakes}×`;
        resolve();
      };
      skip = finish;
      const step = (now: number) => {
        if (done) return;
        const x = Math.min(1, (now - start) / (seconds * 1000));
        const value = Math.max(1, Math.round(stakes * (1 - (1 - x) ** 2)));
        showWin(value, stake);
        if (big) big.textContent = `${value}×`;
        if (now - lastTick > 70) {
          sound.tick();
          lastTick = now;
        }
        if (x === 1) finish();
        else requestAnimationFrame(step);
      };
      if (reducedMotion) finish();
      else requestAnimationFrame(step);
    });
  }

  /** Reveal what a settled window pays. Money has already moved; this only tells the story. */
  async function present(result: SpinResult, key: number, stake: string) {
    const { pay, bonus: triggered } = outcomeOf(key);
    if ((result.win?.pay ?? 0) !== pay || result.bonus !== triggered)
      throw new Error('The reels do not match the settled result.');
    phase = 'presenting';
    render();
    if (result.win) {
      const win = result.win,
        tier = BIG.find(level => pay >= level.from),
        marked = new Set(win.cells.map(([reel, row]) => `${reel}:${row}`));
      for (let reel = 0; reel < 5; reel++)
        for (let row = 0; row < 3; row++)
          reels.cell(reel, row).classList.add(marked.has(`${reel}:${row}`) ? 'win' : 'dim');
      $('win-line').textContent = [
        `${NAMES[win.symbol]} × ${win.length}`,
        `${PAYS[win.symbol][win.length - 3]}×`,
        win.ways > 1 ? `${win.ways} ways` : '',
        win.multiplier > 1 ? `wild ×${win.multiplier}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      $('win-line').classList.remove('hidden');
      sound.win(tier ? 3 - BIG.indexOf(tier) : 0);
      if (tier) {
        $('big-title').textContent = tier.title;
        $('big-win').classList.remove('hidden');
        coins.burst(40 + 40 * (3 - BIG.indexOf(tier)));
      }
      await countUp(pay, stake, tier ? 3.2 : pay >= 5 ? 1.2 : 0.5, tier ? $('big-amount') : null);
      if (tier) await pause(1400);
      $('big-win').classList.add('hidden');
      message(`Won ${pay}× your bet: ${money(pay, stake)}.`);
    } else {
      showWin(0, stake);
      message(triggered ? 'Three honeycombs.' : 'No win this spin.');
    }
    if (triggered) {
      for (const [reel, row] of result.scatterCells) reels.cell(reel, row).classList.add('scatter-hit');
      sound.bonus();
      await pause(900);
    }
  }

  /** The bonus offer, a bought bonus, or the closing summary. Resolves with the player's choice. */
  function feature(options: { eyebrow: string; title: string; text: string; play: string; skip?: string }) {
    phase = 'choosing';
    render();
    $('feature-eyebrow').textContent = options.eyebrow;
    $('feature-title').textContent = options.title;
    $('feature-text').textContent = options.text;
    $('feature-play').textContent = options.play;
    $('feature-skip').textContent = options.skip ?? '';
    $('feature-skip').classList.toggle('hidden', !options.skip);
    $('feature').classList.remove('hidden');
    $('feature-play').focus();
    return new Promise<boolean>(resolve => {
      const choose = (play: boolean) => {
        $('feature').classList.add('hidden');
        $('feature-play').onclick = $('feature-skip').onclick = null;
        phase = 'idle';
        render();
        resolve(play);
      };
      $('feature-play').onclick = () => choose(true);
      $('feature-skip').onclick = () => choose(false);
    });
  }
  const bonusOffer = (stake: string, bought: boolean) =>
    feature({
      eyebrow: bought ? 'Buy the bonus' : 'Three honeycombs',
      title: 'Honey Bonus',
      text: bought
        ? `${BONUS_SPINS} spins on the multiplier reels, where jawbone wilds carry ×2 and ×3. It costs ${money(BONUS_SPINS, stake)}: ${money(1, stake)} a spin.`
        : `You won ${money(BONUS_SPINS, stake)}, the price of ${BONUS_SPINS} spins on the multiplier reels, where jawbone wilds carry ×2 and ×3. Play them, or keep the cash.`,
      play: 'Play bonus ↗',
      skip: bought ? 'Not now' : 'Keep the prize',
    });

  async function spin() {
    if (phase === 'spinning') return reels.quickStop();
    if (phase === 'presenting') return skip();
    if (phase !== 'idle') return;
    sound.unlock();
    phase = 'spinning';
    reels.clearMarks();
    $('win-line').classList.add('hidden');
    showWin(0, '0');
    render();
    const before = saved.shown ?? { mode: 'base' as Mode, stops: IDLE };
    let moving = false,
      failed = false,
      ended: Saved['bonus'] = null;
    try {
      if (!session || session.terminal) {
        const stake = saved.bonus?.stake ?? HookedIn.parseAmount(stakeInput.value);
        session = await round.start({ stake, mode: mode() });
      } else {
        await round.restore();
        await round.ensureFunds(BigInt(session.cash), BigInt(session.setup.stake));
      }
      const stake = session.setup.stake,
        machine = MACHINES[session.setup.mode === 'bonus' ? 'bonus' : 'base'];
      if (saved.bonus) rolling = true;
      message(machine.name === 'bonus' ? 'Bonus spin…' : 'Good luck.');
      // The wallet settles while the reels turn; the balance waits for the reels before it moves.
      bank.hold(true);
      reels.spin(machine, turbo);
      sound.spin();
      moving = true;
      const began = performance.now();
      session = await round.action('spin');
      const inBonus = saved.bonus;
      const { stops, key } = settle(session);
      if (inBonus && !saved.bonus?.left) {
        ended = closing = { ...inBonus, ...saved.bonus!, left: 0 };
        saved = { ...saved, bonus: null };
        persist();
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, (turbo ? 250 : 750) - (performance.now() - began))));
      const view = evaluate(machine, stops),
        honey = new Set(view.scatterCells.map(([reel]) => reel));
      let hush = () => {};
      await reels.stop(machine, stops, {
        turbo,
        // Honeycombs on reels one and three: the last reel keeps the player waiting.
        suspense: honey.has(0) && honey.has(2) ? { 4: 1.6 } : undefined,
        onSuspense: (_, seconds) => (hush = sound.anticipation(seconds)),
        onLand: reel => {
          if (reel === 4) hush();
          sound.stop(reel);
          if (honey.has(reel)) sound.scatter(reel / 2 + 1);
        },
      });
      moving = false;
      await present(view, key, stake);
      bank.hold(false);
      if (outcomeOf(key).bonus && machine.name === 'base') {
        auto = 0;
        if (await bonusOffer(stake, false)) rolling = true;
        else {
          saved = { ...saved, bonus: null };
          persist();
          message(`You kept ${money(BONUS_SPINS, stake)}.`);
        }
      } else if (outcomeOf(key).bonus) message(`${BONUS_SPINS} more bonus spins.`);
      if (ended) {
        rolling = false;
        await feature({
          eyebrow: `${ended.played} bonus spins`,
          title: ended.won ? `${ended.won}× won` : 'Bonus complete',
          text: ended.won
            ? `The Honey Bonus paid ${money(ended.won, ended.stake)} in total.`
            : 'No win this time. The honeycombs will be back.',
          play: 'Continue',
        });
      }
    } catch (error: any) {
      failed = true;
      auto = 0;
      rolling = false;
      if (moving) await reels.stop(MACHINES[before.mode], before.stops, { turbo: true });
      try {
        session = await round.restore();
      } catch {}
      message(error.message, true);
    } finally {
      closing = null;
      bank.hold(false);
      phase = 'idle';
      render();
    }
    if (!failed) setTimeout(next, turbo ? 250 : 600);
  }
  /** The next automatic spin: the rest of a bonus the player started, or autoplay. */
  function next() {
    if (phase !== 'idle' || !(saved.bonus ? rolling : auto > 0)) return;
    if (!saved.bonus) auto--;
    void spin();
  }

  function paytable() {
    $('pay-grid').replaceChildren(
      ...[...PAYING].map(symbol => {
        const row = document.createElement('div'),
          cell = document.createElement('div'),
          pays = document.createElement('div');
        row.className = 'pay-row';
        cell.className = 'cell mini';
        cell.dataset.symbol = symbol;
        cell.append(Object.assign(document.createElement('div'), { className: 'art' }));
        pays.className = 'pay-values';
        pays.append(
          Object.assign(document.createElement('strong'), { textContent: NAMES[symbol] }),
          ...[5, 4, 3].map(length =>
            Object.assign(document.createElement('span'), {
              textContent: `${length} · ${PAYS[symbol][length - 3]}×`,
            }),
          ),
        );
        row.append(cell, pays);
        return row;
      }),
    );
    $('bonus-prize').textContent = `${BONUS_SPINS}×`;
    $('bonus-count').textContent = String(BONUS_SPINS);
    const facts: [string, string][] = [];
    for (const machine of Object.values(MACHINES)) {
      const { counts, total } = distribution(machine);
      let returned = 0n,
        hits = 0,
        best = 0;
      for (const [key, ways] of counts) {
        returned += BigInt(ways) * BigInt(payoutStakes(key));
        if (payoutStakes(key)) hits += ways;
        best = Math.max(best, payoutStakes(key));
      }
      const label = machine.name === 'base' ? 'Main reels' : 'Bonus reels';
      facts.push(
        [`${label} · return to player`, `${(Number((returned * 1000000n) / BigInt(total)) / 10000).toFixed(4)}%`],
        [`${label} · winning spins`, `1 in ${(total / hits).toFixed(2)}`],
        [`${label} · top win`, `${best.toLocaleString('en')}×`],
      );
    }
    $('facts').replaceChildren(
      ...facts.flatMap(([term, value]) => [
        Object.assign(document.createElement('dt'), { textContent: term }),
        Object.assign(document.createElement('dd'), { textContent: value }),
      ]),
    );
  }

  async function recover() {
    try {
      const startup = await HookedIn.initializeGame({
        stakeInput,
        assetLabels: document.querySelectorAll('[data-asset]'),
      });
      asset = startup.asset;
      storageKey = `${startup.scope}:samson`;
      try {
        saved = { ...saved, ...JSON.parse(localStorage.getItem(storageKey) ?? '{}') };
      } catch {}
      bank.update(startup.state);
      // A spin this page cannot finish is let go with a word to the player, who plays on.
      let dropped: string | null = null;
      session = await round.restore().catch((error: Error) => ((dropped = error.message), null));
      // A spin that settled while the page was away is applied now, once, without replaying it.
      if (session?.terminal) settle(session);
      if (saved.bonus && !saved.bonus.left) saved.bonus = null;
      if (saved.shown) reels.show(MACHINES[saved.shown.mode], saved.shown.stops);
      phase = 'idle';
      if (session && !session.terminal) message('Your last spin is still open. Resume it to see the result.');
      else if (saved.bonus) message(`Your Honey Bonus has ${saved.bonus.left} spins left.`);
      if (dropped) message(dropped, true);
      round.watch(() => {
        if (phase !== 'idle') return;
        session = round.state();
        try {
          saved = { ...saved, ...JSON.parse(localStorage.getItem(storageKey) ?? '{}') };
        } catch {}
        render();
      });
    } catch (error: any) {
      phase = 'unavailable';
      message(error.message, true);
    }
    render();
  }

  $('spin').addEventListener('click', () => void spin());
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat || event.target instanceof HTMLInputElement) return;
    if (event.target instanceof HTMLButtonElement) return;
    if (!$('paytable').classList.contains('hidden') || phase === 'choosing') return;
    event.preventDefault();
    void spin();
  });
  $('bet-up').addEventListener('click', () => HookedIn.stepStake(stakeInput, true));
  $('bet-down').addEventListener('click', () => HookedIn.stepStake(stakeInput, false));
  $('turbo').addEventListener('click', () => {
    turbo = !turbo;
    $('turbo').setAttribute('aria-pressed', String(turbo));
  });
  // Cycle to a count; play starts after a moment, and pressing it during play stops it.
  let autoTimer = 0;
  $('auto').addEventListener('click', () => {
    clearTimeout(autoTimer);
    auto = phase === 'idle' ? (AUTO[(AUTO.indexOf(auto) + 1) % AUTO.length] ?? 0) : 0;
    if (auto) autoTimer = window.setTimeout(next, 1200);
    render();
  });
  $('buy').addEventListener('click', async () => {
    if (phase !== 'idle' || saved.bonus) return;
    let stake: string;
    try {
      stake = HookedIn.parseAmount(stakeInput.value);
    } catch (error: any) {
      return message(error.message, true);
    }
    if (!(await bonusOffer(stake, true))) return;
    saved = { ...saved, bonus: { left: BONUS_SPINS, played: 0, won: 0, stake } };
    persist();
    render();
    void spin();
  });
  $('mute').addEventListener('click', () => {
    sound.setMuted(!sound.muted);
    sound.unlock();
    renderMute();
  });
  const renderMute = () => {
    $('mute').textContent = sound.muted ? 'Sound off' : 'Sound on';
    $('mute').setAttribute('aria-pressed', String(sound.muted));
  };
  $('info').addEventListener('click', () => {
    $('paytable').classList.remove('hidden');
    $('paytable-close').focus();
  });
  const closePaytable = () => {
    $('paytable').classList.add('hidden');
    $('info').focus();
  };
  $('paytable-close').addEventListener('click', closePaytable);
  $('paytable').addEventListener('click', event => {
    if (event.target === $('paytable')) closePaytable();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('paytable').classList.contains('hidden')) closePaytable();
  });

  reels.show(MACHINES.base, IDLE);
  renderMute();
  paytable();
  render();
  void recover();
})();
