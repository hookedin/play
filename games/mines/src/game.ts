import { HookedIn } from '@hookedin/play/sdk/sdk';
import { RoundClient } from '@hookedin/play/sdk/round';
import type { RoundState } from '@hookedin/play/sdk/round';
import type { Rational } from '@hookedin/play/sdk/engine';
import { TILES, coveredPicks, minesGraph, multiplier, payout } from './rules.ts';

const round = new RoundClient(HookedIn, minesGraph);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const stake = $<HTMLInputElement>('stake'),
  mines = $<HTMLSelectElement>('mines'),
  play = $<HTMLButtonElement>('play'),
  random = $<HTMLButtonElement>('random');
for (let count = 1; count < TILES; count++)
  mines.add(new Option(String(count), String(count), count === 3, count === 3));
const tiles = Array.from({ length: TILES }, (_, index) => {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.addEventListener('click', () => act('Revealing…', () => pick(index), index));
  $('board').append(tile);
  return tile;
});

/** The round on the board, the tiles its gems were found on, and the tile that hit its mine. */
let session: RoundState | null = null,
  gems: number[] = [],
  mine = -1,
  /** What the page is doing, in the button's words, and the tile it is revealing. */
  busy = '',
  revealing = -1,
  ready = false,
  connecting = true;

const amount = (wei: bigint | string) => `${HookedIn.formatAmount(wei, 8)} ETH`;
/** A multiplier to the hundredth, rounded down; whole from a thousand up. */
function times({ n, d }: Rational) {
  const hundredths = (n * 100n) / d,
    whole = hundredths / 100n;
  return `${whole.toLocaleString('en-US')}${whole < 1000n ? '.' + String(hundredths % 100n).padStart(2, '0') : ''}×`;
}
const setupOf = (state: RoundState) => state.setup as { stake: string; mines: number; picks: number };
/** The gems a round has found: its state counts them, and a lost round revealed one tile more. */
function found(state: RoundState) {
  const picked = /^mines:(?:picks|payout):(\d+)$/.exec(state.nodeId);
  return picked ? Number(picked[1]) : state.events.filter(event => event.action === 'reveal').length - 1;
}
function message(text: string, error = false) {
  $('status').textContent = text;
  $('status').dataset.error = String(error);
}

/** Put a round on the board. A gem keeps its tile; one found out of sight, before a reload or in another tab, takes
 * the first free tile, since where a gem lies changes nothing. The mine shows only on a tile this page saw picked. */
function show(state: RoundState | null, tile = -1) {
  if (state?.id !== session?.id) {
    gems = [];
    mine = -1;
  }
  session = state;
  if (!state) return;
  while (gems.length < found(state))
    gems.push(tile >= 0 && !gems.includes(tile) ? tile : tiles.findIndex((_, i) => !gems.includes(i)));
  if (state.nodeId === 'mines:loss' && tile >= 0 && !gems.includes(tile)) mine = tile;
}

function render() {
  const state = session,
    open = Boolean(state && !state.terminal),
    actions = state?.actions ?? [],
    count = state ? found(state) : 0,
    lost = state?.nodeId === 'mines:loss',
    { mines: m, stake: wei } = state ? setupOf(state) : { mines: Number(mines.value), stake: '0' },
    more = open && actions.includes('reveal'),
    picking = ready && !busy && more;
  for (const id of ['stake', 'mines', 'half', 'double']) $<HTMLInputElement>(id).disabled = Boolean(busy) || open;
  tiles.forEach((tile, i) => {
    const kind = gems.includes(i) ? 'gem' : mine === i ? 'mine' : '';
    if ((tile.dataset.kind ?? '') !== kind) {
      if (kind) tile.dataset.kind = kind;
      else delete tile.dataset.kind;
      tile.innerHTML = kind ? `<svg><use href="#${kind}"></use></svg>` : '';
    }
    tile.disabled = !picking || Boolean(kind);
    tile.classList.toggle('revealing', i === revealing);
    tile.setAttribute('aria-label', `Tile ${i + 1}${kind ? `, ${kind}` : ''}`);
  });
  $('gems').textContent = `${count}/${TILES - m}`;
  $('pays').textContent = lost ? '0.00×' : count ? times(multiplier(m, count)) : '—';
  $('next').textContent = !state ? times(multiplier(m, 1)) : more ? times(multiplier(m, count + 1)) : '—';
  const stage = $('board').closest<HTMLElement>('.stage')!;
  if (state?.terminal) stage.dataset.result = lost ? 'lost' : 'won';
  else delete stage.dataset.result;
  $('result').hidden = !state?.terminal || lost;
  if (state?.terminal && !lost) {
    $('result-times').textContent = times(multiplier(m, count));
    $('result-won').textContent = amount(state.cash);
  }
  random.disabled = !picking;
  play.disabled = !ready || Boolean(busy) || (open && !actions.includes('cash-out'));
  play.textContent = !ready
    ? connecting
      ? 'Connecting wallet…'
      : 'Wallet unavailable'
    : busy || (open ? (count ? `Cash out ${amount(payout(BigInt(wei), m, count))}` : 'Pick a tile') : 'Bet');
}

/** The casino's rule refusing a pick, in the player's words; anything else as it was said. */
function plain(error: any) {
  if (!(error instanceof RangeError)) return String(error.message);
  return session && !session.terminal && found(session)
    ? 'The casino can’t cover this pick. Cash out, or try again.'
    : 'The casino can’t cover this pick. Lower your stake or choose fewer mines.';
}
async function act(label: string, work: () => Promise<string>, tile = -1) {
  if (busy || !ready) return;
  busy = label;
  revealing = tile;
  render();
  try {
    message(await work());
  } catch (error: any) {
    try {
      // A reply lost on the way may have settled all the same: the round shows where it stands.
      const state = await round.restore();
      if (state?.id === session?.id) show(state, tile);
    } catch {}
    // A round that has found nothing holds only its stake: the player may change it instead of trying again.
    if (session && !session.terminal && !session.pending && !found(session)) show(null);
    message(plain(error), true);
  } finally {
    busy = '';
    revealing = -1;
    render();
  }
}
async function bet() {
  const wei = HookedIn.parseAmount(stake.value),
    m = Number(mines.value);
  // The allowance first: a player with nothing to allow is sent to Deposit, before the casino has priced anything.
  await round.ensureAllowance(BigInt(wei), BigInt(wei));
  const picks = coveredPicks(BigInt(wei), m, BigInt((await HookedIn.info()).virtualBankroll));
  if (!picks) throw new RangeError('no pick is covered');
  show(await round.start({ stake: wei, mines: m, picks }));
  return picks < TILES - m
    ? `Pick a tile. The casino covers ${picks} of ${TILES - m} picks at this stake.`
    : 'Pick a tile.';
}
async function pick(tile: number) {
  const state = await round.action('reveal');
  show(state, tile);
  if (state.nodeId === 'mines:loss') {
    await HookedIn.end(state.id);
    return `A mine. You lost ${amount(state.contributed)}.`;
  }
  const { mines: m, picks } = setupOf(state),
    count = found(state);
  if (count === TILES - m) return 'Every gem found. Cash out.';
  if (count === picks)
    return 'That is all the casino covers at this stake. Cash out, or lower your stake to go further.';
  return 'A gem. Pick again or cash out.';
}
async function cashOut() {
  const state = await round.action('cash-out');
  show(state);
  // The round is over on the board: what it won joins the allowance the wallet shows.
  await HookedIn.end(state.id);
  return `You cashed out ${amount(state.cash)}.`;
}

play.addEventListener('click', () =>
  session && !session.terminal ? act('Cashing out…', cashOut) : act('Starting…', bet),
);
random.addEventListener('click', () => {
  const free = tiles.flatMap((_, i) => (gems.includes(i) || i === mine ? [] : [i]));
  const tile = free[Math.floor(Math.random() * free.length)]!;
  act('Revealing…', () => pick(tile), tile);
});
/** Setting up the next round clears the last one from the board. */
function edited() {
  if (!busy && session?.terminal) show(null);
  render();
}
stake.addEventListener('input', edited);
mines.addEventListener('change', edited);
const scale = (id: string, by: (wei: bigint) => bigint) =>
  $(id).addEventListener('click', () => {
    try {
      stake.value = HookedIn.exactAmount(by(BigInt(HookedIn.parseAmount(stake.value))));
    } catch {}
    edited();
  });
scale('half', wei => (wei > 1n ? wei / 2n : wei));
scale('double', wei => wei * 2n);
// Space bets and cashes out, unless a field or a button has the key.
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || (event.target as Element).closest('input, select, button, summary'))
    return;
  event.preventDefault();
  play.click();
});

async function connect() {
  try {
    await HookedIn.initializeGame({ stakeInput: stake });
    // Ready before the round is restored: a round this page cannot finish is let go with a word, and the player
    // plays on.
    ready = true;
    round.watch(() => {
      if (busy) return;
      show(round.state());
      render();
    });
    const state = await round.restore();
    if (state) {
      show(state);
      stake.value = HookedIn.exactAmount(state.setup.stake);
      mines.value = String(setupOf(state).mines);
      message(
        !state.terminal
          ? 'Your round is back.'
          : state.nodeId === 'mines:loss'
            ? 'Your last pick found a mine.'
            : `You cashed out ${amount(state.cash)}.`,
      );
    }
  } catch (error: any) {
    message(error.message, true);
  } finally {
    connecting = false;
    render();
  }
}
render();
connect();
