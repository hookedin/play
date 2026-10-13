import test from 'node:test';
import assert from 'node:assert/strict';
import { COINS, chainAddress, minPriceX128, openChannel, typedRefund } from '../client/chainflip.ts';
import { typedUnits } from '../client/withdrawal.ts';

const BTC = COINS[0]!,
  ARB_ETH = COINS[6]!,
  ARB_USDC = COINS[7]!;
const player = '0xF67DC3844E1428e96e644150a46fDA4cdD533c9C';
const deposit = '0x731677c3db6ebeff47399bacd8bc3a12e793a42c';

test('the price limit is the quote less its slippage, in smallest units times 2^128, as the Chainflip SDK makes it', () => {
  // Values from the SDK's arithmetic at 120 digits, for quotes Chainflip gave on 2026-10-13.
  assert.equal(
    minPriceX128('0.00037772481483121523', 125, ARB_USDC),
    126926430360094880706002710801442646427688602471n,
  );
  assert.equal(minPriceX128('33.1891208113434404806', 250, BTC), 110113307710662004017922399187001020119108614916395n);
  assert.equal(minPriceX128('0.9998', 75, ARB_ETH), 337662703119197618702401818016454743880n);
});

test('addresses are taken on their own chain, in one form', () => {
  assert.equal(chainAddress('Arbitrum', deposit), '0x731677c3db6eBeff47399BaCD8BC3a12e793a42C');
  assert.equal(chainAddress('Ethereum', player), player);
  assert.equal(chainAddress('Ethereum', player.replace('F67', 'f67')), null);
  assert.equal(chainAddress('Ethereum', ` ${player}`), null);
  assert.equal(
    chainAddress('Bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'),
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  );
  assert.equal(chainAddress('Bitcoin', 'BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ'), null);
  assert.equal(chainAddress('Bitcoin', player), null);
  assert.equal(
    chainAddress('Solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  );
  assert.equal(chainAddress('Solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt10'), null);
  // What the player types is read generously, and leaves in its one form.
  assert.equal(
    typedRefund(BTC, ' BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ '),
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  );
  assert.equal(typedRefund(ARB_USDC, ` ${player.toLowerCase()} `), player);
  assert.equal(typedUnits(' 0.0123 ', 8), 1230000n);
  assert.equal(typedUnits('0.000000001', 8), null);
});

/** Chainflip as the wallet meets it, answering each request with what `answers` holds for its path. */
function chainflip(answers: Record<string, unknown>) {
  const sent: Record<string, any> = {};
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname,
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent[path] = { url, body };
    const answer = answers[path === '/' ? body.method : path];
    return new Response(JSON.stringify(answer), { status: answer === undefined ? 404 : 200 });
  }) as typeof fetch;
  return sent;
}
const answers = () => ({
  '/api/networkInfo': { assets: [], cfBrokerCommissionBps: 30 },
  cf_environment: {
    result: {
      ingress_egress: { minimum_deposit_amounts: { Arbitrum: { USDC: '0x989680' }, Bitcoin: { BTC: '0x9c40' } } },
    },
  },
  '/v2/quote': [
    {
      type: 'REGULAR',
      srcAsset: { chain: 'Arbitrum', asset: 'USDC' },
      destAsset: { chain: 'Ethereum', asset: 'ETH' },
      depositAmount: '10000000',
      egressAmount: '3761306584668744',
      estimatedPrice: '0.00037772481483121523',
      recommendedSlippageTolerancePercent: 1.25,
      recommendedLivePriceSlippageTolerancePercent: 0.75,
      recommendedRetryDurationMinutes: 5,
      estimatedDurationSeconds: 114.65,
    },
  ],
  '/api/openSwapDepositChannel': {
    id: '15225766-Arbitrum-1837',
    depositAddress: deposit,
    brokerCommissionBps: 30,
    maxBoostFeeBps: 0,
    issuedBlock: 15225766,
    srcChainExpiryBlock: '514680192',
    estimatedExpiryTime: 1791958086960,
    channelOpeningFee: '0',
  },
  '/v2/swaps/15225766-Arbitrum-1837': {
    state: 'WAITING',
    srcAsset: 'USDC',
    srcChain: 'Arbitrum',
    destAsset: 'ETH',
    destChain: 'Ethereum',
    destAddress: player,
    depositChannel: { id: '15225766-Arbitrum-1837', depositAddress: deposit, isExpired: false },
    fillOrKillParams: { refundAddress: player },
  },
});

test('a channel opens for the deposit address, with Chainflip’s commission quoted and the price limit set', async () => {
  const sent = chainflip(answers());
  const channel = await openChannel(ARB_USDC, 10000000n, player, player);
  assert.equal(channel.depositAddress, '0x731677c3db6eBeff47399BaCD8BC3a12e793a42C');
  assert.equal(channel.minimum, 10000000n);
  assert.equal(channel.quote.egressAmount, 3761306584668744n);
  assert.equal(new URL(sent['/v2/quote'].url).searchParams.get('brokerCommissionBps'), '30');
  assert.deepEqual(sent['/api/openSwapDepositChannel'].body, {
    srcAsset: { chain: 'Arbitrum', asset: 'USDC' },
    destAsset: { chain: 'Ethereum', asset: 'ETH' },
    destAddress: player,
    amount: '10000000',
    fillOrKillParams: {
      retryDurationBlocks: 50,
      refundAddress: player,
      minPriceX128: '126926430360094880706002710801442646427688602471',
      maxOraclePriceSlippage: 75,
    },
    takeCommission: true,
  });
});

test('a channel is refused unless Chainflip states it as asked', async () => {
  await assert.rejects(openChannel(ARB_USDC, 9999999n, player, player), /at least 10 USDC/);
  for (const [path, change] of [
    ['/api/openSwapDepositChannel', { brokerCommissionBps: 100 }],
    ['/api/openSwapDepositChannel', { depositAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }],
    ['/v2/swaps/15225766-Arbitrum-1837', { destAddress: deposit }],
    ['/v2/swaps/15225766-Arbitrum-1837', { fillOrKillParams: { refundAddress: deposit } }],
    ['/v2/swaps/15225766-Arbitrum-1837', { state: 'SWAPPING' }],
  ] as const) {
    const changed: Record<string, any> = answers();
    changed[path] = { ...changed[path], ...change };
    chainflip(changed);
    await assert.rejects(
      openChannel(ARB_USDC, 10000000n, player, player),
      /Chainflip’s channel/,
      JSON.stringify(change),
    );
  }
  const quoted: Record<string, any> = answers();
  quoted['/v2/quote'][0].depositAmount = '1';
  chainflip(quoted);
  await assert.rejects(openChannel(ARB_USDC, 10000000n, player, player), /Chainflip’s quote/);
});
