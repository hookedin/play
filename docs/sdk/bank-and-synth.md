---
title: Bank strip and sound
description: Reference for @hookedin/play/sdk/bank, the balance strip a game shows, @hookedin/play/sdk/synth, synthesized sound, and the shared stylesheet.
sidebar:
  order: 8
---

`import { mountBank } from '@hookedin/play/sdk/bank';` and `import { createSynth } from '@hookedin/play/sdk/synth';`
are pieces of the house games' pages that any game can use. The bank module is browser-only, since it loads the
[bridge](hookedin.md). The synth module is Node-safe to import, and makes sound only in a browser.

## Bank strip

### `mountBank`

`mountBank(root, { round? })` draws the game's balance strip into `root`, replacing its children: the figure labelled
**Game allowance**, in ETH, and an **Adjust allowance** button that asks the player to set the game's spending limit
with [`HookedIn.requestFunds()`](hookedin.md#requestfunds), suggesting no amount. It follows every
[`game.balance`](../reference/bridge.md#gamebalance) push: the figure reads `—` until the first, then the balance less
anything withheld, never below zero. A status line under it speaks only when the player is needed: while the wallet's
dialog is open, while an operation awaits recovery, or when asking for money failed.

`root` gets the class `bank` and `aria-live="polite"`. Its `data-state` is `pending` while an operation awaits recovery,
`empty` at a zero balance and `ready` otherwise. The children are `.bank-figure` (holding `.bank-label`, `.bank-amount`
and `.bank-asset`), `.bank-status` and `.bank-add`, which [`shared.css`](#sharedcss) styles.

With `round`, a game's [`RoundClient`](round.md#roundclient), the figure leaves out the cash inside an unfinished round,
which the round shows, and stands still while a step settles, so it moves once a round: down by what the player put in,
up by what the round finally pays. It redraws on [`round.onChange`](round.md#onchange). The cash it leaves out is the
player's all the same.

It returns the strip's controls:

| Member             | What it does                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `update(balance)`  | Shows a balance the game got another way, such as a `requestFunds` result or the `state` `initializeGame` resolves with               |
| `setBusy(value)`   | Disables the button while the game settles a bet. The bridge serializes requests either way                                           |
| `hold(value)`      | Keeps the figure still while a result is being revealed; releasing it shows the latest balance                                        |
| `withhold(change)` | Leaves `change` more out of the figure, such as winnings on their way while a ball is in the air. A negative `change` gives some back |

```ts
import { mountBank } from '@hookedin/play/sdk/bank';

const bank = mountBank(document.getElementById('bank')!); // pass { round } in a RoundClient game
bank.hold(true); // a result is being revealed: keep the figure still
setTimeout(() => bank.hold(false), 1200); // then show the latest balance
```

## Sound

### `createSynth`

`createSynth(storageKey?)` makes short synthesized sounds, so a game hosts no audio files. `storageKey`,
`hookedin:muted` by default, is where the player's mute choice is kept in `localStorage`; a storage that fails is
ignored. Delays and durations are in seconds, frequencies in hertz.

| Member                                       | What it does                                                                                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unlock()`                                   | Creates the audio context on its first call and resumes a suspended one. Call it from the player's gesture, such as a click: until then every sound is silent. It never throws: a browser without Web Audio plays silently |
| `tone(frequency, delay, duration, options?)` | A tone that starts after `delay` and fades out over `duration`. `type` is the oscillator's wave, `sine` by default; `gain` its volume, `0.1` by default; `to` a frequency it glides to                                     |
| `noise(delay, duration, gain, cutoff)`       | A burst of fading noise through a low-pass filter at `cutoff`                                                                                                                                                              |
| `melody(notes, step, options?)`              | Each of `notes` as a tone, `step` apart, each lasting 2.2 steps                                                                                                                                                            |
| `muted`                                      | Whether sound is muted, as last chosen                                                                                                                                                                                     |
| `setMuted(value)`                            | Mutes or unmutes, and keeps the choice                                                                                                                                                                                     |
| `output`                                     | `{ context, master }`, for sounds of the game's own that outlast one envelope; `null` before `unlock`                                                                                                                      |

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
`--dark`; the page layout, from `main`, `.game-head`, `.stage` and `.controls` to `.primary`, `.secondary`, `.tool`,
`.status`, `.readout`, `.rules` and `.foot`; and the bank strip. It is `sdk/shared.css` in the package.
[`hookedin-game build`](../games/publishing.md#build) copies it into `dist/shared.css`, and a page links `./shared.css`
before its own `./style.css`.
