import { HookedIn } from '@hookedin/play/sdk/sdk';
import { RoundClient } from '@hookedin/play/sdk/round';
import type { RoundState } from '@hookedin/play/sdk/round';
import { seededRandom } from '@hookedin/play/sdk/engine';
import {
  BONUS_SPINS,
  MACHINES,
  PAYING,
  PAYS,
  evaluate,
  nodeOutcome,
  outcomeOf,
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
  { from: 150, title: 'Epic win' },
  { from: 50, title: 'Mega win' },
  { from: 20, title: 'Big win' },
];

const round = new RoundClient(HookedIn, slotGraph);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const reels = mountReels($('reels'), reducedMotion);
const sound = createSound();
const stakeInput = $<HTMLInputElement>('stake');
let saved: Saved = { applied: null, shown: null, bonus: null },
  storageKey = '',
  session: RoundState | null = null,
  phase: 'connecting' | 'unavailable' | 'idle' | 'spinning' | 'presenting' | 'choosing' = 'connecting',
  turbo = false,
  /** Autoplay spins still to start. */
  auto = 0,
  /** The player has started this bonus in this tab; its remaining spins follow one another. */
  rolling = false,
  /** The bonus that just played its last spin, kept on screen until its summary closes. */
  closing: Saved['bonus'] = null,
  /** Spin was pressed while the reels turned: land them at once. */
  slam = false,
  /** Spin was pressed during a celebration: finish it at once, and spin again when this spin is done. */
  hurry = false,
  again = false,
  skip = () => {};

const persist = () => localStorage.setItem(storageKey, JSON.stringify(saved));
const mode = (): Mode => (saved.bonus ? 'bonus' : 'base');
const money = (stakes: number, stake: string) => `${HookedIn.formatAmount(BigInt(stake) * BigInt(stakes))} METH`;
function message(value: string, error = false) {
  $('status').textContent = value;
  $('status').dataset.error = String(error);
}
/** A pause the player can cut short by pressing Spin. */
const pause = (ms: number) =>
  new Promise<void>(resolve => {
    if (hurry) return resolve();
    const timer = setTimeout(resolve, reducedMotion ? Math.min(ms, 200) : ms);
    skip = () => {
      clearTimeout(timer);
      resolve();
    };
  });

function render() {
  // A finished bonus stays on screen until its summary closes; the next spin is already a base one.
  const shown = saved.bonus ?? closing,
    resumable = Boolean(session && !session.terminal),
    // The bet can change while a win is still counted: the next spin reads it when it starts.
    locked = (phase !== 'idle' && phase !== 'presenting') || auto > 0 || Boolean(saved.bonus) || resumable,
    stop = auto > 0 || phase === 'spinning';
  document.body.dataset.mode = shown ? 'bonus' : 'base';
  $('mode-label').textContent = shown ? 'Honey Bonus' : 'Out of the strong, something sweet';
  $('feature-label').textContent = shown
    ? `Spin ${Math.min(shown.played + 1, shown.played + shown.left)} of ${shown.played + shown.left} · Won ${shown.won}×`
    : '';
  const spin = $<HTMLButtonElement>('spin');
  spin.disabled = phase === 'connecting' || phase === 'unavailable' || phase === 'choosing';
  spin.dataset.phase = phase;
  spin.toggleAttribute('data-stop', stop);
  spin.textContent =
    phase === 'connecting'
      ? 'Connecting…'
      : phase === 'unavailable'
        ? 'Offline'
        : stop
          ? 'Stop'
          : resumable
            ? 'Resume'
            : saved.bonus
              ? 'Bonus spin'
              : 'Spin';
  for (const id of ['bet-down', 'bet-up']) $<HTMLButtonElement>(id).disabled = locked;
  stakeInput.disabled = locked;
  $<HTMLButtonElement>('buy').disabled = locked || phase !== 'idle';
  if (saved.bonus) stakeInput.value = HookedIn.exactAmount(saved.bonus.stake);
  // Autoplay can be set up during a spin, and stopped whenever it runs.
  $<HTMLButtonElement>('auto').disabled =
    !auto && (phase === 'connecting' || phase === 'unavailable' || phase === 'choosing' || Boolean(shown) || resumable);
  $('auto').textContent = auto ? `Stop · ${auto}` : 'Auto';
  $('auto').setAttribute('aria-pressed', String(auto > 0));
  if ($<HTMLButtonElement>('auto').disabled) autoMenu(false);
}
/** The win meter, and the celebration's figures while one shows. */
function showWin(stakes: number, stake: string) {
  $('win-multiple').textContent = stakes ? `${stakes}×` : '—';
  $('win-amount').textContent = stakes ? money(stakes, stake) : '';
  $('big-amount').textContent = `${stakes}×`;
  $('big-money').textContent = stakes ? money(stakes, stake) : '';
}
function celebrate(title: string | null) {
  $('big-title').textContent = title ?? '';
  $('big-win').classList.toggle('hidden', !title);
}

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
      shown: {
        mode: outcome.machine.name,
        stops: sampleStops(outcome.machine, outcome.key, seededRandom(BigInt(state.settlement.draw))),
      },
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

/** Count the win up. Pressing Spin jumps to the final figure. */
function countUp(stakes: number, stake: string, seconds: number) {
  return new Promise<void>(resolve => {
    const start = performance.now();
    let done = false,
      lastTick = 0;
    const finish = () => {
      if (done) return;
      done = true;
      showWin(stakes, stake);
      resolve();
    };
    skip = finish;
    const step = (now: number) => {
      if (done) return;
      const x = Math.min(1, (now - start) / (seconds * 1000));
      showWin(Math.max(1, Math.round(stakes * (1 - (1 - x) ** 2))), stake);
      if (now - lastTick > 70) {
        sound.tick();
        lastTick = now;
      }
      if (x === 1) finish();
      else requestAnimationFrame(step);
    };
    if (reducedMotion || hurry) finish();
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
  const speed = turbo ? 0.4 : 1;
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
      celebrate(tier.title);
      coins.burst(40 + 40 * (3 - BIG.indexOf(tier)));
    }
    await countUp(pay, stake, (tier ? 3.2 : pay >= 5 ? 1.2 : 0.5) * speed);
    if (tier) await pause(1400 * speed);
    celebrate(null);
    message(`You won ${money(pay, stake)}, ${pay}× your bet.`);
  } else message(triggered ? 'Three honeycombs!' : 'No win this spin.');
  if (triggered) {
    for (const [reel, row] of result.scatterCells) reels.cell(reel, row).classList.add('scatter-hit');
    sound.bonus();
    await pause(900 * speed);
  }
}
/** The last bonus spin has played: show what the whole bonus paid. */
async function summarize(bonus: NonNullable<Saved['bonus']>) {
  celebrate('Honey Bonus');
  if (bonus.won) {
    sound.win(1);
    await countUp(bonus.won, bonus.stake, turbo ? 0.8 : 2);
  } else showWin(0, bonus.stake);
  await pause(turbo ? 800 : 1800);
  celebrate(null);
  message(bonus.won ? `The Honey Bonus paid ${money(bonus.won, bonus.stake)}.` : 'The Honey Bonus paid nothing.');
}

/** Offer the Honey Bonus. Resolves with whether the player plays it. */
function offer(stake: string, bought: boolean) {
  phase = 'choosing';
  again = false;
  render();
  const price = money(BONUS_SPINS, stake);
  $('offer-eyebrow').textContent = bought ? 'Buy bonus' : 'Three honeycombs';
  $('offer-text').textContent = bought
    ? `${BONUS_SPINS} spins on the bonus reels, where wilds multiply wins by 2 and 3. Each spin is one bet: ${price} in all.`
    : `You won ${price}. Spend it on ${BONUS_SPINS} spins on the bonus reels, where wilds multiply wins by 2 and 3, or keep it.`;
  $('offer-play').textContent = bought ? `Buy for ${price}` : `Play ${BONUS_SPINS} spins`;
  $('offer-keep').textContent = bought ? 'Cancel' : 'Keep it';
  $('offer').classList.remove('hidden');
  // The card takes focus, not a button, so a Space pressed to spin chooses nothing.
  $('offer-card').focus();
  return new Promise<boolean>(resolve => {
    const choose = (play: boolean) => {
      $('offer').classList.add('hidden');
      $('offer-play').onclick = $('offer-keep').onclick = null;
      phase = 'idle';
      render();
      resolve(play);
    };
    $('offer-play').onclick = () => choose(true);
    $('offer-keep').onclick = () => choose(false);
  });
}

async function spin() {
  if (phase !== 'idle') return;
  sound.unlock();
  phase = 'spinning';
  slam = hurry = again = false;
  skip = () => {};
  reels.clearMarks();
  $('win-line').classList.add('hidden');
  showWin(0, '0');
  message('');
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
      await round.checkAllowance(BigInt(session.cash), session.id);
    }
    const stake = session.setup.stake,
      machine = MACHINES[session.setup.mode === 'bonus' ? 'bonus' : 'base'];
    if (saved.bonus) rolling = true;
    // The wallet settles while the reels turn; the allowance it shows waits until the spin is over and on screen.
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
    if (!slam) await pause(Math.max(0, (turbo ? 250 : 750) - (performance.now() - began)));
    const view = evaluate(machine, stops),
      honey = new Set(view.scatterCells.map(([reel]) => reel));
    let hush = () => {};
    const stopping = reels.stop(machine, stops, {
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
    if (slam) reels.quickStop();
    await stopping;
    moving = false;
    await present(view, key, stake);
    if (session.terminal) await round.end(session);
    if (outcomeOf(key).bonus && machine.name === 'base') {
      auto = 0;
      if (await offer(stake, false)) rolling = true;
      else {
        saved = { ...saved, bonus: null };
        persist();
        message(`You kept ${money(BONUS_SPINS, stake)}.`);
      }
    } else if (outcomeOf(key).bonus) message(`${BONUS_SPINS} more bonus spins.`);
    if (ended) {
      rolling = false;
      await summarize(ended);
    }
  } catch (error: any) {
    failed = true;
    auto = 0;
    rolling = false;
    if (moving) await reels.stop(MACHINES[before.mode], before.stops, { turbo: true });
    celebrate(null);
    try {
      session = await round.restore();
      if (session?.terminal) await round.end(session);
    } catch {}
    message(error.message, true);
  } finally {
    closing = null;
    phase = 'idle';
    render();
  }
  if (failed) return;
  if (again) void spin();
  else setTimeout(next, turbo ? 250 : 600);
}
/** The next automatic spin: the rest of a bonus the player started, or autoplay. */
function next() {
  if (phase !== 'idle' || !(saved.bonus ? rolling : auto > 0)) return;
  if (!saved.bonus) auto--;
  void spin();
}
/** The Spin button and Space: spin, land the reels, or cut a celebration short and spin again. During autoplay it
 * reads Stop: it ends autoplay and lands the reels. */
function press() {
  const stopping = auto > 0;
  auto = 0;
  if (phase === 'idle' && !stopping) void spin();
  else if (phase === 'spinning') {
    slam = true;
    skip();
    reels.quickStop();
  } else if (phase === 'presenting' && !stopping) {
    hurry = again = true;
    skip();
  }
  render();
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
        ...[5, 4, 3].flatMap(length => [
          Object.assign(document.createElement('span'), { textContent: String(length) }),
          Object.assign(document.createElement('b'), { textContent: `${PAYS[symbol][length - 3]}×` }),
        ]),
      );
      row.append(cell, pays);
      return row;
    }),
  );
  for (const element of document.querySelectorAll('[data-bonus]')) element.textContent = String(BONUS_SPINS);
}
let opener: Element | null = null;
/** Open or close the paytable; closing returns focus to where it was: a button for the keyboard, none for a click. */
function showPaytable(open: boolean) {
  if (open) opener = document.activeElement;
  $('paytable').classList.toggle('hidden', !open);
  document.querySelector('main')!.inert = open;
  if (open) return $('paytable-close').focus();
  $('paytable-close').blur();
  if (opener instanceof HTMLButtonElement) opener.focus();
}
function autoMenu(open: boolean) {
  $('auto-menu').classList.toggle('hidden', !open);
  $('auto').setAttribute('aria-expanded', String(open));
}

async function recover() {
  try {
    const startup = await HookedIn.initializeGame({ stakeInput });
    storageKey = `${startup.scope}:samson`;
    try {
      saved = { ...saved, ...JSON.parse(localStorage.getItem(storageKey) ?? '{}') };
    } catch {}
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

$('spin').addEventListener('click', press);
// A button clicked with the mouse lets go of focus, so Space spins rather than pressing it again.
document.addEventListener('pointerup', event => {
  if (event.pointerType === 'mouse' && document.activeElement instanceof HTMLButtonElement)
    document.activeElement.blur();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!$('paytable').classList.contains('hidden')) showPaytable(false);
    autoMenu(false);
  }
  if (event.code !== 'Space' || event.repeat) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
  if (!$('paytable').classList.contains('hidden') || phase === 'choosing') return;
  event.preventDefault();
  press();
});
/** Move the bet one step along a 1-2-5 ladder; an unreadable bet is left alone. */
function stepStake(up: boolean) {
  let wei: bigint;
  try {
    wei = BigInt(HookedIn.parseAmount(stakeInput.value));
  } catch {
    return;
  }
  // The ladder runs in whole METH, as every bet a player chooses does.
  const micro = BigInt(HookedIn.parseAmount('1')),
    units = wei / micro,
    magnitude = 10n ** BigInt(units.toString().length - 1);
  const next = up
    ? [1n, 2n, 5n, 10n].map(m => m * magnitude).find(value => value > units)!
    : ([5n, 2n, 1n].map(m => m * magnitude).find(value => value < units) ?? (magnitude > 1n ? magnitude / 2n : units));
  stakeInput.value = HookedIn.exactAmount(next * micro);
}
$('bet-up').addEventListener('click', () => stepStake(true));
$('bet-down').addEventListener('click', () => stepStake(false));
$('turbo').addEventListener('click', () => {
  turbo = !turbo;
  $('turbo').setAttribute('aria-pressed', String(turbo));
});
$('auto').addEventListener('click', () => {
  if (!auto) return autoMenu($('auto-menu').classList.contains('hidden'));
  // Stop autoplay; the spin under way finishes as it would.
  auto = 0;
  render();
});
$('auto-menu').addEventListener('click', event => {
  const spins = Number((event.target as HTMLElement).dataset.spins);
  if (!spins) return;
  autoMenu(false);
  auto = spins;
  next();
  render();
});
document.addEventListener('click', event => {
  if (!(event.target as Element).closest('#auto, #auto-menu')) autoMenu(false);
});
$('buy').addEventListener('click', async () => {
  if (phase !== 'idle' || saved.bonus) return;
  let stake: string;
  try {
    stake = HookedIn.parseAmount(stakeInput.value);
  } catch (error: any) {
    return message(error.message, true);
  }
  if (!(await offer(stake, true))) return;
  saved = { ...saved, bonus: { left: BONUS_SPINS, played: 0, won: 0, stake } };
  persist();
  render();
  void spin();
});
const renderMute = () => $('mute').setAttribute('aria-pressed', String(sound.muted));
$('mute').addEventListener('click', () => {
  sound.setMuted(!sound.muted);
  sound.unlock();
  renderMute();
});
$('info').addEventListener('click', () => showPaytable(true));
$('paytable-close').addEventListener('click', () => showPaytable(false));
$('paytable').addEventListener('click', event => {
  if (event.target === $('paytable')) showPaytable(false);
});

reels.show(MACHINES.base, IDLE);
renderMute();
paytable();
render();
void recover();
