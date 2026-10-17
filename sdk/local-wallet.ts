/** The local wallet `hookedin-game serve` serves at http://localhost:<port>/: the game, served beside it at
 * http://127.0.0.1:<port>/ or elsewhere, framed as the wallet frames a game, with pretend money. This page is the
 * wallet's top bar and its bridge; the wallet itself runs in serve, against a stand-in casino the game's server plays
 * against too (local-casino.ts), and the page asks it everything. The wallet and the bridge are the wallet's own, so a
 * game behaves here as it does at play.hookedin.com. */
import { attachGameBridge, gameError } from '../client/bridge.ts';
import { METH } from './src/wire.ts';
import { decode, encode } from './local-json.ts';

/** The URL of a game served elsewhere, which serve builds this page with; empty for the game it serves itself. */
declare const GAME: string;
const url = GAME || `http://127.0.0.1:${location.port}/`;
const $ = (id: string) => document.getElementById(id)!;
const frame = document.createElement('iframe');
frame.title = 'Your game, a sandboxed game';
frame.referrerPolicy = 'no-referrer';
frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
frame.setAttribute(
  'allow',
  "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; fullscreen 'none'",
);

/** Why the last thing asked of the wallet failed, if it did. */
const show = (problem = '') => void ($('problem').textContent = problem);
/** What the wallet answers `path` with, asked `value`. */
async function ask(path: string, value: unknown) {
  const { result, error } = decode(await (await fetch(path, { method: 'POST', body: encode(value) })).text());
  if (error) throw gameError(error.code, error.message);
  show();
  return result;
}

const { push } = attachGameBridge({
  iframe: frame,
  origin: new URL(url).origin,
  isCurrent: () => true,
  onRequest: async (method, params) => {
    const answer = await ask('/wallet', { method, params });
    // The wallet's proof of a bet is its own page; here it is the receipt, in the console.
    if (method !== 'wallet.showBet') return answer;
    console.log('HookedIn bet', answer);
    return null;
  },
  onError: show,
});
// What the top bar shows, as it changes, and what the wallet tells the game.
new EventSource('/events').addEventListener('message', ({ data }) => {
  const [event, fields] = decode(data);
  if (event !== 'wallet') return push(event, fields);
  $('balance').textContent = fields.balance;
  $('allowance').textContent = fields.allowance;
});

$('allow').addEventListener('submit', async event => {
  event.preventDefault();
  const typed = ($('amount') as HTMLInputElement).value.trim();
  try {
    if (!/^(?:0|[1-9]\d*)$/.test(typed)) throw new Error('Enter a whole number of METH.');
    await ask('/allowance', BigInt(typed) * METH);
  } catch (error: any) {
    show(error.message);
  }
});
// The game's page again, in place: it keeps its allowance, as it does in the wallet.
$('reload').addEventListener('click', () => frame.contentWindow?.location.replace(url));
frame.src = url;
$('game').append(frame);
