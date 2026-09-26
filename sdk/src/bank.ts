/** The in-game view of the wallet's spending limit for this tab, and a way to ask for more. */
import { HookedIn } from './sdk.ts';
import type { GameBalance } from './sdk.ts';
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
    asset = element<HTMLElement>('span', 'bank-asset'),
    status = element<HTMLElement>('span', 'bank-status', 'Connecting wallet…'),
    button = element<HTMLButtonElement>('button', 'bank-add', 'Add funds');
  asset.setAttribute('data-asset', '');
  button.type = 'button';
  button.disabled = true;
  const figure = element<HTMLElement>('div', 'bank-figure');
  const label = element<HTMLElement>('span', 'bank-label', 'Game balance');
  figure.append(label, amount, asset);
  root.className = 'bank';
  root.setAttribute('aria-live', 'polite');
  root.replaceChildren(figure, status, button);
  let current: GameBalance = { balance: '0', pending: false },
    busy = false,
    held = false,
    withheld = 0n,
    requesting = false,
    // Until the wallet has said what it plays with, there is no figure to show.
    greeted = false;
  function render() {
    if (held || options.round?.busy) return;
    const shown = BigInt(current.balance) - withheld - (options.round?.inHand() ?? 0n);
    amount.textContent = greeted ? HookedIn.formatAmount(shown < 0n ? 0n : shown) : '—';
    root.dataset.state = current.pending ? 'pending' : current.balance === '0' ? 'empty' : 'ready';
    status.textContent = requesting
      ? 'Waiting for your wallet…'
      : current.pending
        ? 'An operation is waiting in your wallet.'
        : current.balance === '0'
          ? 'No money in this game yet. Add funds to play.'
          : 'Yours to risk here. Leaving the game returns it to your wallet.';
    // Setting the limit signs nothing, so the player can do it while an operation is pending.
    button.disabled = busy || requesting;
    button.textContent = requesting ? 'Waiting…' : current.balance !== '0' ? 'Add funds' : 'Add funds ↗';
  }
  function update(balance: (Partial<GameBalance> & { balance: string }) | undefined) {
    if (!balance) return;
    current = {
      balance: balance.balance,
      pending: balance.pending === true,
    };
    render();
  }
  /** What the wallet plays with, once it has greeted the page. */
  function greet() {
    HookedIn.hello()
      .then(hello => {
        greeted = true;
        asset.textContent = hello.asset.symbol;
        // Test coins look different from money.
        root.toggleAttribute('data-practice', hello.practice === true);
        render();
      })
      .catch(() => {});
  }
  options.round?.onChange(render);
  const listeners = new Set<(balance: GameBalance) => void>();
  HookedIn.onBalance(balance => {
    update(balance);
    // A push comes only once the wallet has greeted the page, however many tries that took.
    if (!greeted) greet();
    for (const listener of listeners) listener(balance);
  });
  button.addEventListener('click', async () => {
    if (busy || requesting) return;
    requesting = true;
    render();
    try {
      update(await HookedIn.requestFunds());
    } catch (error: any) {
      status.textContent = error.message;
    } finally {
      requesting = false;
      render();
    }
  });
  greet();
  render();
  return {
    update,
    get balance() {
      return current;
    },
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
    /** Every balance the wallet pushes, once the strip has taken it in: the game's own bets, money the player
     * added and recoveries alike. Returns a function that stops it. */
    onChange(listener: (balance: GameBalance) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
