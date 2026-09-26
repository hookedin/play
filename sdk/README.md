# HookedIn game SDK

`@hookedin/play/sdk` is what a HookedIn game is built with: the wallet bridge, a helper for multi-step rounds, an exact pricing engine, the developer kit for a game's own server, a balance strip, synthesized sound, shared styles and the `hookedin-game` build tool.

It is documented with the rest of HookedIn, at <https://hookedin.com/docs>:

- [Building games](../docs/games/quick-start.md): from the template to a published game, with or without a server.
- [SDK reference](../docs/sdk/index.md): every entry point and every export.
- [The game bridge](../docs/reference/bridge.md): the messages a game and the wallet exchange.
- [The `hookedin-game` command](../docs/reference/cli.md).

## Layout

```text
bin/hookedin-game.js                 build and serve command
src/sdk.ts                           HookedIn wallet bridge
src/round.ts                         RoundClient
src/bank.ts                          mountBank balance strip
src/synth.ts                         createSynth
src/admits.ts                        the casino's admission rule
src/developer.ts                     createDeveloper, for a game's own server
src/wire.ts                          types shared by the page and the server
src/engine/                          exact continuation pricing, blackjack and mines rules
src/generated/blackjack-funding.ts   precomputed blackjack prices
scripts/blackjack-funding.ts         generator for that table
scripts/demos/                       command-line blackjack and mines demos
shared.css                           shared styles
test/                                bridge, round helper and engine tests
```

## License

[MIT](../LICENSE)
