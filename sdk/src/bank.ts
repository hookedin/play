/** The in-game view of the wallet's spending limit for this tab, and a way to ask for more. */
import { HookedIn } from './sdk.ts';
import type { GameLimit } from './sdk.ts';
import type { RoundClient } from './round.ts';

/**
 * With a `round`, the figure leaves out the cash inside an unfinished round, which the round shows, and stands
 * still while a step settles, so it moves once a round. That cash is the player's: they keep it if they stop.
 */
export function mountBank(root: HTMLElement, options: { round?: RoundClient } = {}) {
  const element = <T extends HTMLElement>(tag: string, className: string, text = '') => {
    const node = document.createElement(tag) as T;
    node.className = className;
    node.textContent = text;
    return node;
  };
  const amount = element<HTMLElement>('strong', 'bank-amount', '—'),
    asset = element<HTMLElement>('span', 'bank-asset', 'ETH'),
    status = element<HTMLElement>('span', 'bank-status'),
    button = element<HTMLButtonElement>('button', 'bank-add', 'Adjust allowance');
  asset.setAttribute('data-asset', '');
  button.type = 'button';
  button.disabled = true;
  const figure = element<HTMLElement>('div', 'bank-figure');
  const label = element<HTMLElement>('span', 'bank-label', 'Game allowance');
  figure.append(label, amount, asset);
  root.className = 'bank';
  root.setAttribute('aria-live', 'polite');
  root.replaceChildren(figure, status, button);
  // Until the wallet pushes a balance, there is no figure to show.
  let current: GameLimit | null = null,
    busy = false,
    held = false,
    withheld = 0n,
    requesting = false,
    failure = '';
  function render() {
    if (held || options.round?.busy) return;
    const shown = BigInt(current?.balance ?? 0) - withheld - (options.round?.inHand() ?? 0n);
    amount.textContent = current ? HookedIn.formatAmount(shown < 0n ? 0n : shown) : '—';
    root.dataset.state = current?.pending ? 'pending' : (current?.balance ?? '0') === '0' ? 'empty' : 'ready';
    // The figure says the rest: the line speaks only when something needs the player.
    status.textContent = requesting
      ? 'Waiting for your wallet…'
      : failure || (current?.pending ? 'An operation is waiting in your wallet.' : '');
    status.hidden = !status.textContent;
    // Setting the limit signs nothing, so the player can do it while an operation is pending.
    button.disabled = busy || requesting;
    button.textContent = requesting ? 'Waiting…' : 'Adjust allowance';
  }
  function update(balance: (Partial<GameLimit> & { balance: string }) | undefined) {
    if (!balance) return;
    current = { balance: balance.balance, pending: balance.pending === true };
    render();
  }
  options.round?.onChange(render);
  HookedIn.onBalance(update);
  button.addEventListener('click', async () => {
    if (busy || requesting) return;
    requesting = true;
    failure = '';
    render();
    try {
      update(await HookedIn.requestFunds());
    } catch (error: any) {
      failure = error.message;
    } finally {
      requesting = false;
      render();
    }
  });
  render();
  return {
    update,
    /** Disable the button while the game settles a bet; the bridge serializes requests anyway. */
    setBusy(value: boolean) {
      busy = value;
      render();
    },
    /** Keep showing the current figures while a result is still being revealed; releasing shows the latest. */
    hold(value: boolean) {
      held = value;
      render();
    },
    /** Leave winnings out of the shown figure while they are still on their way, such as a ball in the air. */
    withhold(change: bigint) {
      withheld += change;
      render();
    },
  };
}
