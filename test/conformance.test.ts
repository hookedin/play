import { gameWallet } from '../testing/game-wallet.ts';
import { behaviour } from '../testing/conformance.ts';

/** The stub a game is tested with passes what the casino itself passes. */
behaviour('the test casino', async () => {
  const f = await gameWallet(),
    limit = '100000',
    playing = async (wallet = f.wallet) => {
      wallet.openGame(f.identity());
      await wallet.setGameLimit(limit);
      return wallet;
    };
  await playing();
  return {
    wallet: f.wallet,
    bridge: f.bridge,
    asset: 'eth',
    referee: async () => f.referee,
    advance: async ms => f.advance(ms),
    async replaceChannel() {
      await f.replaceChannel();
      await f.wallet.setGameLimit(limit);
    },
    async forget() {
      const wallet = await playing(await f.forget());
      return { wallet, bridge: f.bridgeFor(wallet) };
    },
    within: { stake: '10', prizes: [{ rangeStart: '0', rangeEnd: '9000000000000000000', payout: '20' }] },
    beyond: { stake: '10', prizes: [{ rangeStart: '0', rangeEnd: String(1n << 63n), payout: String(10n ** 13n) }] },
  };
});
