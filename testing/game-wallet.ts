import { Wallet, ZeroHash, hexlify, randomBytes } from 'ethers';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';
import {
  domain,
  initialState,
  channelId,
  STATE_TYPES,
  deriveState,
  roundId,
  seedHash,
  plain,
  checkpointEvidence,
  rejectionCheckpoint,
} from '../protocol/protocol.ts';
import type { GameIdentity } from '../protocol/game-types.ts';
export async function gameWallet(storage = new MemoryStore()) {
  const owner = Wallet.createRandom(),
    player = Wallet.createRandom(),
    key = Wallet.createRandom();
  const casino = Wallet.createRandom().address,
    d = domain(31337, casino);
  const message = {
    channelId: channelId(player.address, key.address, 1000000n),
    player: player.address,
    signer: key.address,
    deposit: '1000000',
  };
  const opening = message;
  const state = initialState(message);
  const playerSignature = await key.signTypedData(d, STATE_TYPES, state),
    casinoSignature = await owner.signTypedData(d, STATE_TYPES, state);
  const bankroll = '1000000000000';
  const responses = new Map();
  let settlements = 0;
  // The stub casino's rounds: each is the hash of its secret. The channel's own round settles with
  // its bet; a hosted round holds its seats until `closeRound`.
  const secrets = new Map<string, string>(),
    hosted = new Map<string, { seed: string; seats: { request: any; signature: string }[] }>();
  let own = '';
  const createRound = () => {
    const secret = hexlify(randomBytes(32)),
      round = roundId(secret);
    secrets.set(round, secret);
    return round;
  };
  // A casino derives a player's uname from their address with a key of its own; a stub only has to
  // give each wallet one of the right shape, so a game keys its storage by a real name.
  const uname = hexlify(randomBytes(12)).slice(2).replaceAll('0', 'z').replaceAll('1', 'y');
  const make = () => {
    const wallet = new CasinoWallet({ network: 'local', storage });
    Object.assign(wallet, {
      storageKey: 'game-wallet',
      address: player.address,
      uname,
      alias: null,
      signer: player,
      mode: 'demo',
      operator: owner.address,
      domain: d,
      config: { contractAddress: casino },
      verifiedChainId: 31337n,
      reportedBankroll: bankroll,
      currentId: message.channelId,
      channels: {
        [message.channelId]: {
          key: key.privateKey,
          opening,
          state: structuredClone(state),
          playerSignature,
          casinoSignature,
          onchain: { status: '1' },
        },
      },
    });
    wallet.ready = () => {
      wallet.requireDurableState();
      if (!wallet.current) throw new Error('No channel');
    };
    wallet.api = async (path, body) => {
      if (path === '/api/metrics') return { bankroll };
      if (path.endsWith('/round')) return { id: (own ||= createRound()) };
      if (path.endsWith('/cancel')) return takeBack((body as any).request);
      if (!path.endsWith('/operations')) return {};
      const { request, signature, seed } = body as any;
      if (responses.has(request.memo)) return responses.get(request.memo);
      const seats = hosted.get(request.round);
      if (seats) {
        if (request.seedHash !== seedHash(seats.seed)) throw new Error('Every bet in a round shares its seed');
        if (!seats.seats.some(seat => seat.request.memo === request.memo)) seats.seats.push({ request, signature });
        return { status: 'seated', operationId: request.memo };
      }
      return settle(request, signature, seed ?? ZeroHash);
    };
    /** A seat taken back from its round is declined, unless the round's host closed it first. */
    const takeBack = async (request: any) => {
      const settled = responses.get(request.memo);
      if (settled) return settled;
      const open = hosted.get(request.round);
      if (open) open.seats = open.seats.filter(s => s.request.memo !== request.memo);
      return decline(request);
    };
    /** The casino declines a bet with a signed checkpoint above it: the balance is unchanged. */
    const decline = async (request: any) => {
      const base = wallet.current!,
        state = rejectionCheckpoint(d, base.state, request);
      const response = plain({
        status: 'rejected',
        reason: 'Bet withdrawn by the player',
        request,
        operationId: request.memo,
        state,
        casinoSignature: await owner.signTypedData(d, STATE_TYPES, state),
        commission: '0',
        evidence: checkpointEvidence(base.state, base.playerSignature, base.casinoSignature),
        bankroll,
      });
      responses.set(request.memo, response);
      return response;
    };
    const settle = async (request: any, signature: string, seed: string) => {
      const base = wallet.current!,
        secret = Number(request.kind) === 1 ? secrets.get(request.round)! : ZeroHash;
      const next = deriveState(d, base.state, request, secret, seed);
      const signed = await owner.signTypedData(d, STATE_TYPES, next);
      const response = plain({
        status: 'signed',
        state: next,
        casinoSignature: signed,
        evidence: {
          ...checkpointEvidence(base.state, base.playerSignature, base.casinoSignature),
          step: {
            operation: request,
            authorization: signature,
            seed,
            secret,
            casinoSignature: signed,
          },
        },
        bankroll,
        ...(request.round === own ? { nextRound: (own = createRound()) } : {}),
      });
      responses.set(request.memo, response);
      settlements++;
      return response;
    };
    closers.add(async (round: string) => {
      const open = hosted.get(round);
      for (const seat of open?.seats ?? []) await settle(seat.request, seat.signature, open!.seed);
      hosted.delete(round);
    });
    return wallet;
  };
  const closers = new Set<(round: string) => Promise<void>>();
  const wallet = make();
  await wallet.save();
  return {
    wallet,
    storage,
    owner,
    player,
    settlements: () => settlements,
    /** A round's secret, which only the casino knows until it reveals the round. */
    secretOf: (round: string) => secrets.get(round)!,
    /** What a game's host does at the casino: open a round with the hash of its seed, and close it with the seed. */
    openRound(seed = hexlify(randomBytes(32))) {
      const id = createRound();
      hosted.set(id, { seed, seats: [] });
      return { id, seedHash: seedHash(seed) };
    },
    async closeRound(round: string) {
      for (const close of closers) await close(round);
    },
    /** A game as its manifest describes it. `declared` is what that manifest says about itself, such
     * as whether it bets on rounds its own host opens. */
    identity: (name = 'test', declared: Partial<GameIdentity> = {}) => ({
      name,
      manifestURL: `https://${name}.example/manifest.json`,
      entryURL: `https://${name}.example/`,
      developer: owner.address,
      ...declared,
    }),
    async reload() {
      const restored = make();
      restored.hydrate(await storage.get('game-wallet'));
      return restored;
    },
  };
}
