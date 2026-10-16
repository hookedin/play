import { inbound } from './wallet-transactions.ts';
import { $, toast } from './page.ts';
import { parseRoute, route, showPage } from './routes.ts';
import { refreshWallet, renderActivity, renderWallet, showWallet, storage, wallet } from './sheet.ts';
import { loadLibrary, startup } from './games.ts';

/** Hold the wallet's lock until this tab goes: if no tab holds it, or by taking it from the tab that does. Whether this
 * tab holds it. */
const holdWallet = (steal: boolean) =>
  new Promise<boolean>(resolve =>
    navigator.locks
      .request('hookedin:wallet', steal ? { steal } : { ifAvailable: true }, lock => {
        resolve(Boolean(lock));
        return lock ? new Promise(() => {}) : null;
      })
      // Another tab took it: this one reloads, and offers to take it back.
      .catch(() => location.reload()),
  );
/** One tab has the wallet at a time. Another shows only that, and takes it when the player says so, or by itself when
 * it is shown with no tab holding it. */
async function takeWallet() {
  if (await holdWallet(false)) return;
  document.body.classList.add('elsewhere');
  await new Promise<void>(resolve => {
    let taking = false;
    const take = (steal: boolean) => {
      if (taking) return;
      taking = true;
      void holdWallet(steal).then(held => (held ? resolve() : (taking = false)));
    };
    $('use-here').addEventListener('click', () => take(true));
    document.addEventListener('visibilitychange', () => document.hidden || take(false));
  });
  document.body.classList.remove('elsewhere');
}

$('deposit-instructions').textContent = `Send ETH on ${wallet.networkName} to your deposit address`;
await takeWallet();
// Show the addressed page immediately; a game route waits for the wallet and the lobby.
const initialRoute = parseRoute(new URL(location.href));
showPage(typeof initialRoute === 'string' ? initialRoute : 'library');
if (typeof initialRoute === 'object' && 'wallet' in initialRoute) showWallet(initialRoute.wallet);
/** Something the player should know about the casino, above every page. */
function warn(message: string) {
  $('connection-banner').textContent = message;
  $('connection-banner').classList.add('warning');
  $('connection-banner').classList.remove('hidden');
}

void loadLibrary();
try {
  // Only this tab writes the wallet's records from now on: one it was taken from writes nothing more.
  await storage
    .claim()
    .then(() => wallet.start())
    .finally(startup.resolve);
  if (wallet.recoveryOnly)
    warn(
      'The casino is unavailable or has changed. Your balance stays safe in the contract: export, close, challenge and collect all work from Settings → Recovery. Playing and depositing need the casino. Reload to reconnect.',
    );
  // Everything with ETH waits for the deployment check, and a failed one shows here.
  wallet.verified.catch((error: any) => warn(`${error.shortMessage || error.message} Reload to check again.`));
  renderWallet();
  renderActivity();
  void refreshWallet();
  if (wallet.pending && !inbound(wallet.pending.kind))
    toast('An operation is saved and unfinished. Use Retry above to finish it safely.');
  await route();
} catch (error: any) {
  // Saved data the wallet cannot read says what to do itself: Start over, in Settings, stays open.
  warn(error.code === 'unreadable-state' ? error.message : `${error.shortMessage || error.message} Reload this page.`);
  for (const id of ['setup-wallet', 'add-to-balance', 'withdraw', 'transfer', 'address-send', 'import-wallet'])
    $<HTMLButtonElement>(id).disabled = true;
}
