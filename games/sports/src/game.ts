/**
 * A sports book. Every market is a pot of the book's own: its operator names the outcomes and the odds, and
 * resolves the market once the result is known. The page asks the book for a quote, and the wallet enters the
 * market's pot at it, by itself. Once the market has ended the same request to the wallet returns the verified
 * receipt with what the bet was paid: the developer's bank at the casino pays the winners what the pot cannot.
 */
import { HookedIn } from '@hookedin/play/sdk/sdk';
import type { GameReceipt, WirePrize } from '@hookedin/play/sdk/sdk';
import { mountBank } from '@hookedin/play/sdk/bank';

interface Market {
  id: string;
  title: string;
  outcomes: { name: string; odds: number }[];
  closesAt: number;
  deadline: number;
  pots: Record<string, string>;
  status: 'open' | 'resolved' | 'void';
  winner?: number;
}
/** A bet the wallet was asked to sign, saved first so that a reload finds it under the same name. */
interface Slip {
  id: string;
  market: string;
  label: string;
  pot: string;
  stake: string;
  prizes: WirePrize[];
  quote: { expiresAt: string; signature: string };
  receipt?: GameReceipt;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** Settled bets kept on the page. */
const KEEP = 20;

(() => {
  'use strict';
  const bank = mountBank($('bank')),
    stakeInput = $<HTMLInputElement>('stake');
  let scope = '',
    asset = 'ETH',
    assetId = 'eth',
    ready = false,
    working = false,
    markets: Market[] = [],
    pick: { market: string; outcome: number } | null = null,
    slips: Slip[] = [];

  const message = (text: string, error = false) => {
    $('status').textContent = text;
    $('status').dataset.error = String(error);
  };
  const persist = () => localStorage.setItem(scope, JSON.stringify(slips.slice(0, KEEP)));
  /** Where a bet stands, from its verified receipt. */
  const standing = ({ receipt, prizes }: Slip) => {
    const paid = receipt?.payout === undefined ? null : BigInt(receipt.payout);
    return !receipt
      ? 'Waiting for your wallet'
      : receipt.status === 'rejected'
        ? `Declined: ${receipt.reason}`
        : paid === null
          ? `In · returns ${HookedIn.formatAmount(prizes[0]!.payout, 9)} ${asset} if it wins`
          : receipt.outcome === undefined
            ? 'Called off · refunded'
            : paid
              ? `Won ${HookedIn.formatAmount(paid, 9)} ${asset}`
              : 'Lost';
  };
  const odds = (basisPoints: number) => (basisPoints / 10000).toFixed(2);
  const open = (market: Market) =>
    market.status === 'open' && market.winner === undefined && Date.now() < market.closesAt;
  const picked = () => {
    const market = markets.find(market => market.id === pick?.market);
    return market && open(market) ? { market, outcome: market.outcomes[pick!.outcome]! } : null;
  };
  async function book(path: string, body?: unknown) {
    const response = await fetch(
      `./api${path}`,
      body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) },
    );
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'The book is unavailable.');
    return value;
  }

  // --- What the player sees ----------------------------------------------------------------

  function render() {
    const cards = markets.filter(open).map(market => {
      const card = document.createElement('article'),
        head = document.createElement('div'),
        list = document.createElement('div');
      card.className = 'market';
      head.className = 'market-head';
      head.append(
        Object.assign(document.createElement('strong'), { textContent: market.title }),
        Object.assign(document.createElement('span'), {
          textContent: `Closes ${new Date(market.closesAt).toLocaleString()}`,
        }),
      );
      list.className = 'outcomes';
      market.outcomes.forEach((outcome, i) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'outcome';
        button.disabled = working;
        button.setAttribute('aria-pressed', String(pick?.market === market.id && pick.outcome === i));
        button.append(
          Object.assign(document.createElement('span'), { textContent: outcome.name }),
          Object.assign(document.createElement('span'), { textContent: odds(outcome.odds) }),
        );
        button.addEventListener('click', () => {
          pick = { market: market.id, outcome: i };
          render();
        });
        list.append(button);
      });
      card.append(head, list);
      return card;
    });
    $('markets').replaceChildren(
      ...(cards.length
        ? cards
        : [Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No markets are open.' })]),
    );
    $('note').textContent = `${cards.length} ${cards.length === 1 ? 'market' : 'markets'} open`;
    const chosen = picked();
    $('pick').textContent = chosen ? `${chosen.outcome.name} · ${odds(chosen.outcome.odds)}` : '—';
    let stake = 0n;
    try {
      stake = BigInt(HookedIn.parseAmount(stakeInput.value));
    } catch {}
    $('returns').textContent = HookedIn.formatAmount(chosen ? (stake * BigInt(chosen.outcome.odds)) / 10000n : 0n, 9);
    const place = $<HTMLButtonElement>('place');
    place.disabled = !ready || working || !chosen || !stake;
    place.textContent = !ready ? 'Connecting wallet…' : working ? 'Placing…' : 'Place bet ↗';
    stakeInput.disabled = $<HTMLButtonElement>('bet-up').disabled = $<HTMLButtonElement>('bet-down').disabled = working;
    bank.setBusy(working);
    $('bets').replaceChildren(
      ...slips.map(slip => {
        const row = document.createElement('div'),
          receipt = slip.receipt;
        row.className = 'slip';
        row.dataset.won = String(Boolean(receipt?.outcome !== undefined && BigInt(receipt.payout ?? 0)));
        row.append(
          Object.assign(document.createElement('span'), {
            textContent: `${slip.label} · ${HookedIn.formatAmount(slip.stake, 9)} ${asset}`,
          }),
          Object.assign(document.createElement('span'), { textContent: standing(slip) }),
        );
        return row;
      }),
    );
  }

  // --- The bet -----------------------------------------------------------------------------

  async function place() {
    const chosen = picked();
    if (!chosen) throw new Error('That market takes no more bets.');
    const stake = HookedIn.parseAmount(stakeInput.value);
    // The book's price, signed: the wallet enters at exactly these terms or not at all.
    const { pot, prizes, quote } = await book('/quote', {
      market: chosen.market.id,
      asset: assetId,
      outcome: pick!.outcome,
      stake,
    });
    const limit = BigInt((await HookedIn.balance()).balance);
    if (BigInt(stake) > limit) {
      const funding = await HookedIn.requestFunds({ amount: BigInt(stake) - limit });
      bank.update(funding);
      if (BigInt(funding.balance) < BigInt(stake)) throw new Error('Add enough money to cover your stake.');
    }
    const slip: Slip = {
      id: crypto.randomUUID(),
      market: chosen.market.id,
      label: `${chosen.market.title}: ${chosen.outcome.name} at ${odds(chosen.outcome.odds)}`,
      pot,
      stake,
      prizes,
      quote,
    };
    slips.unshift(slip);
    persist();
    await ask(slip);
    message(
      slip.receipt?.status === 'rejected'
        ? `${slip.receipt.reason}. Your stake is back.`
        : 'Your bet is in. It is paid when the book names the winner.',
      slip.receipt?.status === 'rejected',
    );
  }
  /** Ask the wallet for a saved bet: its entry while the market is open, and once the market has ended,
   * the receipt with what it paid. */
  async function ask(slip: Slip) {
    const { id, pot, stake, prizes, quote } = slip;
    try {
      slip.receipt = await HookedIn.enter({ id, pot, stake, prizes, quote });
    } catch (error) {
      // A bet the wallet never signed is off; one it signed is asked about again.
      if (!slip.receipt && !(await HookedIn.balance()).pending) slips = slips.filter(other => other !== slip);
      throw error;
    } finally {
      persist();
    }
  }
  async function act(work: () => Promise<void>) {
    if (working) return;
    working = true;
    render();
    try {
      await work();
    } catch (error: any) {
      message(error.message, true);
    } finally {
      working = false;
      render();
    }
  }

  // --- The markets -------------------------------------------------------------------------

  /** A bet whose market has ended, or that the wallet has yet to answer for, is asked about again. */
  const unsettled = (slip: Slip) => {
    if (!slip.receipt) return true;
    if (slip.receipt.status !== 'signed' || slip.receipt.payout !== undefined) return false;
    const market = markets.find(market => market.id === slip.market);
    return !market || market.status !== 'open' || Date.now() >= market.deadline;
  };
  async function watch() {
    try {
      markets = await book('/markets');
      const due = slips.filter(unsettled);
      if (due.length && !working)
        await act(async () => {
          for (const slip of due) {
            await ask(slip);
            if (slip.receipt?.payout !== undefined) message(`${slip.label}: ${standing(slip)}.`);
          }
        });
    } catch (error: any) {
      message(error.message, true);
    }
    render();
    setTimeout(watch, 5000);
  }
  async function start() {
    try {
      const startup = await HookedIn.initializeGame({
        stakeInput,
        assetLabels: document.querySelectorAll('[data-asset]'),
      });
      asset = startup.asset;
      assetId = startup.assetId;
      scope = startup.scope;
      bank.update(startup.state);
      slips = JSON.parse(localStorage.getItem(scope) ?? '[]');
      ready = true;
      message('Pick an outcome and a stake.');
    } catch (error: any) {
      message(error.message, true);
    }
    render();
    void watch();
  }

  stakeInput.addEventListener('input', render);
  $('place').addEventListener('click', () => act(place));
  $('bet-up').addEventListener('click', () => {
    HookedIn.stepStake(stakeInput, true);
    render();
  });
  $('bet-down').addEventListener('click', () => {
    HookedIn.stepStake(stakeInput, false);
    render();
  });
  render();
  void start();
})();
