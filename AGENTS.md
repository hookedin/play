# HookedIn: rules for every repository

## 1. Simplicity is the most important rule

Always favor the simplest thing that is correct. Do not over-engineer anything. The code, the configuration, the
workflows and the documents should be as maintainable and elegant as feasible: the fewest parts, the fewest words, no
speculative abstraction, no option nobody asked for. When two designs work, take the one with less in it. Added
complexity needs a concrete requirement, and an explanation of why nothing simpler meets it.

## 2. This is an open beta. Compatibility does not exist

HookedIn is in open beta on Sepolia, with test ETH only. Players and game developers are told that a reset can start
balances, history and names over, and that the SDK, the game bridge and the casino API change without notice, so there
is nothing to stay compatible with. Ever.

- Never worry about backward compatibility: no shims, no fallbacks, no reserved fields, no deprecation
  paths. Change contracts, signed structures, APIs, schemas, storage and formats freely.
- Never bump version numbers, and never cut version tags. Everything stays at the version it has. Repositories depend
  on each other's `main`; a push to `main` is the release.
- Never reference old things: no "previously", "formerly", "legacy", "v1 did", "no longer" or "replaces X" in code,
  comments, documents or commit messages. Describe what is, not what was. Delete old code; do not keep it, comment it
  out or point at it.
- Deployments and their data are disposable. A fresh deployment is always an acceptable answer.

To keep production's data through a change, migrate it by hand and leave no cruft in the code: a new field, for
example, is added in production with backfilled data.

## 3. Clean up immediately

Any opportunity to clean something up is taken at once, in the same change: dead code, a stale document, a duplicated
path, a name that lies, a needless option, a file nothing uses. Do it even when it means redeploying, breaking
something that depended on the mess, or touching several repositories. Leaving it for later is the wrong call.

## 4. Be strict in what you accept

Validation errs on the side of too strict, never of too flexible: the casino, the contract, the protocol, the wallet's
checks of what the casino sends and every game's server take each value in exactly one form, and refuse anything else
before it is signed, recorded, stored, compared or shown. A whole number is a decimal string, a hash lowercase hex, an
address checksummed, a signature the one form the contract recovers, a message exactly its fields, text printable, a
size bounded. What came in is never read leniently, trimmed, lowercased or parsed into something it might mean and then
used: it is refused. Only what a person types is read generously, where they type it, and it leaves in its one form.
Loosen a check when something real needs it, and only as far as it needs.

## This repository

The wallet, the settlement contract, the shared protocol, the game SDK and the house's games. Keep the guarantees we
advertise correct and testable. Preserve explicitly accepted trust assumptions and manual responsibilities; do not
expand the protocol merely to offer stronger guarantees. Reuse existing state, validation and recovery paths. A change
to the contract's compiled code is a new deployment; once a release holds money that matters, the contract stays as it
is. The chain reprices gas as it likes, so a gas figure in the contract may only defer a payment, never block it, and
gas figures off-chain come from live estimates wherever a wrong one would break something rather than cost a little.
See [the architecture](docs/overview/architecture.md).

## Settled decisions

[The architecture](docs/overview/architecture.md#settled-trade-offs) records trade-offs made on purpose: how commission
is set, a multi-step game as a sequence of casino bets a player can walk away from, METH as the unit with its pun meant,
and a developer's solvency left to the trust of its players. They are decisions, not open questions. Explain them where
it helps; do not propose changing them.
