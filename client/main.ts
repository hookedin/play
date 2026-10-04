import { inbound } from './wallet-transactions.ts';
import { $, casinoURL, toast } from './page.ts';
import { parseRoute, route, showPage } from './routes.ts';
import { refreshWallet, renderActivity, renderWallet, showWallet, wallet } from './sheet.ts';
import { loadLibrary, startup } from './games.ts';

$('network-name').textContent = wallet.networkName;
$('deposit-instructions').textContent =
  `Send test ETH on ${wallet.networkName} to your deposit address, never real ETH`;
$<HTMLAnchorElement>('casino-status').href = casinoURL + '/api/status';
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
  await wallet.start().finally(startup.resolve);
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
  warn(`${error.shortMessage || error.message} Reload this page.`);
  for (const id of ['setup-wallet', 'add-to-balance', 'withdraw', 'transfer', 'address-send', 'import-wallet'])
    $<HTMLButtonElement>(id).disabled = true;
}
