import { HookedIn } from '@hookedin/play/sdk/sdk';
import { RoundClient } from '@hookedin/play/sdk/round';
import { mountBank } from '@hookedin/play/sdk/bank';
import { diceGraph } from './rules.ts';
const round = new RoundClient(HookedIn, diceGraph);
(() => {
  'use strict';
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const bank = mountBank($('bank'), { round });
  let session: import('@hookedin/play/sdk/round').RoundState | null = null;
  let busy = false;
  let ready = false;
  let connecting = true;
  let asset = 'ETH';
  function message(value: string, error = false) {
    $('status').textContent = value;
    $('status').dataset.error = String(error);
  }
  function odds() {
    const chance = Number($<HTMLInputElement>('chance').value);
    $('chance-label').innerHTML = `${(chance / 100).toFixed(2)}<span>%</span>`;
    $('multiplier').textContent = (9900 / chance).toFixed(2);
    const fill = (chance - 1000) / 80;
    $<HTMLInputElement>('chance').style.background =
      `linear-gradient(to right,var(--accent) ${fill}%,#27332c ${fill}%)`;
  }
  function setBusy(value: boolean) {
    busy = value;
    bank.setBusy(value || !ready);
    $<HTMLButtonElement>('play').disabled = value || !ready;
    for (const id of ['stake', 'chance'] as const)
      $<HTMLInputElement>(id).disabled = value || Boolean(session && !session.terminal);
    $('die').classList.toggle('rolling', value);
    $<HTMLButtonElement>('play').textContent = !ready
      ? connecting
        ? 'Connecting wallet…'
        : 'Wallet unavailable'
      : value
        ? 'Settling…'
        : session && !session.terminal
          ? 'Resume roll ↗'
          : 'Roll dice ↗';
  }
  // The roll is the verified outcome read on a 0–100 scale: wins fall under the target, losses at or above it.
  // The target is the width of the signed winning range, so a restored round shows the odds it was played at.
  function rolled(won: boolean, settlement: any) {
    if (!settlement || !/^[0-9]+$/.test(String(settlement.outcome)) || settlement.rangeStart === undefined) return '';
    const span = 2n ** 64n,
      start = BigInt(settlement.rangeStart),
      width = BigInt(settlement.rangeEnd) - start,
      offset = BigInt(settlement.outcome) - start,
      target = won ? width : span - width,
      hundredths = (n: bigint) => (Number((n * 10000n) / span) / 100).toFixed(2);
    return `Rolled ${hundredths(won ? offset : target + offset)} · wins under ${hundredths(target)}`;
  }
  function render() {
    if (!session) return;
    if (session.terminal) {
      const won = session.nodeId === 'dice:win';
      const amount = won
        ? `Won ${HookedIn.formatAmount(session.cash)} ${asset}`
        : `Lost ${HookedIn.formatAmount(session.contributed)} ${asset}`;
      const roll = rolled(won, session.settlement);
      $('die').classList.toggle('lost', !won);
      $('result-label').textContent = won ? 'A beautiful roll.' : 'The odds went the other way.';
      $('result-value').textContent = roll ? `${roll} · ${amount}` : amount;
      message(`Round settled. ${amount}.`);
    } else message('Your round is open. Resume the roll to complete it.');
    setBusy(false);
  }
  async function recover() {
    try {
      const startup = await HookedIn.initializeGame({
        stakeInput: $<HTMLInputElement>('stake'),
        assetLabels: document.querySelectorAll('[data-asset]'),
      });
      bank.update(startup.state);
      asset = startup.asset;
      // Ready before the round is restored: a round this page cannot finish is let go with a word, and
      // the player plays on.
      ready = true;
      const state = await round.restore();
      if (state && typeof state.nodeId === 'string' && state.nodeId.startsWith('dice:')) {
        session = state;
        render();
        if (state.terminal && BigInt(state.balance) === 0n)
          message('Your last roll was restored. Its value is already in your wallet; add funds to keep playing.');
      }
      round.watch(() => {
        if (busy) return;
        session = round.state();
        if (session) render();
      });
    } catch (error: any) {
      message(error.message, true);
    } finally {
      connecting = false;
      setBusy(false);
    }
  }
  $<HTMLInputElement>('chance').addEventListener('input', odds);
  $<HTMLButtonElement>('play').addEventListener('click', async () => {
    if (busy || !ready) return;
    setBusy(true);
    $('die').classList.remove('lost');
    message('The game prepares your casino bet. The wallet verifies its settlement.');
    try {
      if (!session || session.terminal) {
        const stake = HookedIn.parseAmount($<HTMLInputElement>('stake').value);
        session = await round.start({ stake, chanceBps: Number($<HTMLInputElement>('chance').value) });
      }
      if (!session.terminal) session = await round.action('roll');
      render();
    } catch (error: any) {
      try {
        session = await round.restore();
      } catch {}
      message(error.message, true);
    } finally {
      setBusy(false);
    }
  });
  odds();
  setBusy(false);
  recover();
})();
