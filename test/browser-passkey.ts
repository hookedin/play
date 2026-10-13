// test/browser.test.ts opens this harness beside a virtual authenticator, and asks the page for passkeys' accounts.
import { passkeyAccount } from '../client/passkey.ts';
Object.assign(window, {
  passkeyAccount: async (create: boolean) => {
    const { key, user } = await passkeyAccount(create);
    return { key, user: Array.from(user) };
  },
});
