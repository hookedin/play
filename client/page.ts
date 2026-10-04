import { parseUnits } from 'ethers';
import { h } from './activity.ts';
import config from './config.ts';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const short = (value: string | null | undefined) => (value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—');
/** A typed amount of µETH, in wei. */
export const typedAmount = (text: string) => parseUnits(text, 12);
/** How a player is written: a Discord username wears `@`, a uname wears `~`. */
export const showName = (names: { uname?: string | null; discordUsername?: string | null } | null) =>
  names?.discordUsername ? '@' + names.discordUsername : names?.uname ? '~' + names.uname : '—';
// The launcher names the network, the casino and the deployment to trust in config.js.
export const { network, casino: casinoURL, deployment } = config;

/** Open a sheet over the page, and take the focus into it: a game frame that had it is inert under the sheet, and keys
 * and clicks would go nowhere. */
export function showSheet(dialog: HTMLDialogElement) {
  if (!dialog.open) dialog.showModal();
  if (!dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>('.close')?.focus();
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
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').hidePopover(), error ? 7500 : 4500);
}
/** Save `text` as a file the player downloads. */
export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
