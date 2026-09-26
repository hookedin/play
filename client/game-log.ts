import { formatEther } from 'ethers';
import { activityJSON, createActivityEntry, filterActivity, returnToPlayer } from './activity.ts';
import { describeBet } from '../protocol/risk.ts';

/** The live developer log for one embedded game. Session-only; the wallet's receipts are the durable record. */
export type LogKind = 'request' | 'response' | 'error' | 'event' | 'client';
export interface LogEntry {
  seq: number;
  kind: LogKind;
  title: string;
  description?: string;
  timestamp: string;
  /** Milliseconds since the previous entry. */
  elapsed: number;
  /** Milliseconds between a bridge request and this reply. */
  latency?: number;
  payload?: unknown;
}
const LIMIT = 500;
const PAYLOAD_LIMIT = 70000;
/** The asset the log's amounts are in: whatever the wallet plays with while this game is open. */
let symbol = 'ETH';
export const logAsset = (value: string) => (symbol = value);
const eth = (wei: unknown) => {
  try {
    return `${formatEther(BigInt(wei as string))} ${symbol}`;
  } catch {
    return String(wei);
  }
};
/** The whole bet at a glance: how many prizes, the most they can pay together, and the exact return. */
const betSummary = (params: any) => {
  try {
    const stake = BigInt(params.stake),
      table = describeBet({
        stake,
        prizes: params.prizes.map((prize: any) => ({
          rangeStart: BigInt(prize.rangeStart),
          rangeEnd: BigInt(prize.rangeEnd),
          payout: BigInt(prize.payout),
        })),
      });
    return `${params.prizes.length} prize${params.prizes.length === 1 ? '' : 's'} · pays up to ${eth(table.maxPayout)} · ${returnToPlayer(stake, table.expectedPayout)}`;
  } catch {
    return 'unreadable prizes';
  }
};
const quote = (text: unknown) => (typeof text === 'string' && text ? ` · “${text.slice(0, 140)}”` : '');

/** One line a developer can read without opening the payload. */
export function describeRequest(method: string, params: any = {}) {
  const named = `${params.group ? ` · group ${params.group}` : ''} · id ${params.id}`;
  switch (method) {
    case 'game.casinoBet':
      return `casino bet · stake ${eth(params.stake)} · ${betSummary(params)}${named}`;
    case 'game.developerBet':
      return `developer bet · stake ${eth(params.stake)} · on its developer's word${named}`;
    case 'game.payment':
      return `amount ${eth(params.amount)}${named}`;
    case 'game.receipt':
      return `id ${params.id}`;
    case 'game.requestFunds':
      return params.amount === undefined ? 'no suggested amount' : `suggests ${eth(params.amount)}`;
    default:
      return '';
  }
}
export function describeResult(method: string, result: any) {
  if (!result || typeof result !== 'object') return '';
  const limit = (state: any) => `balance ${eth(state.balance)}${state.pending ? ' · pending operation' : ''}`;
  switch (method) {
    case 'wallet.hello':
      return `${result.methods?.length ?? 0} methods · ${result.asset?.symbol} with ${result.asset?.decimals} decimals`;
    case 'wallet.info':
      return `${result.alias ? '@' + result.alias : '~' + (result.uname ?? 'unknown')} · bankroll ${eth(result.bankroll)}`;
    case 'game.requestFunds':
      return `${result.funded ? `limit set to ${eth(result.amount)}` : 'unchanged'} · ${limit(result)}`;
    case 'game.receipt':
    case 'game.casinoBet':
    case 'game.developerBet':
    case 'game.payment':
      return describeReceipt(result);
    default:
      return '';
  }
}
/** A receipt in one line: what became of the operation, what it paid, and whose word a payout rests on. */
export const describeReceipt = (receipt: any) =>
  `${receipt.kind} ${receipt.status}${receipt.payout === undefined ? '' : ` · paid ${eth(receipt.payout)}`}${
    receipt.kind === 'developer-bet' && receipt.payout !== undefined ? " · on its developer's word" : ''
  }${quote(receipt.reason)} · ${receipt.id}`;

export interface GameLogElements {
  list: HTMLElement;
  search: HTMLInputElement;
  empty: HTMLElement;
  count: HTMLElement;
  filters: Iterable<HTMLInputElement>;
}
export function createGameLog(elements: GameLogElements) {
  const entries: LogEntry[] = [];
  const inflight = new Map<string | number, { method: string; at: number }>();
  let seq = 0,
    last = 0,
    filter: string = 'all';
  const kinds: Record<string, LogKind[]> = {
    all: ['request', 'response', 'error', 'event', 'client'],
    bridge: ['request', 'response', 'error', 'event'],
    wallet: ['client'],
    errors: ['error'],
  };
  const apply = () => {
    for (const row of elements.list.children)
      (row as HTMLElement).classList.toggle(
        'filtered',
        !kinds[filter]!.includes((row as HTMLElement).dataset.kind as LogKind),
      );
    filterActivity(elements.list, elements.search.value, elements.empty, elements.count);
  };
  const badge: Record<LogKind, string> = {
    request: 'Game → wallet',
    response: 'Wallet → game',
    error: 'Error',
    event: 'Event',
    client: 'Client',
  };
  function log(
    kind: LogKind,
    title: string,
    options: { description?: string; payload?: unknown; latency?: number } = {},
  ) {
    const now = Date.now();
    const entry: LogEntry = {
      seq: ++seq,
      kind,
      title: title.slice(0, 240),
      description: options.description?.slice(0, 400) || undefined,
      timestamp: new Date(now).toISOString(),
      elapsed: last ? now - last : 0,
      latency: options.latency,
      payload: options.payload,
    };
    last = now;
    entries.unshift(entry);
    if (entries.length > LIMIT) entries.pop();
    const row = createActivityEntry({
      title: `#${entry.seq} ${entry.title}`,
      description: entry.description,
      timestamp: entry.timestamp,
      status: badge[kind],
      tone: kind === 'error' ? 'negative' : kind === 'event' ? 'warning' : kind === 'response' ? 'positive' : 'neutral',
      compact: true,
      meta:
        (entry.latency === undefined ? '' : `${entry.latency} ms round trip · `) +
        (entry.seq === 1 ? 'first event' : `+${entry.elapsed} ms`),
      payload: options.payload === undefined ? undefined : activityJSON(options.payload, PAYLOAD_LIMIT),
    });
    row.dataset.kind = kind;
    elements.list.prepend(row);
    if (elements.list.childElementCount > LIMIT) elements.list.lastElementChild!.remove();
    apply();
    return entry;
  }
  /** Bridge traffic as the bridge reports it: raw envelopes in, paired summaries out. */
  function bridge(type: 'request' | 'response' | 'error', message: any) {
    const id = typeof message?.id === 'string' || typeof message?.id === 'number' ? message.id : undefined;
    if (type === 'request') {
      const method = typeof message?.method === 'string' ? message.method.slice(0, 80) : 'invalid request';
      if (id !== undefined && typeof message?.method === 'string') inflight.set(id, { method, at: Date.now() });
      return log('request', method, { description: describeRequest(method, message?.params), payload: message });
    }
    const started = id === undefined ? undefined : inflight.get(id);
    if (id !== undefined) inflight.delete(id);
    const latency = started && Date.now() - started.at;
    const method = started?.method ?? 'unknown method';
    if (type === 'error')
      return log('error', `${method} failed`, {
        description: message?.error?.code
          ? `${message.error.code}: ${message.error.message}`
          : String(message?.error ?? ''),
        payload: message,
        latency,
      });
    return log('response', method, { description: describeResult(method, message?.result), payload: message, latency });
  }
  for (const input of elements.filters)
    input.addEventListener('change', () => {
      if (input.checked) {
        filter = input.value;
        apply();
      }
    });
  elements.search.addEventListener('input', apply);
  return {
    log,
    bridge,
    entries,
    clear() {
      entries.length = 0;
      inflight.clear();
      seq = 0;
      last = 0;
      elements.list.replaceChildren();
      apply();
    },
    /** Newest first, matching the display; payloads are complete objects, not previews. */
    export() {
      return activityJSON({ exportedAt: new Date().toISOString(), entries });
    },
  };
}
