import { json } from '../protocol/protocol.ts';
import { exact, h, percent, signedAmount } from './activity.ts';
import { formatAmount } from '../sdk/src/wire.ts';
import { measuredReturn } from './bets.ts';
import { $, shortDate, showName, toast, typedAmount } from './page.ts';
import { gameFigures, openGameRecord, type Figure } from './played.ts';
import { act, task, uiBusy, wallet } from './sheet.ts';
import { gameIcon, gameTitle, gameURL, loadGame, loadLibrary } from './games.ts';

const GAME_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** How many games one profile holds. */
const MAX_GAMES = 100;
type PublishedGame = NonNullable<typeof wallet.profile>['games'][number];
/** Each published game's public record by its key, as the casino last answered: null while it is asked, `{error}` when
 * it did not answer. */
const records = new Map<string, any>();
/** How many times the page has opened: each asks for the records again, and drops answers to the times before. */
let opened = 0;
/** The lobby is loaded again whenever what this account publishes changes. */
let libraryKey = '';
/** What the list of games was last drawn from. It is drawn again only when that changes: the wallet renders on every
 * poll, and a button replaced under the cursor takes the click with it. */
let shownGames = '';

const tone = (amount: bigint) => (amount < 0n ? 'negative' : amount > 0n ? 'positive' : '');
/** One game this account publishes: where it lives, what its players staked and came out with, and what it earned. */
function publishedGame(owner: string, game: PublishedGame) {
  const title = gameTitle(game.name),
    route = { owner, name: game.name },
    path = `/${owner}/${game.name}`,
    record = records.get(game.key.toLowerCase()),
    play = (event: Event) => {
      event.preventDefault();
      task(() => loadGame(game.url, route, true, game));
    };
  let figures: Node[];
  if (record?.totals) {
    const totals = record.totals,
      staked = BigInt(totals.staked),
      result = BigInt(totals.paid) - staked,
      expected = measuredReturn(BigInt(totals.priced), BigInt(totals.expected)),
      earned = BigInt(totals.earned),
      { open, settled } = record.developerBets;
    const rows: Figure[] = [
      ['Bets', Number(totals.bets).toLocaleString('en-US')],
      ['Staked', `${formatAmount(staked)} METH`, '', `${exact(staked)} METH`],
      ["Players' result", signedAmount(result), tone(result), `${exact(result < 0n ? -result : result)} METH`],
      ['Expected return', expected === null ? '—' : percent(expected)],
      ['You earned', `${formatAmount(earned)} METH`, tone(earned), `${exact(earned)} METH`],
    ];
    figures = [gameFigures(rows)];
    // A developer bet stays open until this account's key settles it.
    if (open + settled)
      figures.push(h('p', { className: 'game-line-note' }, `Developer bets: ${open} open, ${settled} settled.`));
  } else
    figures = [
      h(
        'p',
        { className: 'game-line-note' },
        record?.error ? `The casino did not answer for this game. ${record.error}` : 'Loading its record…',
      ),
    ];
  return h(
    'div',
    { className: 'game-line' },
    h(
      'div',
      { className: 'game-line-heading' },
      h(
        'a',
        { className: 'game-line-icon', href: path, onclick: play, ariaLabel: `Play ${title}` },
        gameIcon(game.url, title),
      ),
      h(
        'div',
        { className: 'game-line-names' },
        h('h3', null, title),
        h('a', { href: path, onclick: play }, `${location.host}${path}`),
        h('a', { href: game.url, target: '_blank', rel: 'noopener noreferrer' }, `Served from ${game.url} ↗`),
      ),
      h('span', { className: 'game-line-when' }, `Published ${shortDate(game.createdAt)}`),
    ),
    ...figures,
    h(
      'div',
      { className: 'game-actions' },
      h('a', { className: 'button small primary', href: path, onclick: play }, 'Play'),
      h(
        'button',
        { type: 'button', className: 'button small', onclick: () => void openGameRecord(game.key.toLowerCase()) },
        'Every bet in it ↗',
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'text-button',
          title: `Take ${owner}/${game.name} out of the lobby. Publishing it again brings back its record.`,
          disabled: uiBusy,
          onclick: () =>
            task(async () => {
              await wallet.publishGame(game.name, null);
              await loadLibrary();
              toast(`${owner}/${game.name} is taken down.`);
            }),
        },
        'Take down',
      ),
    ),
  );
}
/** The developer page: what this account's games earned, its bank, and every game it publishes with its record. */
export function renderDeveloper() {
  const name = wallet.uname ? showName(wallet) : null,
    games = wallet.profile?.games ?? [],
    earnings = wallet.developerEarnings,
    earned = BigInt(earnings?.earned ?? 0),
    collected = BigInt(earnings?.collected ?? 0);
  $<HTMLButtonElement>('publish-game').disabled = uiBusy || !wallet.playable || wallet.recoveryOnly;
  for (const id of ['bank-deposit', 'bank-withdraw'])
    $<HTMLButtonElement>(id).disabled = uiBusy || !wallet.playable || Boolean(wallet.pending);
  // The tally the casino keeps for this account, which its wallet collects into its balance.
  $('developer-earned').textContent = formatAmount(earned);
  $('developer-earned').title = `${exact(earned)} METH`;
  $('developer-earned-note').textContent = !earned
    ? 'Half the commission of each casino bet in your games. Your wallet collects it into your balance by itself.'
    : earned === collected
      ? 'Half the commission of each casino bet in your games, all of it collected into your balance.'
      : `Half the commission of each casino bet in your games, ${formatAmount(collected)} METH of it collected into your balance so far.`;
  $('published-count').textContent = `${games.length}/${MAX_GAMES}`;
  $('published-empty').classList.toggle('hidden', games.length > 0);
  const key = json([name, games]);
  if (libraryKey && libraryKey !== key) void loadLibrary();
  libraryKey = key;
  // A game's record is asked for while the page shows, once, and again each time the page opens.
  if (!$('page-developer').classList.contains('hidden'))
    for (const game of games) {
      const id = game.key.toLowerCase();
      if (records.has(id)) continue;
      const asked = opened;
      records.set(id, null);
      void wallet
        .api(`/api/games/${id}?limit=1`)
        .catch((error: any) => ({ error: error.shortMessage || error.message }))
        .then(record => {
          if (asked !== opened) return;
          records.set(id, record);
          renderDeveloper();
        });
    }
  const shown = json([key, games.map(game => records.get(game.key.toLowerCase()) ?? null), uiBusy]);
  if (shown === shownGames || !name) return;
  shownGames = shown;
  $('published-games').replaceChildren(...games.map(game => publishedGame(name, game)));
}
/** Open the developer page afresh: every game's record asked for again, the bank, and what the games earned collected,
 * so the total agrees with the games'. */
export function refreshDeveloper() {
  opened++;
  records.clear();
  renderDeveloper();
  void refreshBank().catch(() => {});
  void wallet.collectPayouts().catch(() => {});
}
/** This account's bank as a developer, as the casino has it now. */
async function refreshBank() {
  if (!wallet.channel?.registered) return void ($('bank-balance').textContent = '—');
  const { balance } = await wallet.bankBalance();
  $('bank-balance').textContent = formatAmount(balance, 0);
  $('bank-balance').title = `${exact(balance)} METH`;
}

act('publish-game', async () => {
  const name = $<HTMLInputElement>('game-name-input'),
    url = $<HTMLInputElement>('game-url-input');
  const published = name.value.trim();
  if (!GAME_NAME.test(published)) throw new Error('A game name is 1 to 32 lowercase letters, digits or hyphens.');
  await wallet.publishGame(published, gameURL(url.value.trim()).href);
  name.value = url.value = '';
  await loadLibrary();
  toast(`Published at ${showName(wallet)}/${published}.`);
});
act('bank-deposit', async () => {
  const amount = typedAmount($<HTMLInputElement>('bank-amount').value.trim());
  if (amount <= 0n) throw new Error('Enter how much to put in your bank.');
  const receipt = await wallet.depositBank(amount);
  if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this deposit.');
  $<HTMLInputElement>('bank-amount').value = '';
  toast(`Put ${exact(amount)} METH in your bank.`);
  await refreshBank();
});
act('bank-withdraw', async () => {
  const amount = typedAmount($<HTMLInputElement>('bank-amount').value.trim());
  await wallet.withdrawBank(amount);
  $<HTMLInputElement>('bank-amount').value = '';
  toast(`Took ${exact(amount)} METH out of your bank. It is on its way to your balance.`);
  await wallet.collectPayouts();
  await refreshBank();
});
