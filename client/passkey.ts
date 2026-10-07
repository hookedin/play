import { Wallet, hexlify, encodeBase64 } from 'ethers';

/** What every passkey is asked for: the secret it answers with is the account's key. */
const input = new TextEncoder().encode('HOOKEDIN/ACCOUNT-KEY');
const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const key = (secret: BufferSource) => new Wallet(hexlify(new Uint8Array(secret as ArrayBuffer))).privateKey;
const unsupported = () => new Error("This device's passkeys cannot hold a wallet. Create a key file instead.");

/** A passkey's account: its key, the passkey's secret for the wallet's input, the same on every device the passkey
 * syncs to, and the passkey's user ID, by which the wallet names it to the password manager keeping it. `create` makes
 * a new passkey, which is a new, empty account; otherwise the player picks one they have. Nothing leaves the browser,
 * so the challenge only has to be fresh. */
export async function passkeyAccount(create = false): Promise<{ key: string; user: Uint8Array<ArrayBuffer> }> {
  // A browser whose passkeys hold no such secret makes none: the passkey would be left over, opening nothing.
  if (create && (await PublicKeyCredential.getClientCapabilities?.().catch(() => null))?.['extension:prf'] === false)
    throw unsupported();
  try {
    let id: ArrayBuffer | undefined, user: Uint8Array<ArrayBuffer> | undefined;
    if (create) {
      user = random(16);
      // Named by the day it was made, until the wallet can name it by its account.
      const name = `HookedIn wallet ${new Date().toISOString().slice(0, 10)}`;
      const made = (await navigator.credentials.create({
        publicKey: {
          rp: { name: 'HookedIn' },
          user: { id: user, name, displayName: name },
          challenge: random(32),
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          extensions: { prf: { eval: { first: input } } },
        },
      })) as PublicKeyCredential;
      const prf = made.getClientExtensionResults().prf;
      if (prf?.results?.first) return { key: key(prf.results.first), user };
      if (!prf?.enabled) throw unsupported();
      // Some passkeys answer only when used: this one is used at once.
      id = made.rawId;
    }
    const used = (await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        userVerification: 'required',
        ...(id ? { allowCredentials: [{ type: 'public-key' as const, id }] } : {}),
        extensions: { prf: { eval: { first: input } } },
      },
    })) as PublicKeyCredential;
    const first = used.getClientExtensionResults().prf?.results?.first;
    if (!first) throw unsupported();
    return {
      key: key(first),
      user: user ?? new Uint8Array((used.response as AuthenticatorAssertionResponse).userHandle!),
    };
  } catch (error: any) {
    // The browser says the same whether the player cancelled or has no passkey here.
    if (error?.name === 'NotAllowedError')
      throw new Error(
        create ? 'No passkey was made.' : 'No passkey was used. Create one if you have none for HookedIn.',
      );
    throw error;
  }
}

/** Name a passkey, in the password manager keeping it, by the name its account goes by here, where the browser lets a
 * site do that: then a player with several tells them apart. */
export function namePasskey(user: Uint8Array, name: string) {
  const userId = encodeBase64(user).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  void (PublicKeyCredential as any)
    .signalCurrentUserDetails?.({ rpId: location.hostname, userId, name, displayName: name })
    ?.catch(() => {});
}
