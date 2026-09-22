/** The Plinko board: pegs, buckets, balls and the session's landing histogram. It shows paths it is given. */
import { paths } from './tables.ts';

interface Ball {
  turns: boolean[];
  start: number;
  /** Milliseconds per peg row. */
  pace: number;
  /** Sideways wobble per hop, so two balls on one path do not overlap exactly. */
  wobble: number[];
  trail: { x: number; y: number }[];
  pegsHit: number;
  done: () => void;
}
export interface BoardOptions {
  reducedMotion: boolean;
  onPeg?: (row: number, rows: number) => void;
}
const label = (hundredths: number) =>
  hundredths >= 10000 ? `${hundredths / 100}` : `${Number((hundredths / 100).toFixed(2))}×`;
/** Centre buckets are cool, the rare outer ones hot. */
const hue = (bucket: number, rows: number) => 88 - 100 * (Math.abs(bucket - rows / 2) / (rows / 2));

export function mountBoard(canvas: HTMLCanvasElement, options: BoardOptions) {
  const context = canvas.getContext('2d')!;
  let rows = 8,
    multipliers: number[] = [],
    counts: number[] = [],
    balls: Ball[] = [],
    flashes = new Map<string, number>(),
    bounces = new Map<number, number>(),
    pops: { bucket: number; text: string; start: number; big: boolean }[] = [],
    hovering = false,
    frame = 0,
    width = 0,
    height = 0;

  const geometry = () => {
    const dx = width / (rows + 3),
      top = height * 0.09,
      bucketHeight = Math.min(34, height * 0.075),
      chartHeight = height * 0.1,
      bottom = height - bucketHeight - chartHeight - 14,
      dy = (bottom - top) / rows;
    return {
      dx,
      dy,
      top,
      bottom,
      bucketHeight,
      chartHeight,
      peg: Math.max(2.2, dx * 0.085),
      ball: Math.max(4, dx * 0.2),
    };
  };
  /** Where the ball is after `row` turns of which `rights` went right: above a peg, or over a bucket at the end. */
  const spot = (row: number, rights: number) => {
    const g = geometry();
    return { x: width / 2 + (rights - row / 2) * g.dx, y: g.top + row * g.dy };
  };

  function position(ball: Ball, now: number) {
    const g = geometry(),
      elapsed = (now - ball.start) / ball.pace,
      hop = Math.floor(elapsed),
      u = elapsed - hop;
    if (hop < 0) {
      // The fall from the chute onto the first peg.
      const first = spot(0, 0);
      return { x: first.x, y: first.y - g.peg - g.ball - (1 - (1 + elapsed) ** 2) * g.dy, hop };
    }
    const rights = ball.turns.slice(0, hop).filter(Boolean).length,
      from = spot(hop, rights),
      to = spot(hop + 1, rights + Number(ball.turns[hop]));
    const lift = g.peg + g.ball,
      last = hop === rows - 1,
      endY = last ? g.bottom + g.bucketHeight * 0.35 : to.y - lift;
    // A bounce: up off the peg, then gravity.
    const launch = -g.dy * 0.95,
      y = from.y - lift + launch * u + (endY - (from.y - lift) - launch) * u * u;
    return { x: from.x + (to.x - from.x) * u + ball.wobble[hop] * Math.sin(Math.PI * u) * g.dx * 0.12, y, hop };
  }

  function draw(now: number) {
    frame = 0;
    if (!width) return; // Not laid out yet; the resize observer draws once it is.
    const g = geometry();
    context.clearRect(0, 0, width, height);
    // Pegs, with the ones just struck glowing.
    for (let row = 0; row < rows; row++)
      for (let i = 0; i < row + 3; i++) {
        const x = width / 2 + (i - (row + 2) / 2) * g.dx,
          y = g.top + row * g.dy,
          struck = flashes.get(`${row}:${i}`),
          glow = struck === undefined ? 0 : Math.max(0, 1 - (now - struck) / 420);
        if (struck !== undefined && !glow) flashes.delete(`${row}:${i}`);
        if (glow) {
          context.fillStyle = `rgba(197, 239, 145, ${0.35 * glow})`;
          context.beginPath();
          context.arc(x, y, g.peg * (1.6 + 2.4 * glow), 0, Math.PI * 2);
          context.fill();
        }
        context.fillStyle = glow ? `rgb(${220 + 35 * glow}, 255, ${200 + 40 * glow})` : '#c9d6d0';
        context.beginPath();
        context.arc(x, y, g.peg, 0, Math.PI * 2);
        context.fill();
      }
    // Buckets, their labels, and the landings so far against the exact expectation.
    const landed = counts.reduce((total, count) => total + count, 0),
      tallest = Math.max(
        1,
        ...counts,
        ...counts.map((_, bucket) => (landed * Number(paths(rows, bucket))) / 2 ** rows),
      );
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (let bucket = 0; bucket <= rows; bucket++) {
      const x = width / 2 + (bucket - rows / 2) * g.dx,
        bounced = bounces.get(bucket),
        dip = bounced === undefined ? 0 : Math.sin(Math.min(1, (now - bounced) / 260) * Math.PI) * 6;
      if (bounced !== undefined && now - bounced > 260) bounces.delete(bucket);
      const w = g.dx - Math.max(2, g.dx * 0.08),
        y = g.bottom + dip,
        color = hue(bucket, rows);
      context.fillStyle = `hsl(${color} 78% ${dip ? 62 : 52}%)`;
      context.beginPath();
      context.roundRect(x - w / 2, y, w, g.bucketHeight, Math.min(7, w * 0.22));
      context.fill();
      context.fillStyle = 'rgba(0, 0, 0, 0.22)';
      context.fillRect(x - w / 2, y + g.bucketHeight - 4, w, 4);
      context.fillStyle = '#10160f';
      context.font = `700 ${Math.max(7.5, Math.min(13, w * 0.31))}px Inter, ui-sans-serif, sans-serif`;
      context.fillText(label(multipliers[bucket]), x, y + g.bucketHeight / 2 - 1, w - 2);
      const base = g.bottom + g.bucketHeight + 10 + g.chartHeight,
        expected = (((landed * Number(paths(rows, bucket))) / 2 ** rows) * g.chartHeight) / tallest,
        actual = (counts[bucket] * g.chartHeight) / tallest;
      context.fillStyle = `hsl(${color} 70% 55% / 0.75)`;
      context.fillRect(x - w / 2, base - actual, w, actual);
      if (landed) {
        context.fillStyle = 'rgba(255, 255, 255, 0.55)';
        context.fillRect(x - w / 2, base - expected - 1, w, 2);
      }
    }
    // The ball waiting in the chute while the wallet settles the wager.
    if (hovering) {
      const first = spot(0, 0);
      paint(first.x, first.y - g.peg - g.ball - g.dy + Math.sin(now / 90) * 2.5, g.ball, 0.85);
    }
    const flying: Ball[] = [];
    for (const ball of balls) {
      const at = position(ball, now);
      if (at.hop >= rows) {
        const bucket = ball.turns.filter(Boolean).length;
        counts[bucket]++;
        bounces.set(bucket, now);
        ball.done();
        continue;
      }
      while (ball.pegsHit <= at.hop && ball.pegsHit < rows) {
        const rights = ball.turns.slice(0, ball.pegsHit).filter(Boolean).length;
        flashes.set(`${ball.pegsHit}:${rights + 1}`, now);
        options.onPeg?.(ball.pegsHit, rows);
        ball.pegsHit++;
      }
      if (!options.reducedMotion) {
        ball.trail.push({ x: at.x, y: at.y });
        if (ball.trail.length > 7) ball.trail.shift();
        ball.trail.forEach((point, i) => paint(point.x, point.y, g.ball * (0.35 + 0.08 * i), 0.05 + 0.04 * i));
      }
      paint(at.x, at.y, g.ball, 1);
      flying.push(ball);
    }
    balls = flying;
    pops = pops.filter(pop => now - pop.start < 1100);
    for (const pop of pops) {
      const t = (now - pop.start) / 1100,
        x = width / 2 + (pop.bucket - rows / 2) * g.dx;
      context.globalAlpha = 1 - t * t;
      context.font = `800 ${pop.big ? 22 : 14}px Inter, ui-sans-serif, sans-serif`;
      context.fillStyle = pop.big ? '#ffe27a' : '#f4f5f4';
      context.fillText(pop.text, Math.max(30, Math.min(width - 30, x)), g.bottom - 14 - t * 46);
      context.globalAlpha = 1;
    }
    if (balls.length || hovering || flashes.size || bounces.size || pops.length) frame = requestAnimationFrame(draw);
  }
  function paint(x: number, y: number, radius: number, alpha: number) {
    const shade = context.createRadialGradient(x - radius * 0.35, y - radius * 0.4, radius * 0.1, x, y, radius);
    shade.addColorStop(0, '#fffbe8');
    shade.addColorStop(0.5, '#ffd34d');
    shade.addColorStop(1, '#e0860f');
    context.globalAlpha = alpha;
    context.fillStyle = shade;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;
  }
  const refresh = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  function resize() {
    const scale = devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    refresh();
  }
  new ResizeObserver(resize).observe(canvas);

  return {
    /** A new board. Only possible with no ball in the air; the histogram starts over. */
    configure(nextRows: number, nextMultipliers: number[]) {
      rows = nextRows;
      multipliers = nextMultipliers;
      counts = Array(rows + 1).fill(0);
      flashes.clear();
      refresh();
    },
    /** Send a ball down the given turns. Resolves when it lands in its bucket. */
    launch(turns: boolean[], fast: boolean) {
      return new Promise<void>(done => {
        const pace = options.reducedMotion ? 45 : (rows === 8 ? 230 : rows === 12 ? 185 : 155) * (fast ? 0.5 : 1);
        balls.push({
          turns,
          pace,
          start: performance.now() + pace,
          wobble: turns.map(() => Math.random() * 2 - 1),
          trail: [],
          pegsHit: 0,
          done,
        });
        refresh();
      });
    },
    pop(bucket: number, text: string, big: boolean) {
      pops.push({ bucket, text, big, start: performance.now() });
      refresh();
    },
    hover(value: boolean) {
      hovering = value;
      refresh();
    },
    get flying() {
      return balls.length;
    },
  };
}
