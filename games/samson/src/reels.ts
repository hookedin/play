/** Five spinning reels. They show strips and stops they are given; they decide nothing. */
import { ROWS } from './math.ts';
import type { Machine } from './math.ts';

interface Reel {
  readonly element: HTMLElement;
  readonly band: HTMLElement;
  readonly cells: HTMLElement[];
  strip: string;
  /** The current machine's strip, without the previous window appended for the spin's first moments. */
  pure: string;
  /** Strip index shown in the top row; it falls while symbols move down. */
  position: number;
  state: 'idle' | 'spinning' | 'landing';
  started: number;
  landing: { from: number; to: number; start: number; duration: number; done: () => void } | null;
}
export interface StopOptions {
  turbo: boolean;
  /** Reels to hold back for suspense, with the extra seconds each spins. */
  suspense?: Readonly<Record<number, number>>;
  onLand?: (reel: number) => void;
  onSuspense?: (reel: number, seconds: number) => void;
}
const mod = (value: number, length: number) => ((value % length) + length) % length;
/** Overshoots the stop slightly and settles back, like a reel against its detent. */
const BACK = 1.4;
const easeOutBack = (x: number) => 1 + (BACK + 1) * (x - 1) ** 3 + BACK * (x - 1) ** 2;

export function mountReels(root: HTMLElement, reducedMotion: boolean) {
  const reels: Reel[] = Array.from({ length: 5 }, () => {
    const element = document.createElement('div'),
      band = document.createElement('div');
    element.className = 'reel';
    band.className = 'reel-band';
    // One hidden row above the window feeds symbols in from the top.
    const cells = Array.from({ length: ROWS + 2 }, () => {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.append(Object.assign(document.createElement('div'), { className: 'art' }));
      band.append(cell);
      return cell;
    });
    element.append(band);
    return {
      element,
      band,
      cells,
      strip: 'J',
      pure: 'J',
      position: 0,
      state: 'idle' as const,
      started: 0,
      landing: null,
    };
  });
  root.replaceChildren(...reels.map(reel => reel.element));
  let speed = 30,
    frame = 0,
    last = 0;

  function draw(reel: Reel) {
    const base = Math.ceil(reel.position),
      shift = base - reel.position;
    reel.cells.forEach((cell, i) => {
      const symbol = reel.strip[mod(base + i - 1, reel.strip.length)];
      if (cell.dataset.symbol !== symbol) cell.dataset.symbol = symbol;
    });
    reel.band.style.transform = `translateY(${((shift - 1) * 100) / (ROWS + 2)}%)`;
  }
  function tick(now: number) {
    frame = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    let active = false;
    for (const reel of reels) {
      if (reel.state === 'idle') continue;
      active = true;
      if (reel.state === 'spinning') {
        // A short pull upward, then down and up to speed.
        const t = (now - reel.started) / 1000;
        if (t < 0) continue;
        reel.position += (t < 0.12 ? 2.5 : -speed * Math.min(1, (t - 0.12) / 0.25)) * dt;
        // Once the previous window has scrolled away, only the machine's own strip remains.
        if (reel.position <= reel.pure.length - ROWS - 1) reel.strip = reel.pure;
        reel.position = mod(reel.position, reel.strip.length);
      } else if (reel.landing) {
        const { from, to, start, duration, done } = reel.landing;
        const x = Math.min(1, (now - start) / duration);
        reel.position = from + (to - from) * easeOutBack(x);
        if (x === 1) {
          reel.state = 'idle';
          reel.landing = null;
          reel.element.classList.remove('blur', 'suspense');
          done();
        } else if (x > 0.45) reel.element.classList.remove('blur');
      }
      draw(reel);
    }
    if (active) frame = requestAnimationFrame(tick);
  }
  const run = () => {
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  };
  function land(reel: Reel, strip: string, stop: number, travel: number) {
    return new Promise<void>(done => {
      // At full speed the jump to the final strip is invisible; from there the reel decelerates onto its stop.
      reel.strip = strip;
      reel.state = 'landing';
      reel.landing = {
        from: stop + travel,
        to: stop,
        start: performance.now(),
        duration: (((BACK + 3) * travel) / speed) * 1000,
        done,
      };
      run();
    });
  }
  let quick: (() => void) | null = null;

  return {
    /** Show a settled window without motion. */
    show(machine: Machine, stops: readonly number[]) {
      reels.forEach((reel, i) => {
        reel.strip = reel.pure = machine.strips[i];
        reel.position = stops[i];
        reel.state = 'idle';
        draw(reel);
      });
    },
    spin(machine: Machine, turbo: boolean) {
      speed = reducedMotion ? 60 : turbo ? 46 : 30;
      const now = performance.now();
      reels.forEach((reel, i) => {
        // Keep what is on screen at the end of the new strip, so it scrolls away instead of changing in place.
        const showing = reel.cells.map(cell => cell.dataset.symbol ?? 'J').join('');
        reel.pure = machine.strips[i];
        reel.strip = reel.pure + showing;
        reel.position = reel.strip.length - ROWS - 1;
        reel.state = 'spinning';
        reel.started = now + (turbo ? 0 : i * 60);
        reel.element.classList.add('blur');
      });
      run();
    },
    /** Bring the reels to rest on `stops`, left to right. Resolves when the last one has landed. */
    async stop(machine: Machine, stops: readonly number[], options: StopOptions) {
      const gap = reducedMotion ? 0 : options.turbo ? 70 : 260;
      let skipped = false,
        wake = () => {};
      quick = () => {
        skipped = true;
        wake();
      };
      const pause = (ms: number) =>
        skipped || ms <= 0
          ? Promise.resolve()
          : new Promise<void>(resolve => {
              const timer = setTimeout(resolve, ms);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
      const landings: Promise<void>[] = [];
      for (const [i, reel] of reels.entries()) {
        const suspense = options.suspense?.[i] ?? 0;
        if (suspense && !skipped) {
          reel.element.classList.add('suspense');
          options.onSuspense?.(i, suspense);
          await pause(suspense * 1000);
        }
        landings.push(
          land(reel, machine.strips[i], stops[i], reducedMotion || options.turbo || skipped ? 3 : 5).then(() =>
            options.onLand?.(i),
          ),
        );
        if (i < reels.length - 1) await pause(gap);
      }
      await Promise.all(landings);
      quick = null;
    },
    /** Land every reel now; the result is already settled. */
    quickStop() {
      quick?.();
    },
    get stopping() {
      return quick !== null;
    },
    cell: (reel: number, row: number) => reels[reel].cells[row + 1],
    clearMarks() {
      for (const reel of reels) for (const cell of reel.cells) cell.classList.remove('win', 'dim', 'scatter-hit');
    },
    element: (reel: number) => reels[reel].element,
  };
}
