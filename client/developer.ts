import type { AccountGame } from '../protocol/types.ts';
import { json, same } from '../protocol/protocol.ts';
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
/** Every game this account has published, with its bank and its server, as the casino last answered: null until it
 * has. */
let owned: AccountGame[] | null = null;
/** Each game's public record by its key, as the casino last answered: null while it is asked, `{error}` when it did
 * not answer. */
const records = new Map<string, any>();
/** How many times the page has opened: each asks for the records again, and drops answers to the times before. */
let opened = 0;
/** The lobby is loaded again whenever what this account publishes changes. */
let libraryKey = '';
/** What the list of games was last drawn from. It is drawn again only when that changes: the wallet renders on every
 * poll, and a button replaced under the cursor takes the click with it. */
let shownGames = '';

const tone = (amount: bigint) => (amount < 0n ? 'negative' : amount > 0n ? 'positive' : '');
const meth = (amount: bigint) => `${formatAmount(amount)} METH`;
/** The games this account has published, as the casino has them now, and the page drawn again with them. */
async function loadOwned() {
  owned = await wallet.accountGames();
  renderDeveloper();
}
/** One of this account's games, taken down or not: where it lives, what its players staked and came out with, what
 * its bank holds, and the key its server signs with. */
function ownGame(owner: string, game: AccountGame) {
  const title = gameTitle(game.name),
    route = { owner, name: game.name },
    path = `/${owner}/${game.name}`,
    record = records.get(game.key.toLowerCase()),
    bank = BigInt(game.bank),
    own = same(game.server, wallet.address),
    published = game.takenDownAt === null,
    play = (event: Event) => {
      event.preventDefault();
      if (published) task(() => loadGame(game.url, route, true, { key: game.key, developer: wallet.address }));
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
      ['Bets', Number(totals.plays).toLocaleString('en-US')],
      ['Staked', meth(staked), '', `${exact(staked)} METH`],
      ["Players' result", signedAmount(result), tone(result), `${exact(result < 0n ? -result : result)} METH`],
      ['Expected return', expected === null ? '—' : percent(expected)],
      ['Commission earned', meth(earned), tone(earned), `${exact(earned)} METH`],
    ];
    figures = [gameFigures(rows)];
    // A developer bet stays open until the game's server settles it.
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
  const amount = h('input', {
      type: 'text',
      inputMode: 'decimal',
      autocomplete: 'off',
      placeholder: '10000',
      ariaLabel: `Amount for the bank of ${title}`,
    }),
    server = h('input', {
      type: 'text',
      autocomplete: 'off',
      spellcheck: false,
      placeholder: '0x… the address your server signs with',
      ariaLabel: `Server key of ${title}`,
    }),
    busy = uiBusy || !wallet.playable || Boolean(wallet.pending);
  const moveBank = (into: boolean) =>
    task(async () => {
      const value = typedAmount(amount.value.trim());
      if (value <= 0n) throw new Error(`Enter how much to ${into ? 'put into' : 'take out of'} the bank.`);
      if (into) {
        const receipt = await wallet.depositBank(game, value);
        if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this deposit.');
        toast(`Put ${exact(value)} METH in the bank of ${title}.`);
      } else {
        await wallet.withdrawBank(game, value);
        toast(`Took ${exact(value)} METH out of the bank of ${title}. It is on its way to your balance.`);
        await wallet.collectPayouts();
      }
      await loadOwned();
    });
  const nameServer = (address: string) =>
    task(async () => {
      await wallet.setGameServer(game.key, address);
      toast(
        same(address, wallet.address)
          ? `${title} is run with your own key again.`
          : `${title}'s server signs with ${address} from now on.`,
      );
      await loadOwned();
    });
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
        ...(published ? [h('a', { href: path, onclick: play }, `${location.host}${path}`)] : []),
        h(
          'a',
          { href: game.url, target: '_blank', rel: 'noopener noreferrer' },
          `${published ? 'Served' : 'Last served'} from ${game.url} ↗`,
        ),
        h('code', { title: 'The game’s key: your server names the game by it' }, game.key),
      ),
      h(
        'span',
        { className: 'game-line-when' },
        published ? `Published ${shortDate(game.createdAt)}` : `Taken down ${shortDate(game.takenDownAt!)}`,
      ),
    ),
    ...figures,
    h(
      'div',
      { className: 'game-bank' },
      h(
        'p',
        null,
        h('span', { className: 'label' }, 'Its bank '),
        h('strong', { title: `${exact(bank)} METH` }, meth(bank)),
      ),
      h(
        'p',
        { className: 'game-line-note' },
        'Half the commission of its casino bets and the stakes of its developer bets go in; its settlements and its ' +
          'own casino bets come out. Take money out into your balance any time.',
      ),
      h(
        'div',
        { className: 'field-row' },
        h('div', { className: 'amount-input' }, amount, h('span', null, 'METH')),
        h('button', { type: 'button', className: 'button', disabled: busy, onclick: () => moveBank(true) }, 'Put in'),
        h(
          'button',
          { type: 'button', className: 'button', disabled: busy, onclick: () => moveBank(false) },
          'Take out',
        ),
      ),
    ),
    h(
      'div',
      { className: 'game-bank' },
      h(
        'p',
        null,
        h('span', { className: 'label' }, 'Its server signs with '),
        own ? h('strong', null, 'your own key') : h('code', null, game.server),
      ),
      h(
        'p',
        { className: 'game-line-note' },
        own
          ? 'Name a key of its own for a server that settles its developer bets: that key spends the game’s bank and ' +
              'nothing else, never your balance, your other games or where this one is served.'
          : 'That key alone settles its developer bets, opens its rounds and places its casino bets from its bank.',
      ),
      h(
        'div',
        { className: 'field-row' },
        server,
        h(
          'button',
          {
            type: 'button',
            className: 'button',
            disabled: uiBusy,
            onclick: () => {
              const address = server.value.trim();
              if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return toast('Enter the address your server signs with.', true);
              nameServer(address);
            },
          },
          'Name server',
        ),
        ...(own
          ? []
          : [
              h(
                'button',
                {
                  type: 'button',
                  className: 'text-button',
                  disabled: uiBusy,
                  onclick: () => nameServer(wallet.address),
                },
                'Use my own key',
              ),
            ]),
      ),
    ),
    h(
      'div',
      { className: 'game-actions' },
      published
        ? h('a', { className: 'button small primary', href: path, onclick: play }, 'Play')
        : h(
            'button',
            {
              type: 'button',
              className: 'button small primary',
              title: `Publish ${owner}/${game.name} again at ${game.url}, with its bank and its record.`,
              disabled: uiBusy || !wallet.playable || wallet.recoveryOnly,
              onclick: () =>
                task(async () => {
                  await wallet.publishGame(game.name, game.url);
                  await loadLibrary();
                  await loadOwned();
                  toast(`${owner}/${game.name} is published again.`);
                }),
            },
            'Publish again',
          ),
      h(
        'button',
        { type: 'button', className: 'button small', onclick: () => void openGameRecord(game.key.toLowerCase()) },
        'Every bet in it ↗',
      ),
      ...(published
        ? [
            h(
              'button',
              {
                type: 'button',
                className: 'text-button',
                title: `Take ${owner}/${game.name} out of the lobby. It keeps its bank and its record, and publishing it again brings it back.`,
                disabled: uiBusy,
                onclick: () =>
                  task(async () => {
                    await wallet.publishGame(game.name, null);
                    await loadLibrary();
                    await loadOwned();
                    toast(`${owner}/${game.name} is taken down.`);
                  }),
              },
              'Take down',
            ),
          ]
        : []),
    ),
  );
}
/** The developer page: every game this account publishes, each with its record, its bank and its server, and the ones
 * it took down. */
export function renderDeveloper() {
  const name = wallet.uname ? showName(wallet) : null,
    games = owned ?? [],
    live = games.filter(game => game.takenDownAt === null),
    down = games.filter(game => game.takenDownAt !== null),
    banked = games.reduce((sum, game) => sum + BigInt(game.bank), 0n);
  $<HTMLButtonElement>('publish-game').disabled = uiBusy || !wallet.playable || wallet.recoveryOnly;
  $('developer-banks').textContent = owned ? formatAmount(banked) : '—';
  $('developer-banks').title = `${exact(banked)} METH`;
  $('published-count').textContent = `${live.length}/${MAX_GAMES}`;
  $('published-empty').classList.toggle('hidden', !owned || live.length > 0);
  $('taken-down').classList.toggle('hidden', !down.length);
  const key = json([name, wallet.profile?.games ?? []]);
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
  const shown = json([
    key,
    games,
    games.map(game => records.get(game.key.toLowerCase()) ?? null),
    uiBusy,
    wallet.playable,
    Boolean(wallet.pending),
  ]);
  if (shown === shownGames || !name) return;
  shownGames = shown;
  $('published-games').replaceChildren(...live.map(game => ownGame(name, game)));
  $('taken-down-games').replaceChildren(...down.map(game => ownGame(name, game)));
}
/** Open the developer page afresh: every game asked for again, with its bank, its server and its record. */
export function refreshDeveloper() {
  opened++;
  records.clear();
  renderDeveloper();
  void loadOwned().catch(() => {});
}

act('publish-game', async () => {
  const name = $<HTMLInputElement>('game-name-input'),
    url = $<HTMLInputElement>('game-url-input');
  const published = name.value.trim();
  if (!GAME_NAME.test(published)) throw new Error('A game name is 1 to 32 lowercase letters, digits or hyphens.');
  await wallet.publishGame(published, gameURL(url.value.trim()).href);
  name.value = url.value = '';
  await loadLibrary();
  await loadOwned();
  toast(`Published at ${showName(wallet)}/${published}.`);
});
