// test/browser.test.ts opens this harness beside a virtual authenticator, and asks the page for passkey keys.
import { passkeyKey } from '../client/passkey.ts';
Object.assign(window, { passkeyKey });
