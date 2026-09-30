import { Wallet, hexlify } from 'ethers';

/** What every passkey is asked for: the secret it answers with is the account's key. */
const input = new TextEncoder().encode('HOOKEDIN/ACCOUNT-KEY');
const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const key = (secret: BufferSource) => new Wallet(hexlify(new Uint8Array(secret as ArrayBuffer))).privateKey;
const unsupported = () => new Error("This device's passkeys cannot hold a wallet. Save a key file instead.");

/** The account key a passkey holds: its PRF secret for the wallet's input, the same on every device the passkey syncs
 * to. `create` makes a new passkey; otherwise the player picks one they have. Nothing leaves the browser, so the
 * challenge only has to be fresh. */
export async function passkeyKey(create = false): Promise<string> {
  let id: ArrayBuffer | undefined;
  if (create) {
    const made = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'HookedIn' },
        user: { id: random(16), name: 'HookedIn wallet', displayName: 'HookedIn wallet' },
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
    if (prf?.results?.first) return key(prf.results.first);
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
  return key(first);
}
