import type { ClientConfig } from './config.ts';
import * as read from '../protocol/read.ts';
import { h } from './activity.ts';
import config from './config.ts';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const short = (value: string | null | undefined) => (value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—');
/** A day, as a page says when something began. */
export const shortDate = (time: number) =>
  new Date(time).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
// The launcher names the casino and the deployment to trust in config.js.
export const { casino: casinoURL, deployment } = read.object<ClientConfig>({
  casino: read.text,
  deployment: read.deployment,
})(config);
/** The deployment's network: Ethereum, or a local Anvil chain. */
export const network =
  deployment.chainId === 1n ? 'mainnet' : deployment.chainId === 31337n ? 'local' : read.refuse('A chain');

/** Open a sheet over the page, and take the focus into it: a game frame that had it is inert under the sheet, and keys
 * and clicks would go nowhere. */
export function showSheet(dialog: HTMLDialogElement) {
  if (!dialog.open) dialog.showModal();
  if (!dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>('.close')?.focus();
}
// A sheet closes at a click outside it, as its × closes it: only one pressed and released outside, so a drag that
// selects text in it and ends outside keeps it open.
for (const sheet of document.querySelectorAll<HTMLDialogElement>('dialog.sheet')) {
  const outside = (event: MouseEvent) => {
    const box = sheet.getBoundingClientRect();
    return (
      event.target === sheet &&
      (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)
    );
  };
  let pressed = false;
  sheet.addEventListener('pointerdown', event => (pressed = outside(event)));
  sheet.addEventListener('click', event => {
    if (pressed && outside(event)) sheet.close();
    pressed = false;
  });
}
/** Show a notice above everything, an open dialog too: the top layer stacks in the order things are shown. */
export function showOnTop(notice: HTMLElement) {
  if (notice.matches(':popover-open')) notice.hidePopover();
  notice.showPopover();
}
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string, error = false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  showOnTop($('toast'));
  // A sheet open under it makes room for it at its end: one opened later covers it.
  for (const sheet of document.querySelectorAll<HTMLElement>('dialog.sheet[open]'))
    sheet.style.setProperty('--toast-room', `${$('toast').offsetHeight + 28}px`);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').hidePopover(), error ? 7500 : 4500);
}
// A toast goes at a click, and takes the room it made with it.
$('toast').addEventListener('click', () => $('toast').hidePopover());
$('toast').addEventListener('toggle', event => {
  if ((event as ToggleEvent).newState === 'closed')
    for (const sheet of document.querySelectorAll<HTMLElement>('dialog.sheet'))
      sheet.style.removeProperty('--toast-room');
});
/** Copy `text` and say `copied`. Where the browser refuses, say `refused`: with `shown`, the element that shows the
 * text is selected for the browser's own copy command, and without it, copying failed. */
export async function copyText(text: string, copied: string, refused: string, shown?: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text);
    toast(copied);
  } catch {
    if (shown) getSelection()?.selectAllChildren(shown);
    toast(refused, !shown);
  }
}
/** Save `text` as a file the player downloads. */
export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
