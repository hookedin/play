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
  plain,
  checkpointEvidence,
} from '../protocol/protocol.ts';
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
  const make = () => {
    const wallet = new CasinoWallet({ network: 'local', storage });
    Object.assign(wallet, {
      storageKey: 'game-wallet',
      address: player.address,
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
      if (!path.endsWith('/operations')) return {};
      const { request, signature } = body as any;
      if (responses.has(request.operationId)) return responses.get(request.operationId);
      const seats = hosted.get(request.round);
      if (seats) {
        if (request.seed !== seats.seed) throw new Error('Every bet in a round shares its seed');
        if (!seats.seats.some(seat => seat.request.operationId === request.operationId))
          seats.seats.push({ request, signature });
        return { status: 'seated', operationId: request.operationId };
      }
      return settle(request, signature);
    };
    const settle = async (request: any, signature: string) => {
      const base = wallet.current!,
        secret = Number(request.kind) === 1 ? secrets.get(request.round)! : ZeroHash;
      const next = deriveState(d, base.state, request, secret);
      const signed = await owner.signTypedData(d, STATE_TYPES, next);
      const response = plain({
        state: next,
        casinoSignature: signed,
        developer: request.developer,
        evidence: {
          ...checkpointEvidence(base.state, base.playerSignature, base.casinoSignature),
          step: {
            operation: request,
            authorization: signature,
            secret,
            casinoSignature: signed,
          },
        },
        bankroll,
        ...(request.round === own ? { nextRound: (own = createRound()) } : {}),
      });
      responses.set(request.operationId, response);
      settlements++;
      return response;
    };
    closers.add(async (round: string) => {
      for (const seat of hosted.get(round)?.seats ?? []) await settle(seat.request, seat.signature);
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
    /** What a game's host does at the casino: open a round with its seed, and close it. */
    openRound(seed = hexlify(randomBytes(32))) {
      const id = createRound();
      hosted.set(id, { seed, seats: [] });
      return { id, seed };
    },
    async closeRound(round: string) {
      for (const close of closers) await close(round);
    },
    identity: (name = 'test') => ({
      name,
      manifestURL: `https://${name}.example/manifest.json`,
      entryURL: `https://${name}.example/`,
      developer: owner.address,
    }),
    async reload() {
      const restored = make();
      restored.hydrate(await storage.get('game-wallet'));
      return restored;
    },
  };
}
