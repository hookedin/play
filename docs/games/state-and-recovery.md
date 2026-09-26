---
title: State and recovery
description: Operation IDs, saving before sending, lost replies, rejections, storage keys, reloads and tabs.
sidebar:
  order: 7
---

The wallet keeps no state for a game. A game saves its own at its origin and names every operation, so that each
happens exactly once whatever is lost on the way: a reply, a page, a tab.

## Operation IDs

Every casino bet, developer bet and payment carries an `id` the game chooses: 1 to 64 letters, digits, `.`, `_`, `:`
or `-`. `crypto.randomUUID()` fits. It is the game's durable name for the operation.

- The wallet scopes it by player and game, as `game:<game key>:<id>`, so another game never collides with it. Practice
  keeps its own receipts, apart from the player's.
- It is the player's, not a channel's: on the player's next channel the same `id` finds the operation instead of
  placing another.
- The same `id` with the same terms returns the operation's receipt, so an operation is placed once however often it
  is sent. The same `id` with other terms fails with `id-conflict`.

## Save before you send

Choose the action and its `id`, and save both at your origin, before you ask the wallet; a page that draws which bet to
place saves the bet it drew with them. The wallet saves the signed request before it leaves, so the game's record and
the wallet's meet by `id` after any crash.
[A coin flip](casino-bets.md#a-coin-flip) saves `{ id, stake }` under its storage key and clears it once the receipt
arrives.

## Lost replies

A reply can be lost to a reload, a crash, or the SDK's `timeout` after three minutes. A timeout or any other error
proves nothing about the operation. On startup, read what you saved and ask the wallet:

```ts
import { HookedIn } from '@hookedin/play/sdk/sdk';
import { flipBet, wire } from './flip.ts';

await HookedIn.hello();
const key = `${HookedIn.storageScope(await HookedIn.info())}:flip`;
const saved: { id: string; stake: string } | null = JSON.parse(localStorage.getItem(key) ?? 'null');
if (saved) {
  const receipt = await HookedIn.receipt(saved.id);
  if (receipt) {
    localStorage.removeItem(key); // the reply that was lost: apply it once
    show(receipt);
  } else
    offer('Finish your flip', async () => {
      // No receipt in this wallet: the same request, under the same id.
      show(await HookedIn.casinoBet({ id: saved.id, ...wire(flipBet(BigInt(saved.stake))) }));
      localStorage.removeItem(key);
    });
}
```

`show` and `offer` are your page's own.

- **A receipt** is the reply you lost. Apply it exactly once, and clear your record.
- **`null`** means this wallet holds no receipt for the `id`. Send the same request under the same `id`. If the wallet
  still holds it signed, which the pushed `pending: true` shows, it sends that signed request again; if not, it signs
  it. The player can also retry a signed request from the wallet's banner.
- While an operation is pending, the wallet takes no other bet or payment: another `id` fails with
  `pending-operation`.

[`RoundClient`](../sdk/round.md#roundclient) does all of this for a multi-step game.

## Rejections

A receipt with `status: 'rejected'` is a checkpoint the casino signed one step above the operation, which the wallet
checked: the operation is cancelled, with no outcome, no balance change and no commission, and `reason` says why. The
`id` keeps returning that rejection. To try again, send the same terms under a fresh `id`; `RoundClient` keeps the
pending step and the bet it drew, and does so: drawing again would change the game's odds. A declined casino bet's
round is revealed with its rejection, and the wallet records what the bet would have paid
([bets and receipts](../wallet/bets-and-receipts.md)).

## When a wallet has lost receipts

A wallet restored from an older backup may not hold the receipt of an operation its player carried out on another
channel. `game.receipt` returns `null` for it, and sending the request again fails with `id-used`: the operation was
carried out, and its result is not in this wallet. Clear your record and tell the player. Do not send it again under
another `id` without asking them.

## Storage

Keep state at your own origin, in `localStorage` or IndexedDB. Key it by page, chain and player, or practice, so that
games sharing a host, accounts sharing a browser, and practice beside play never read each other's state.
`HookedIn.storageScope(info)` builds such a key:

```text
hookedin:<page path>:<chainId>:<uname>
hookedin:<page path>:<chainId>:practice
```

Call it once `HookedIn.hello()` has resolved, since whether the wallet practices comes from the greeting. It keys on the
uname, which is the player's for good; never key by the alias, which the player can change. `RoundClient` saves its
round under `hookedin:round:<name>:<chainId>:<uname>`, or `...:practice`, where `name` is the page's path unless you
pass one.

## Reloads and tabs

- A reload releases the spending limit. The state at your origin survives, and every settled step's money is in the
  channel balance: a resumed round asks for money again.
- Saved state stays in this browser. It is not in wallet backups and does not follow the player to another browser; a
  round left unfinished leaves the player the cash it held.
- Two tabs of one game share its origin storage. Read saved state again before every action; `RoundClient` does, and
  its `watch(listener)` reloads the round when another tab writes it. The wallet lets one game per wallet hold a limit
  at a time and keeps one pending operation per channel, so the money stays consistent whatever the tabs do.
- A game with state beyond one round, such as a slot's bonus counter, applies each finished round once, by the round's
  `id`.

## Errors

A refusal rejects with a `HookedInError`: act on its `code`, show its `message`. Besides the codes above,
`insufficient-funds` asks for [funds](how-a-game-works.md#the-spending-limit), `practice` means the wallet practices and
places no developer bet, and `busy` means the player is doing something in the wallet or 32 requests already wait. Every
code is under [bridge errors](../reference/bridge.md#errors).
