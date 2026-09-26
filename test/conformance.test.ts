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
    developer: async () => f.developer,
    async replaceChannel() {
      await f.replaceChannel();
      await f.wallet.setGameLimit(limit);
    },
    async forget() {
      const wallet = await playing(await f.forget());
      return { wallet, bridge: f.bridgeFor(wallet) };
    },
    within: { stake: '10', chance: '9000000000000000000', prize: '20' },
    beyond: { stake: '10', chance: String(1n << 63n), prize: String(10n ** 13n) },
  };
});
