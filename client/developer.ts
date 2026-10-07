import type { AccountGame } from '../protocol/types.ts';
import { gameSlug, json, MAX_GAME_NAME, same, validGameName } from '../protocol/protocol.ts';
import { exact, h, methLabel, percent, signedAmount } from './activity.ts';
import { formatAmount } from '../sdk/src/wire.ts';
import { measuredReturn } from './bets.ts';
import { $, short, shortDate, showName, toast, typedAmount } from './page.ts';
import { gameFigures, openGameRecord, type Figure } from './played.ts';
import { act, task, uiBusy, wallet } from './sheet.ts';
import { gameIcon, gameURL, loadGame, loadLibrary } from './games.ts';

/** Why a name is not one a game can be published under. */
const NAME_RULE = `A game name is 1 to ${MAX_GAME_NAME} characters, at least one of them a letter from A to Z or a digit.`;
/** How many games one profile holds. */
const MAX_GAMES = 100;
/** Every game this account has published, with its bank and its server, as the casino last answered: null until it
 * has. */
let owned: AccountGame[] | null = null;
/** Each game's public record by its ID, as the casino last answered: null while it is asked, `{error}` when it did
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
/** One setting of a game on the developer page: its label and what it is now, beside the field that changes it, a
 * note on what changing it does, and anything else it offers. */
const setting = (label: string, value: Node | null, field: Node, note?: string, ...more: Node[]) => [
  h('div', { className: 'game-setting-name' }, h('span', null, label), ...(value ? [value] : [])),
  h(
    'div',
    { className: 'game-setting-field' },
    field,
    ...(note ? [h('p', { className: 'game-line-note' }, note, ...more.flatMap(node => [' ', node]))] : more),
  ),
];
/** One of this account's games, taken down or not: where it lives, what its players staked and came out with, what
 * its bank holds, and the key its server signs with. */
function ownGame(owner: string, game: AccountGame) {
  const route = { owner, slug: game.slug },
    path = `/${owner}/${game.slug}`,
    record = records.get(game.id),
    bank = BigInt(game.bank),
    own = same(game.server, wallet.address),
    published = game.takenDownAt === null,
    play = (event: Event) => {
      event.preventDefault();
      if (published) task(() => loadGame(game.url, route, true, { ...game, developer: wallet.address }));
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
      ariaLabel: `Amount for the bank of ${game.name}`,
    }),
    server = h('input', {
      type: 'text',
      autocomplete: 'off',
      spellcheck: false,
      placeholder: '0x… your server’s address',
      ariaLabel: `Server key of ${game.name}`,
    }),
    rename = h('input', {
      type: 'text',
      autocomplete: 'off',
      spellcheck: false,
      placeholder: game.name,
      ariaLabel: `New name for ${game.name}`,
    }),
    busy = uiBusy || !wallet.playable || Boolean(wallet.pending);
  const moveBank = (into: boolean) =>
    task(async () => {
      const value = typedAmount(amount.value.trim());
      if (value <= 0n) throw new Error(`Enter how much to ${into ? 'put into' : 'take out of'} the bank.`);
      if (into) {
        const receipt = await wallet.depositBank(game, value);
        if (receipt.status === 'rejected') throw new Error(receipt.reason || 'The casino declined this deposit.');
        toast(`Put ${exact(value)} METH in the bank of ${game.name}.`);
      } else {
        await wallet.withdrawBank(game, value);
        toast(`Took ${exact(value)} METH out of the bank of ${game.name}. It is on its way to your balance.`);
        await wallet.collectPayouts();
      }
      await loadOwned();
    });
  const nameServer = (address: string) =>
    task(async () => {
      await wallet.setGameServer(game.id, address);
      toast(
        same(address, wallet.address)
          ? `${game.name} is run with your own key again.`
          : `${game.name}'s server signs with ${address} from now on.`,
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
        { className: 'game-line-icon', href: path, onclick: play, ariaLabel: `Play ${game.name}` },
        gameIcon(game.url, game.name),
      ),
      h(
        'div',
        { className: 'game-line-names' },
        h('h3', null, game.name),
        ...(published ? [h('a', { href: path, onclick: play }, `${location.host}${path}`)] : []),
        h(
          'a',
          { href: game.url, target: '_blank', rel: 'noopener noreferrer' },
          `${published ? 'Served' : 'Last served'} from ${game.url} ↗`,
        ),
        h('code', { title: 'The game’s ID: your server names the game by it' }, game.id),
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
      { className: 'game-settings' },
      ...setting(
        'Bank',
        h('strong', { title: `${exact(bank)} METH` }, meth(bank)),
        h(
          'div',
          { className: 'field-row' },
          h('div', { className: 'amount-input' }, amount, h('span', null, methLabel())),
          h('button', { type: 'button', className: 'button', disabled: busy, onclick: () => moveBank(true) }, 'Put in'),
          h(
            'button',
            { type: 'button', className: 'button', disabled: busy, onclick: () => moveBank(false) },
            'Take out',
          ),
        ),
      ),
      ...setting(
        'Server key',
        own ? h('strong', null, 'Your own key') : h('code', { title: game.server }, short(game.server)),
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
                if (!/^0x[0-9a-fA-F]{40}$/.test(address))
                  return toast('Enter the address your server signs with.', true);
                nameServer(address);
              },
            },
            'Name server',
          ),
        ),
        own
          ? 'A key of its own settles its developer bets and spends its bank, and nothing else: never your balance, ' +
              'your other games or where the game is served.'
          : 'That key alone settles its developer bets, opens its rounds and places its casino bets from its bank.',
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
      ...(published
        ? setting(
            'Name',
            null,
            h(
              'div',
              { className: 'field-row' },
              rename,
              h(
                'button',
                {
                  type: 'button',
                  className: 'button',
                  disabled: busy,
                  onclick: () =>
                    task(async () => {
                      const name = rename.value.trim();
                      if (!validGameName(name)) throw new Error(NAME_RULE);
                      await wallet.publishGame(name, game.url, game.id);
                      await loadLibrary();
                      await loadOwned();
                      toast(`${game.name} is ${name} now, at ${owner}/${gameSlug(name)}.`);
                    }),
                },
                'Rename',
              ),
            ),
            'Renamed, it keeps its ID, bank, server and record. Its address follows the new name, and the old one ' +
              'stops working.',
          )
        : []),
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
              title: `Publish ${game.name} again at ${game.url}, with its bank and its record.`,
              disabled: uiBusy || !wallet.playable || wallet.recoveryOnly,
              onclick: () =>
                task(async () => {
                  await wallet.publishGame(game.name, game.url);
                  await loadLibrary();
                  await loadOwned();
                  toast(`${game.name} is published again, at ${owner}/${game.slug}.`);
                }),
            },
            'Publish again',
          ),
      h(
        'button',
        { type: 'button', className: 'button small', onclick: () => void openGameRecord(game.id) },
        'Every bet in it ↗',
      ),
      ...(published
        ? [
            h(
              'button',
              {
                type: 'button',
                className: 'text-button',
                title: `Take ${game.name} out of the lobby. It keeps its bank and its record, and publishing it again brings it back.`,
                disabled: uiBusy,
                onclick: () =>
                  task(async () => {
                    await wallet.publishGame(game.name, null);
                    await loadLibrary();
                    await loadOwned();
                    toast(`${game.name} is taken down.`);
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
      const { id } = game;
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
    games.map(game => records.get(game.id) ?? null),
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

/** The address a game published under the name typed gets, or why that name is not one. */
function renderGameAddress() {
  const name = $<HTMLInputElement>('game-name-input').value.trim(),
    valid = validGameName(name);
  $('game-address').hidden = !name;
  $('game-address').textContent = valid
    ? `It lives at ${location.host}/${showName(wallet)}/${gameSlug(name)}.`
    : NAME_RULE;
  $('game-address').classList.toggle('check-failed', !valid);
}
$('game-name-input').addEventListener('input', renderGameAddress);
act('publish-game', async () => {
  const name = $<HTMLInputElement>('game-name-input'),
    url = $<HTMLInputElement>('game-url-input');
  const published = name.value.trim();
  if (!validGameName(published)) throw new Error(NAME_RULE);
  await wallet.publishGame(published, gameURL(url.value.trim()).href);
  name.value = url.value = '';
  renderGameAddress();
  await loadLibrary();
  await loadOwned();
  toast(`Published ${published} at ${showName(wallet)}/${gameSlug(published)}.`);
});
