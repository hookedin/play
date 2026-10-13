import { bridgeTo, gameWallet } from '../testing/game-wallet.ts';
import { behaviour } from '../testing/conformance.ts';

/** The stub a game is tested with passes what the casino itself passes. */
behaviour('the test casino', async () => {
  const f = await gameWallet(),
    allowance = 100000n,
    playing = async (wallet = f.wallet) => {
      wallet.openGame(f.identity());
      await wallet.setGameAllowance(allowance, true);
      return wallet;
    };
  await playing();
  return {
    wallet: f.wallet,
    bridge: f.bridge,
    developer: async () => f.developer,
    async replaceChannel() {
      await f.replaceChannel();
      await f.wallet.setGameAllowance(allowance, true);
    },
    async forget() {
      const wallet = await playing(await f.forget());
      return { wallet, bridge: bridgeTo(wallet) };
    },
    within: { stake: 10n, chance: 9000000000000000000n, prize: 20n },
    beyond: { stake: 10n, chance: 1n << 63n, prize: 10n ** 13n },
  };
});
