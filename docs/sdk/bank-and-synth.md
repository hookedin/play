---
title: Bank strip and sound
description: Reference for @hookedin/play/sdk/bank, the balance strip a game shows, @hookedin/play/sdk/synth, synthesized sound, and the shared stylesheet.
sidebar:
  order: 9
---

`import { mountBank } from '@hookedin/play/sdk/bank';` and `import { createSynth } from '@hookedin/play/sdk/synth';`
are pieces of the house games' pages that any game can use. The bank module is browser-only, since it loads the
[bridge](hookedin.md). The synth module is Node-safe to import, and makes sound only in a browser.

## Bank strip

### `mountBank`

```ts
export function mountBank(
  root: HTMLElement,
  options?: {
    round?: RoundClient;
  },
): {
  update: (balance: (Partial<GameBalance> & { balance: string }) | undefined) => void;
  readonly balance: GameBalance;
  setBusy(value: boolean): void;
  hold(value: boolean): void;
  withhold(change: bigint): void;
  onChange(listener: (balance: GameBalance) => void): () => void;
};
```

Draws the game's balance strip into `root`, replacing its children: the figure labelled **Game balance** with the
asset's symbol, a status line, and an **Add funds** button that asks the player for money with
[`HookedIn.requestFunds()`](hookedin.md#requestfunds), suggesting no amount. It follows every
[`game.balance`](../reference/bridge.md#gamebalance) push. The figure reads `—` until the wallet has greeted the page,
then the balance less anything withheld, never below zero.

`root` gets the class `bank` and `aria-live="polite"`. Its `data-state` is `pending` while an operation awaits recovery,
`empty` at a zero balance and `ready` otherwise, and it carries `data-practice` while the wallet practices. The children
are `.bank-figure` (holding `.bank-label`, `.bank-amount` and `.bank-asset`), `.bank-status` and `.bank-add`, which
[`shared.css`](#sharedcss) styles.

With `round`, a game's [`RoundClient`](round.md#roundclient), the figure leaves out the cash inside an unfinished round,
which the round shows, and stands still while a step settles, so it moves once a round: down by what the player put in,
up by what the round finally pays. `mountBank` redraws the strip on [`round.onChange`](round.md#onchange). The cash it
leaves out is the player's all the same.

```ts
import { mountBank } from '@hookedin/play/sdk/bank';

const bank = mountBank(document.getElementById('bank')!); // pass { round } in a RoundClient game
bank.hold(true); // a result is being revealed: keep the figure still
setTimeout(() => bank.hold(false), 1200); // then show the latest balance
```

#### `update`

```ts
update: (balance: (Partial<GameBalance> & { balance: string }) | undefined) => void;
```

Shows a balance the game got another way, such as a `requestFunds` result or the `state` `initializeGame` resolves
with. `undefined` is ignored, and `pending` counts only when it is `true`.

#### `balance`

```ts
readonly balance: GameBalance;
```

The balance last received: `{ balance: '0', pending: false }` until the first.

#### `setBusy`

```ts
setBusy(value: boolean): void;
```

Disables the button while the game settles a bet. The bridge serializes requests either way.

#### `hold`

```ts
hold(value: boolean): void;
```

Keeps the figure still while a result is being revealed; releasing it shows the latest balance.

#### `withhold`

```ts
withhold(change: bigint): void;
```

Leaves `change` more out of the figure, such as winnings still on their way while a ball is in the air. Calls add up; a
negative `change` gives back what was left out.

#### `onChange`

```ts
onChange(listener: (balance: GameBalance) => void): () => void;
```

Calls `listener` with every `game.balance` push, after the strip has taken it in: the game's own bets and payments,
money the player adds in the wallet and a recovery that settles outside the game alike. Returns a function that stops
it.

## Sound

### `createSynth`

```ts
export function createSynth(storageKey?: string): {
  unlock: () => void;
  tone: (
    frequency: number,
    delay: number,
    duration: number,
    {
      type,
      gain,
      to,
    }?: {
      type?: OscillatorType;
      gain?: number;
      to?: number;
    },
  ) => void;
  noise: (delay: number, duration: number, gain: number, cutoff: number) => void;
  melody: (notes: number[], step: number, options?: { type?: OscillatorType; gain?: number; to?: number }) => void;
  readonly muted: boolean;
  setMuted(value: boolean): void;
  readonly output: {
    context: AudioContext;
    master: GainNode;
  } | null;
};
```

Short synthesized sounds, so a game hosts no audio files. `storageKey`, `hookedin:muted` by default, is where the
player's mute choice is kept in `localStorage`; a storage that fails is ignored. Delays and durations are in seconds,
frequencies in hertz.

| Member                                       | What it does                                                                                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unlock()`                                   | Creates the audio context on its first call and resumes a suspended one. Call it from the player's gesture, such as a click: until then every sound is silent                          |
| `tone(frequency, delay, duration, options?)` | A tone that starts after `delay` and fades out over `duration`. `type` is the oscillator's wave, `sine` by default; `gain` its volume, `0.1` by default; `to` a frequency it glides to |
| `noise(delay, duration, gain, cutoff)`       | A burst of fading noise through a low-pass filter at `cutoff`                                                                                                                          |
| `melody(notes, step, options?)`              | Each of `notes` as a tone, `step` apart, each lasting 2.2 steps                                                                                                                        |
| `muted`                                      | Whether sound is muted, as last chosen                                                                                                                                                 |
| `setMuted(value)`                            | Mutes or unmutes, and keeps the choice                                                                                                                                                 |
| `output`                                     | `{ context, master }`, for sounds of the game's own that outlast one envelope; `null` before `unlock`                                                                                  |

```ts
import { createSynth } from '@hookedin/play/sdk/synth';

const synth = createSynth();
document.getElementById('play')!.addEventListener('click', () => {
  synth.unlock();
  synth.melody([660, 880, 1320], 0.075, { type: 'triangle', gain: 0.12 });
});
```

## shared.css

The house games' stylesheet: a dark theme with the custom properties `--muted`, `--accent`, `--line`, `--panel` and
`--dark`; the page layout, from `main`, `.game-head`, `.stage` and `.controls` to `.primary`, `.secondary`, `.status`,
`.readout`, `.rules` and `.foot`; and the bank strip, drawn with a dashed border in test coins. It is `sdk/shared.css`
in the package. `hookedin-game build` copies it into `dist/shared.css` ([CLI](../reference/cli.md)), and a page links
`./shared.css` before its own `./style.css`.
