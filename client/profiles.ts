import { json } from '../protocol/protocol.ts';
import { exact, h, signedAmount } from './activity.ts';
import { formatAmount } from '../sdk/src/wire.ts';
import { $, showName, toast, typedAmount } from './page.ts';
import { navigate } from './routes.ts';
import { act, lookUpPayee, openWallet, renderWallet, task, uiBusy, wallet } from './sheet.ts';
import { gameURL, HOUSE, loadLibrary, profileCards } from './games.ts';

const GAME_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** How many games one profile holds. */
const MAX_GAMES = 100;
/** The page at a player's name: the name, and their profile once the casino answers, or `missing` when nobody goes by
 * it. */
let shown: { name: string; profile: any; missing: boolean } | null = null;
/** The code Settings shows to run /verify with in the HookedIn Discord, while it lasts. */
let verifying: { code: string; expires: number } | null = null;
/** Ask the casino every few seconds, while the code lasts, whether its member ran /verify with it: the account then goes
 * by their Discord username. */
async function watchVerify(code: { code: string; expires: number }, before: number | null) {
  while (verifying === code && Date.now() < code.expires) {
    await new Promise(resolve => setTimeout(resolve, 4000));
    const profile = await wallet.refreshOwnProfile().catch(() => null);
    if (verifying === code && profile?.discordUsername && profile.discordVerified !== before) {
      toast(`You go by @${profile.discordUsername} now.`);
      break;
    }
  }
  if (verifying === code) verifying = null;
  renderWallet();
}
/** Whether the page shown is this account's own. */
const ownPage = () =>
  Boolean(wallet.uname) &&
  (shown?.profile?.uname === wallet.uname || (Boolean(shown?.missing) && shown?.name === `~${wallet.uname}`));
const shortDate = (time: number) =>
  new Date(time).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
/** Anybody's page: their names, what they have played, and the games they publish. */
export async function openProfile(name: string, push = true) {
  const page: typeof shown = { name, profile: null, missing: false };
  shown = page;
  $('profile-name').textContent = name;
  $('profile-meta').textContent = '';
  $('profile-transfer').hidden = true;
  $('profile-stats').textContent = 'Loading…';
  $('profile-games-heading').classList.add('hidden');
  $('profile-games').replaceChildren();
  navigate('profile', push, `/${name}`);
  try {
    const profile = await wallet.api(`/api/players/${name}`);
    if (shown !== page) return;
    drawProfile((page.profile = profile));
  } catch (error: any) {
    if (shown !== page) return;
    page.missing = error.code === 'not-found';
    $('profile-meta').textContent = page.missing ? 'Nobody goes by that name.' : error.message;
    $('profile-stats').textContent = '';
  }
  renderWallet();
}
/** A player's profile, as anybody sees it, or your own before the casino has met you (`unmet`). */
function drawProfile(profile: any) {
  const name = showName(profile);
  document.title = `${name} · HookedIn`;
  $('profile-name').textContent = name;
  // The uname a Discord username covers up, and when they last verified it.
  const meta = profile.discordUsername ? ['~' + profile.uname] : [];
  if (profile.discordVerified) meta.push(`Verified on Discord ${shortDate(profile.discordVerified)}`);
  if (profile.unmet)
    meta.push('Others see your page from your first deposit, or once you verify your Discord account.');
  $('profile-meta').textContent = meta.join(' · ');
  const plays = profile.stats.plays,
    net = BigInt(profile.stats.net);
  $('profile-stats').replaceChildren(
    ...(plays
      ? [
          h('strong', null, String(plays)),
          plays === 1 ? ' bet · ' : ' bets · ',
          h('strong', { className: net < 0n ? 'negative' : net > 0n ? 'positive' : '' }, signedAmount(net)),
          ' net',
        ]
      : ['No bets yet.']),
  );
  $('profile-game-total').textContent = String(profile.games.length);
  $('profile-games-heading').classList.toggle('hidden', !profile.games.length);
  $('profile-games').replaceChildren(...profileCards(name, profile.games));
}
/** The lobby is loaded again whenever what this account publishes changes. */
let libraryKey = '';
/** The account's own names, in the top bar, its menu and its own page, and the games it publishes. */
export function renderProfile() {
  const name = wallet.uname ? showName(wallet) : null,
    open = wallet.playable && !wallet.recoveryOnly,
    // A name is the account's from the start, and so is its page: others see it once the casino has met the account.
    page = name ? `/${name}` : null;
  $('account-name').textContent = name ?? 'Account';
  $('menu-name').textContent = name ?? 'Your account';
  // The uname is always there; when a Discord username covers it up, it is shown underneath.
  const uname = wallet.discordUsername && wallet.uname ? '~' + wallet.uname : '';
  $('menu-uname').textContent = uname;
  if (page) $<HTMLAnchorElement>('menu-profile').href = page;
  else $('menu-profile').removeAttribute('href');
  // Your own page: the way to your name, and before the casino has met you, the page itself.
  if (shown?.missing && ownPage()) {
    shown.missing = false;
    drawProfile(
      (shown.profile = {
        uname: wallet.uname,
        discordUsername: null,
        discordVerified: null,
        stats: { plays: 0, net: '0' },
        games: [],
        unmet: true,
      }),
    );
  }
  // Anybody else's page offers to transfer to them.
  $('profile-transfer').hidden = !shown?.profile || ownPage();
  $<HTMLButtonElement>('publish-game').disabled = uiBusy || !open;
  for (const id of ['bank-deposit', 'bank-withdraw'])
    $<HTMLButtonElement>(id).disabled = uiBusy || !wallet.playable || Boolean(wallet.pending);
  // Your own page, while it shows, follows the name /verify gives you, or unlinking takes away.
  const own = wallet.profile;
  if (
    own &&
    ownPage() &&
    !$('page-profile').classList.contains('hidden') &&
    (shown!.profile.discordUsername !== own.discordUsername || shown!.profile.discordVerified !== own.discordVerified)
  )
    drawProfile((shown!.profile = own));
  // Your own page: how to go by your Discord username. A member of the HookedIn Discord gives it to the account by
  // running /verify there with a code the casino gives here.
  const discord = wallet.config?.discord ?? null,
    verified = Boolean(wallet.discordUsername),
    when = wallet.profile?.discordVerified;
  $('discord').hidden = !ownPage() || !discord || wallet.discordUsername === HOUSE;
  if (discord) $<HTMLAnchorElement>('open-discord').href = discord;
  $('discord-text').textContent = verifying
    ? 'Discord tells the casino your username as you run /verify, and at no other time.'
    : verified
      ? `You go by your Discord username, @${wallet.discordUsername}${when ? `, verified ${shortDate(when)}` : ''}. Discord tells the casino your username only as you run /verify: verify again after you change it there.`
      : `Go by your Discord username here instead of your uname, ~${wallet.uname}. It takes no deposit.`;
  $('discord-steps').hidden = verified && !verifying;
  $('verify').hidden = !verifying;
  if (verifying) $('verify-code').textContent = verifying.code;
  $('verify-discord').textContent = verified ? 'Verify again' : 'Verify with Discord';
  $('verify-discord').classList.toggle('primary', !verified);
  $('verify-discord').classList.toggle('hidden', Boolean(verifying));
  $<HTMLButtonElement>('verify-discord').disabled = uiBusy || !wallet.uname;
  $('unlink-discord').classList.toggle('hidden', !verified || Boolean(verifying));
  $<HTMLButtonElement>('unlink-discord').disabled = uiBusy;
  const games = wallet.profile?.games ?? [];
  $('profile-game-count').textContent = `${games.length}/${MAX_GAMES}`;
  const key = json([name, games]);
  if (libraryKey && libraryKey !== key) void loadLibrary();
  libraryKey = key;
  $('my-games').replaceChildren(
    ...games.map(game =>
      h(
        'div',
        { className: 'game-row' },
        h('span', null, `${name}/${game.name} · ${game.url}`),
        h(
          'button',
          {
            type: 'button',
            className: 'text-button',
            title: `Take ${name}/${game.name} out of the lobby`,
            disabled: uiBusy,
            onclick: () =>
              task(async () => {
                await wallet.publishGame(game.name, null);
                await loadLibrary();
                toast(`${name}/${game.name} is taken down.`);
              }),
          },
          'Take down',
        ),
      ),
    ),
  );
}
/** This account's bank as a developer, as the casino has it now. */
export async function refreshBank() {
  if (!wallet.channel?.registered) return void ($('bank-balance').textContent = '—');
  const { balance } = await wallet.bankBalance();
  $('bank-balance').textContent = `${formatAmount(balance, 0)} µETH`;
  $('bank-balance').title = `${exact(balance)} µETH`;
}

// Another player's page opens Transfer to them.
$('profile-transfer').addEventListener('click', () => {
  $<HTMLInputElement>('transfer-to').value = showName(shown!.profile);
  openWallet('transfer');
  lookUpPayee();
});
act('verify-discord', async () => {
  verifying = await wallet.discordCode();
  void watchVerify(verifying, wallet.profile?.discordVerified ?? null);
});
$('copy-verify-code').addEventListener('click', async () => {
  if (!verifying) return;
  try {
    await navigator.clipboard.writeText(verifying.code);
    toast('Code copied. Paste it into /verify in the HookedIn Discord.');
  } catch {
    getSelection()?.selectAllChildren($('verify-code'));
    toast('The code is selected. Copy it with your browser’s copy command.');
  }
});
act(
  'unlink-discord',
  () => wallet.unlinkDiscord(),
  () => `You go by ~${wallet.uname} again.`,
);
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
  toast(`Put ${exact(amount)} µETH in your bank.`);
  await refreshBank();
});
act('bank-withdraw', async () => {
  const amount = typedAmount($<HTMLInputElement>('bank-amount').value.trim());
  await wallet.withdrawBank(amount);
  $<HTMLInputElement>('bank-amount').value = '';
  toast(`Took ${exact(amount)} µETH out of your bank. It is on its way to your balance.`);
  await wallet.collectPayouts();
  await refreshBank();
});
$('menu-profile').addEventListener('click', event => {
  event.preventDefault();
  $('account-menu').hidePopover?.();
  if (wallet.uname) void openProfile(showName(wallet));
});
