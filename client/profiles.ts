import { h, signedAmount } from './activity.ts';
import { $, shortDate, showName, toast } from './page.ts';
import { navigate } from './routes.ts';
import { act, lookUpPayee, openWallet, renderWallet, uiBusy, wallet } from './sheet.ts';
import { HOUSE, profileCards } from './games.ts';

/** The page at a player's name: their profile once the casino answers. */
let shown: { profile: any } | null = null;
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
const ownPage = () => Boolean(wallet.uname) && shown?.profile?.uname === wallet.uname;
/** Anybody's page: their names, what they have played, and the games they publish. */
export async function openProfile(name: string, push = true) {
  const page: typeof shown = { profile: null };
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
    $('profile-meta').textContent = error.code === 'not-found' ? 'Nobody goes by that name.' : error.message;
    $('profile-stats').textContent = '';
  }
  renderWallet();
}
/** A player's profile, as anybody sees it. */
function drawProfile(profile: any) {
  const name = showName(profile);
  document.title = `${name} · HookedIn`;
  $('profile-name').textContent = name;
  // The uname a Discord username covers up, since when the casino has known them, and when they last verified it.
  const meta = profile.discordUsername ? ['~' + profile.uname] : [];
  if (profile.createdAt) meta.push(`Joined ${shortDate(profile.createdAt)}`);
  if (profile.discordVerified) meta.push(`Verified on Discord ${shortDate(profile.discordVerified)}`);
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
/** The account's own names, in the top bar, its menu and its own page. */
export function renderProfile() {
  const name = wallet.uname ? showName(wallet) : null,
    // A name is the account's from the start, and so is its page.
    page = name ? `/${name}` : null;
  $('account-name').textContent = name ?? 'Account';
  $('menu-name').textContent = name ?? 'Your account';
  // The uname is always there; when a Discord username covers it up, it is shown underneath.
  const uname = wallet.discordUsername && wallet.uname ? '~' + wallet.uname : '';
  $('menu-uname').textContent = uname;
  if (page) $<HTMLAnchorElement>('menu-profile').href = page;
  else $('menu-profile').removeAttribute('href');
  // Your own page says the name is yours; anybody else's offers to transfer to them.
  $('profile-yours').hidden = !ownPage();
  $('profile-transfer').hidden = !shown?.profile || ownPage();
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
}

// Another player's page opens Transfer to them: the amount is what is left to enter.
$('profile-transfer').addEventListener('click', () => {
  $<HTMLInputElement>('transfer-to').value = showName(shown!.profile);
  openWallet('transfer');
  lookUpPayee();
  $('transfer-amount').focus();
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
$('menu-profile').addEventListener('click', event => {
  event.preventDefault();
  $('account-menu').hidePopover?.();
  if (wallet.uname) void openProfile(showName(wallet));
});
