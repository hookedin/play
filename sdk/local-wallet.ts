/** The local wallet `hookedin-game serve` serves at http://localhost:<port>/: the game served beside it at
 * http://127.0.0.1:<port>/, framed as the wallet frames a game, with pretend money. The wallet and its bridge are the
 * wallet's own, so a game behaves here as it does at play.hookedin.com; the casino is the test kit's stand-in, which
 * signs and settles by the casino's rules in this page's memory, with keys made up for it. A reload starts afresh. */
import { gameWallet } from '../testing/game-wallet.ts';
import { attachGameBridge, gameError } from '../client/bridge.ts';
import { METH, formatAmount } from './src/wire.ts';

const ETH = 10n ** 18n;
const url = `http://127.0.0.1:${location.port}/`;
// A pretend ETH to play with, against a bankroll as large as the casino's, so it covers the bets the casino covers.
const fixture = await gameWallet({ deposit: ETH, bankroll: 1000n * ETH });
const { wallet, bridge } = fixture;
wallet.openGame(fixture.identity('Your game', { url }));

const $ = (id: string) => document.getElementById(id)!;
const frame = document.createElement('iframe');
frame.title = 'Your game, a sandboxed game';
frame.referrerPolicy = 'no-referrer';
frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
frame.setAttribute(
  'allow',
  "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; fullscreen 'none'",
);

/** The balance and the game's allowance as they stand, and why the last thing asked of the wallet failed, if it did. */
function render(problem = '') {
  $('balance').textContent = `${formatAmount(wallet.playableBalance(), 0)} METH`;
  $('allowance').textContent = `${formatAmount(wallet.gameAllowance().allowance, 0)} METH`;
  $('problem').textContent = problem;
}

const { push } = attachGameBridge({
  iframe: frame,
  origin: new URL(url).origin,
  isCurrent: () => true,
  onRequest: async (method, params) => {
    // A game's server settles its developer bets with the casino itself, which is not here.
    if (method === 'game.developerBet')
      throw gameError(
        'developer-bets-not-allowed',
        'The local wallet takes casino bets and payments: developer bets need the real casino, at play.hookedin.com.',
      );
    // The wallet's proof of a bet is its own page; here it is the receipt, in the console.
    if (method === 'wallet.showBet') {
      console.log('HookedIn bet', await wallet.gameBet(params.id));
      return null;
    }
    const answer = await bridge.call(method, params);
    render();
    return answer;
  },
  onError: render,
});
bridge.onAllowance(allowance => {
  push('game.allowance', { ...allowance });
  render();
});
bridge.onReceipt(receipt => push('game.receipt', { receipt }));

$('allow').addEventListener('submit', async event => {
  event.preventDefault();
  const typed = ($('amount') as HTMLInputElement).value.trim();
  try {
    if (!/^(?:0|[1-9]\d*)$/.test(typed)) throw new Error('Enter a whole number of METH.');
    await wallet.setGameAllowance(BigInt(typed) * METH);
    render();
  } catch (error: any) {
    render(error.message);
  }
});
// The game's page again, in place: it keeps its allowance, as it does in the wallet.
$('reload').addEventListener('click', () => frame.contentWindow?.location.replace(url));
frame.src = url;
$('game').append(frame);
render();
