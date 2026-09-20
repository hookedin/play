# Security

## Status

HookedIn v1 is a prototype running on the Sepolia testnet. Mainnet is unsupported. No third-party security audit has taken place; the tests in this repository establish software behaviour only. Contracts, signed messages and storage formats may change without migration, and prototype deployments are disposable. Do not use it with funds you cannot afford to lose.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting: open <https://github.com/hookedin/play/security/advisories/new>, or choose **Report a vulnerability** under the repository's **Security** tab. Please do not open a public issue or pull request for a suspected vulnerability, and do not test against other people's channels or funds.

A useful report says which component and revision is affected, what an attacker gains, and how to reproduce it, ideally as a failing test against a local Anvil deployment (`npm test` shows how those are set up).

## Scope

- The settlement contract, [contracts/HookedInCasino.sol](contracts/HookedInCasino.sol): loss or freezing of protected principal, bypassing the challenge window, replay of evidence, incorrect winnings allocation, unauthorized withdrawals.
- The wallet, [client/](client/): key exposure, accepting a result, rejection, payout or share statement it should refuse, losing or downgrading saved evidence, escaping the game iframe boundary, signing something other than what is shown.
- The shared protocol and player-side tools, [protocol/](protocol/) and [scripts/](scripts/): disagreement between the TypeScript and contract derivations, errors in the risk rule, recovery CLI or watchtower failing to settle or challenge with valid evidence.
- The build: anything that makes the published `dist/` differ from what these sources produce.

The casino service, the website and the individual games are separate codebases. Report an issue in a public game or the SDK to its own repository under <https://github.com/hookedin>. If you find a problem in the running casino service, report it here privately as well.

## Not vulnerabilities

The trust assumptions stated in [README.md](README.md#trust-model) and [architecture.md](architecture.md) are accepted design choices: one operator controls signing and the bankroll, winnings above the deposit are unsecured claims on the shared pool, the player must challenge a stale close within 24 hours, the casino can withhold completion, a host and the casino together could choose a hosted round's outcome, and bankroll fund shares are the casino's promise. Reports that restate these are welcome as design feedback in a public issue.
