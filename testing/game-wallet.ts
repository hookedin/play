import { Wallet, id, keccak256 } from 'ethers';
import { CasinoWallet } from '../client/wallet.ts';
import { MemoryStore } from '../client/storage.ts';
import { generateHashChain } from '../protocol/hash-chain.ts';
import {
  domain,
  initialState,
  channelId,
  STATE_TYPES,
  deriveState,
  plain,
  checkpointEvidence,
} from '../protocol/protocol.ts';
export async function gameWallet(storage = new MemoryStore()) {
  const owner = Wallet.createRandom(),
    player = Wallet.createRandom(),
    key = Wallet.createRandom();
  const casino = Wallet.createRandom().address,
    d = domain(31337, casino),
    chain = generateHashChain(id('game-test-chain'), 1000);
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
  let settlements = 0,
    index = 0;
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
      if (path.endsWith('/round'))
        return {
          owner: path.split('/')[3],
          epoch: 1,
          index,
          length: 1000,
          roundHead: keccak256(chain.preimages[index]),
        };
      if (!path.endsWith('/operations')) return {};
      const { request, signature } = body as any;
      if (responses.has(request.operationId)) return responses.get(request.operationId);
      const base = wallet.current!,
        preimage = Number(request.kind) === 1 ? chain.preimages[index] : '0x' + '0'.repeat(64);
      const next = deriveState(d, base.state, request, preimage);
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
            preimage,
            casinoSignature: signed,
          },
        },
        bankroll,
      });
      responses.set(request.operationId, response);
      if (Number(request.kind) === 1) index++;
      settlements++;
      return response;
    };
    return wallet;
  };
  const wallet = make();
  await wallet.save();
  return {
    wallet,
    storage,
    owner,
    player,
    settlements: () => settlements,
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
