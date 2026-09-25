# HookedIn: rules for every repository

## 1. Simplicity is the most important rule

Always favor the simplest thing that is correct. Do not over-engineer anything. The code, the configuration, the
workflows and the documents should be as maintainable and elegant as feasible: the fewest parts, the fewest words, no
speculative abstraction, no option nobody asked for. When two designs work, take the one with less in it. Added
complexity needs a concrete requirement, and an explanation of why nothing simpler meets it.

## 2. This is pre-release. Compatibility does not exist

Nothing here has been released, so there is nothing to stay compatible with. Ever.

- Never worry about backward compatibility: no shims, no migrations, no fallbacks, no reserved fields, no deprecation
  paths. Change contracts, signed structures, APIs, schemas, storage and formats freely.
- Never bump version numbers, and never cut version tags. Everything stays at the version it has. Repositories depend
  on each other's `main`; a push to `main` is the release.
- Never reference old things: no "previously", "formerly", "legacy", "v1 did", "no longer" or "replaces X" in code,
  comments, documents or commit messages. Describe what is, not what was. Delete old code; do not keep it, comment it
  out or point at it.
- Deployments and their data are disposable. A fresh deployment is always an acceptable answer.

## 3. Clean up immediately

Any opportunity to clean something up is taken at once, in the same change: dead code, a stale document, a duplicated
path, a name that lies, a needless option, a file nothing uses. Do it even when it means redeploying, breaking
something that depended on the mess, or touching several repositories. Leaving it for later is the wrong call.

## This repository

The wallet, the settlement contract, the shared protocol, the game SDK and the house's games. Keep the guarantees we
advertise correct and testable. Preserve explicitly accepted trust assumptions and manual responsibilities; do not
expand the protocol merely to offer stronger guarantees. Reuse existing state, validation and recovery paths. A change
to the contract's compiled code is a new deployment; once a release holds money that matters, the contract stays as it
is. See [architecture.md](architecture.md).

## Settled decisions

[architecture.md](architecture.md#settled-trade-offs) records trade-offs made on purpose: how commission is set, a
multi-step game as a sequence of casino bets a player can walk away from, and a developer's solvency left to the trust
of its players. They are decisions, not open questions. Explain them where it helps; do not propose changing them.
