/// <reference path="../types/browser.d.ts" />
import type { JsonRpcProvider, Signer } from 'ethers';
import type { Store } from './storage.ts';
import type { Domain, Deployment, Checkpoint, Opening, Evidence, PlayerDeveloperBet } from '../protocol/types.ts';
import type { ChainBlock } from '../protocol/chain-observer.ts';
import type { GameSession } from '../protocol/game-types.ts';
export interface WalletOptions {
  casinoURL?: string;
  network?: string;
  onChange?: (wallet: CasinoWallet) => void;
  onProgress?: (message: string) => void;
  /** A game's bet that settled later was collected: the receipt it now has, for the game that placed it. */
  onGameReceipt?: (game: GameIntent, receipt: any) => void;
  storage?: Store;
  trustedDeployment?: Deployment | null;
}
export interface WalletChannel {
  key?: string;
  opening: Opening;
  state: Checkpoint;
  playerSignature: string;
  casinoSignature: string;
  onchain: any;
  claim?: any;
  observedAt?: number;
  lastResponse?: { evidence: Evidence } | null;
  /** This channel's next own round, named by the casino's reply to the last bet or asked for. */
  round?: string;
  pending?: any;
  closing?: boolean;
}
/** The game an operation belongs to, saved with the pending request so a reload can attribute its receipt. */
export interface GameIntent {
  key: string;
  id: string;
  /** The game's own name, so a receipt still says where the money went long after the game is closed. */
  name: string;
  /** The game's developer, whose bank takes its developer bets and whose key signs their settlements. */
  developer: string;
}
import { BrowserProvider, Contract, Wallet, getAddress, ZeroHash } from 'ethers';
import {
  domain,
  canonicalJSON,
  json,
  plain,
  same,
  MAX_JSON_BYTES,
  STATE_TYPES,
  ACCESS_TYPES,
  authorization,
  initialState,
  hashState,
  checkpointEvidence,
  verifyEvidence,
  assertProtocol,
} from '../protocol/protocol.ts';
import {
  ChainObserver,
  createRpcProvider,
  requireIndependentRpc,
  requireCanonicalBlock,
} from '../protocol/chain-observer.ts';
import { mapBounded } from '../protocol/concurrency.ts';
import { BrowserStore, withLock } from './storage.ts';
import { fundingAccounts, readFundingAccounts } from './funding-accounts.ts';
import { verifyDeployment } from '../protocol/deployment.ts';
import { encryptBackup, decryptBackup } from './backup.ts';
import trustedArtifact from './contract-artifact.ts';
import { gameAmount } from './game-account.ts';
import { MIN_GAS_RESERVE, channelRecord, picked } from './wallet-transactions.ts';
import { GameSessions } from './wallet-games.ts';
export { MIN_GAS_RESERVE } from './wallet-transactions.ts';
export const HISTORICAL_CHANNEL_BATCH = 16;
const networks: Record<string, { id: bigint; name: string; stake: string }> = {
  sepolia: { id: 11155111n, name: 'Sepolia', stake: '1000000000000' },
  local: { id: 31337n, name: 'Anvil test chain', stake: '1000000000000000' },
};
/**
 * The independent wallet. Its concerns are layered as a class chain kept in their own files:
 * on-chain transactions (`wallet-transactions.ts`), the off-chain channel protocol
 * (`wallet-channel.ts`) and the open game's spending limit (`wallet-games.ts`). This file owns
 * configuration, durable state, locking, observation and the casino API transport.
 */
export class CasinoWallet extends GameSessions {
  declare casinoURL: string;
  declare network: string;
  declare expectedChainId: bigint;
  declare networkName: string;
  declare recommendedStake: string;
  declare onChange: (wallet: CasinoWallet) => void;
  declare onProgress: (message: string) => void;
  declare onGameReceipt: (game: GameIntent, receipt: any) => void;
  declare storage: Store;
  declare trustedDeployment: Deployment | null;
  declare publicState: Record<string, any>;
  declare history: any[];
  /** This account's bankroll shares: the casino's latest signed statement, and redeemed money not yet collected. */
  declare fund: {
    sequence: number;
    shares: string;
    statement: { message: any; signature: string } | null;
    redeeming?: { message: any; signature: string } | null;
    owed?: string[];
    alert?: string;
  };
  /** This account's developer bets, by hash, until what each was paid is collected: the receipt that placed it,
   * and what the casino last said of it. */
  declare developerBets: Record<
    string,
    { operationId?: string; game: string; state?: PlayerDeveloperBet; error?: string }
  >;
  /** Where the feed of this account's settled developer bets was read up to. */
  declare developerBetCursor: string;
  developerBetError: string | null = null;
  /** This account's bank as a developer: the casino's statement for its latest deposit or withdrawal, a withdrawal
   * signed and not yet answered, and withdrawn money not yet collected. */
  declare bank: {
    statement?: { message: any; signature: string };
    withdrawing?: { message: any; signature: string } | null;
    owed?: string[];
  };
  /** What the casino says this account's games have earned and what it has collected; shown, never relied on. */
  declare developerEarnings: { earned: string; collected: string } | null;
  declare channels: Record<string, WalletChannel>;
  declare busy: boolean;
  declare mode: string;
  declare revision: number;
  declare verifiedChainId: bigint | null;
  declare sending: boolean | undefined;
  declare transactionIntent: any;
  declare config: any;
  declare recoveryOnly: boolean;
  declare provider: JsonRpcProvider;
  declare witnessProvider: JsonRpcProvider | undefined;
  declare observer: ChainObserver;
  declare timer: ReturnType<typeof setInterval> | undefined;
  declare savedFundingAddresses: string[];
  declare signer: Signer;
  declare address: string;
  declare contract: Contract;
  declare reader: Contract;
  declare storageKey: string;
  declare operator: string;
  declare domain: Domain;
  declare lastChainCheck: number;
  /** The account's channel: what deposits, play, closes and recovery are about. */
  declare channelId: string | null;
  /** The player chose to practice in this tab although the account has ETH to play with. */
  declare preferPractice: boolean;
  declare storageFailed: boolean | undefined;
  declare refreshing: Promise<any> | null;
  declare nativeBalance: string;
  declare missingChannel: string | null;
  declare detailsError: string | null;
  declare detailsRefreshing: Promise<Record<string, any>> | null;
  declare monitorCursor: number;
  declare detailsObservedAt: number;
  /** This account's uname, as the casino last reported it: permanent, and written `~uname`. */
  declare uname: string | null;
  /** The alias it is shown by instead, written `@alias`; null until it takes one. */
  declare alias: string | null;
  /** The public profile those names carry: when the casino first knew it, what it has played, and
   * the games it publishes. Read from the public route, like anybody else's. */
  declare profile: {
    uname: string;
    alias: string | null;
    since: number;
    stats: any;
    games: { name: string; url: string; key: string; developer: string }[];
  } | null;
  reportedBankroll = '0';
  /** Each channel's signed `Access` token while it has time left: one signature serves a minute of requests. */
  tokens = new Map<string, { expiresAt: number; header: string }>();
  declare actionDone: Promise<void> | undefined;
  declare game: GameSession | null;
  constructor({
    casinoURL = 'http://127.0.0.1:4183',
    network = 'sepolia',
    onChange = () => {},
    onProgress = () => {},
    onGameReceipt = () => {},
    storage = new BrowserStore(),
    trustedDeployment = null,
  }: WalletOptions = {}) {
    super();
    const n = networks[network];
    if (!n) throw new Error('Only Sepolia and explicit local Anvil are supported');
    Object.assign(this, {
      casinoURL,
      network,
      expectedChainId: n.id,
      networkName: n.name,
      recommendedStake: n.stake,
      onChange,
      onProgress,
      onGameReceipt,
      storage,
      trustedDeployment,
      publicState: {},
      uname: null,
      alias: null,
      profile: null,
      fund: { sequence: 0, shares: '0', statement: null },
      developerBets: {},
      developerBetCursor: '0',
      bank: {},
      developerEarnings: null,
      preferPractice: false,
      history: [],
      channels: {},
      busy: false,
      mode: 'demo',
      revision: 0,
    });
  }
  get isLocalDevelopment() {
    return (
      this.expectedChainId === 31337n &&
      this.verifiedChainId === 31337n &&
      String(this.config?.chainId) === '31337' &&
      this.config?.isLocalDevelopment === true
    );
  }
  get gasReserve() {
    return MIN_GAS_RESERVE;
  }
  validateConfiguredNetwork() {
    if (String(this.config?.chainId) !== String(this.expectedChainId)) {
      const actual = this.config?.chainId ?? 'unknown';
      const hint =
        this.network === 'sepolia' && String(actual) === '31337'
          ? ' Stop the Anvil services and run npm run sepolia to start Sepolia.'
          : '';
      throw new Error(
        `This client requires ${this.networkName} (chain ${this.expectedChainId}). The casino reports chain ${actual}.${hint}`,
      );
    }
  }
  async assertNetwork({ signer = this.signer } = {}) {
    this.verifiedChainId = null;
    this.validateConfiguredNetwork();
    // getNetwork() may cache a previously selected injected network. Read the
    // current chain directly, then pin this same chain ID on the transaction.
    const actualChain = BigInt(await this.provider.send('eth_chainId', []));
    if (actualChain !== this.expectedChainId)
      throw new Error(
        `Casino RPC must be on ${this.networkName} (chain ${this.expectedChainId}). No transaction was signed.`,
      );
    if (signer) {
      if (!signer.provider) throw new Error('The signing wallet has no connected network.');
      const signerChain =
        signer.provider === this.provider
          ? actualChain
          : BigInt(await (signer.provider as JsonRpcProvider).send('eth_chainId', []));
      if (signerChain !== this.expectedChainId)
        throw new Error(
          `Switch your signing wallet to ${this.networkName} (chain ${this.expectedChainId}). No transaction was signed.`,
        );
    }
    this.verifiedChainId = actualChain;
  }
  async start() {
    const key = `config:${this.expectedChainId}:${this.casinoURL}`;
    const pinKey = `deployment:${this.expectedChainId}:${this.casinoURL}`;
    const trusted = this.trustedDeployment || (await this.storage.get(pinKey));
    let advertised, serviceError;
    try {
      advertised = await this.api('/api/config');
      assertProtocol(advertised);
      if (
        !advertised ||
        String(advertised.chainId) !== String(this.expectedChainId) ||
        (trusted &&
          (!same(advertised.contractAddress, trusted.contractAddress) || !same(advertised.operator, trusted.operator)))
      )
        throw new Error('Casino configuration differs from the trusted network, deployment or protocol');
    } catch (error: any) {
      serviceError = error.message;
    }
    const cached = await this.storage.get(key);
    if (trusted) {
      if (!trusted.rpcUrl && this.network !== 'local')
        throw new Error('Install a deployment manifest with independently chosen RPC URLs');
      this.config = {
        ...(!serviceError ? advertised : {}),
        ...trusted,
        rpcUrl: trusted.rpcUrl || cached?.rpcUrl || advertised?.rpcUrl,
        isLocalDevelopment: !serviceError && advertised?.isLocalDevelopment === true,
      };
    } else {
      if (serviceError)
        throw new Error('Casino unavailable or incompatible and no trusted deployment: ' + serviceError);
      this.config = advertised;
    }
    this.recoveryOnly = Boolean(serviceError);
    this.validateConfiguredNetwork();
    this.config.confirmations = this.expectedChainId === 11155111n ? 2 : 1;
    this.provider = createRpcProvider(this.config.rpcUrl);
    if (this.network !== 'local') {
      requireIndependentRpc(this.config.rpcUrl, this.config.witnessRpcUrl);
      this.witnessProvider = createRpcProvider(this.config.witnessRpcUrl);
    }
    this.observer = new ChainObserver({
      provider: this.provider,
      witnessProvider: this.witnessProvider,
      chainId: this.expectedChainId,
      finality: this.config.confirmations || 1,
    });
    const deployment = await verifyDeployment({
      observer: this.observer,
      provider: this.provider,
      address: this.config.contractAddress,
      chainId: this.expectedChainId,
      expected: trusted,
    });
    this.config.abi = trustedArtifact.abi;
    this.config.operator = deployment.operator;
    await this.storage.put(pinKey, {
      ...deployment,
      rpcUrl: this.config.rpcUrl,
      witnessRpcUrl: this.config.witnessRpcUrl,
      abi: undefined,
    });
    this.provider.pollingInterval = this.network === 'local' ? 100 : 3000;
    const vault = await fundingAccounts(this.storage, this.expectedChainId, { create: true });
    await this.useSigner(new Wallet(vault.accounts[vault.selected!], this.provider), 'demo', { select: false });
    await this.storage.put(key, this.config);
    // The single observation loop; the page only re-renders from wallet state.
    this.timer = setInterval(() => {
      if (!this.busy)
        void this.refresh()
          .then(() => this.collectPayouts())
          .catch(() => {});
    }, 4000);
    this.timer.unref?.();
    return this;
  }
  async useSigner(signer: Signer, mode: string, { select = true } = {}) {
    this.requireDurableState();
    if (this.busy || this.pending || this.needsOpening || this.transactionIntent)
      throw new Error('Recover the pending operation before changing wallets');
    this.busy = true;
    try {
      await this.refreshing?.catch(() => {});
      this.requireDurableState();
      await this.assertNetwork({ signer });
      const address = getAddress(await signer.getAddress());
      this.developerEarnings = null;
      const contract = new Contract(this.config.contractAddress, this.config.abi, signer);
      const reader = contract.connect(this.provider) as Contract;
      if ((await reader.CHALLENGE_PERIOD()) !== 86400n) throw new Error('Unexpected channel contract');
      const storageKey =
        'wallet:' +
        this.expectedChainId +
        ':' +
        this.config.contractAddress.toLowerCase() +
        ':' +
        address.toLowerCase();
      const run = async () => {
        if (mode === 'demo') {
          const vault = await fundingAccounts(this.storage, this.expectedChainId, {
            privateKeys: [(signer as Wallet).privateKey],
            select,
          });
          this.savedFundingAddresses = Object.keys(vault.accounts);
        }
        Object.assign(this, {
          signer,
          mode,
          address,
          contract,
          reader,
          storageKey,
          operator: this.config.operator,
          domain: domain(this.expectedChainId, this.config.contractAddress),
          lastChainCheck: 0,
        });
        this.hydrate(await this.storage.get(storageKey));
        await this.refreshLocked();
        if (this.channel?.key) await this.reconcile().catch(() => {});
      };
      await withLock('hookedin:channel:' + storageKey, true, run);
    } finally {
      this.busy = false;
      this.render();
    }
  }
  hydrate(saved: any) {
    if (saved && saved.schema !== 'HOOKEDIN/WALLET-STATE/1') throw new Error('Unsupported wallet state');
    Object.assign(this, {
      channels: saved?.channels || {},
      channelId: saved?.channelId || null,
      history: saved?.history || [],
      revision: saved?.revision || 0,
      transactionIntent: saved?.transactionIntent || null,
      // Bankroll shares, developer bets and a developer's bank belong to the account, not to any one channel.
      fund: saved?.fund || { sequence: 0, shares: '0', statement: null },
      developerBets: saved?.developerBets || {},
      developerBetCursor: saved?.developerBetCursor || '0',
      developerBetError: null,
      bank: saved?.bank || {},
    });
  }
  get channel(): WalletChannel | null {
    return this.channels[this.channelId!] || null;
  }
  /** Whether this account can play with ETH: its channel has its key, is open and is not closing. */
  get funded() {
    const c = this.channel;
    return Boolean(c?.key) && Number(c!.onchain?.status) === 1 && !c!.closing;
  }
  /** What games play with in this tab: test coins, the practice money it keeps, unless the account can play with
   * ETH and the player has not chosen to practice. */
  get practicing() {
    return !this.funded || this.preferPractice;
  }
  /** What games play with, as a game is told it: test coins, or the network's ETH. Both count in units of 10^-18. */
  get asset() {
    return {
      symbol: this.practicing ? 'TEST' : this.networkName === 'Sepolia' ? 'Sepolia ETH' : 'ETH',
      decimals: 18,
    };
  }
  get pending() {
    return this.channel?.pending || null;
  }
  set pending(value) {
    if (!this.channel) throw new Error('A pending operation requires a channel');
    this.channel.pending = value;
  }
  get needsOpening() {
    return Boolean(this.channel && Number(this.channel.onchain?.status || 0) === 0);
  }
  requireDurableState() {
    if (this.storageFailed) throw new Error('Wallet storage needs recovery; reload from durable state');
  }
  async save(receipt: any = undefined, changes: Record<string, any> = {}) {
    this.requireDurableState();
    const revision = this.revision + 1;
    // Newest first by the clock, not by when a receipt was last written: a developer bet's receipt is
    // rewritten when what it was paid is collected, and would otherwise jump above the bets placed after it.
    const outstanding = new Set(
      Object.values(changes.developerBets ?? this.developerBets).map((bet: any) => bet.operationId),
    );
    const history = receipt
      ? [receipt, ...this.history.filter(r => r.operationId !== receipt.operationId)]
          .sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''))
          .filter((entry, index) => index < 100 || outstanding.has(entry.operationId))
      : this.history;
    let record;
    try {
      record = plain({
        schema: 'HOOKEDIN/WALLET-STATE/1',
        channels: this.channels,
        channelId: this.channelId,
        history,
        transactionIntent: this.transactionIntent,
        fund: this.fund,
        developerBets: this.developerBets,
        developerBetCursor: this.developerBetCursor,
        bank: this.bank,
        ...changes,
        revision,
      });
      const entries: [string, unknown][] = [[this.storageKey, record]];
      if (receipt) entries.push([this.storageKey + ':receipt:' + receipt.operationId, plain(receipt)]);
      await this.storage.commit(entries);
    } catch (error) {
      this.storageFailed = true;
      throw error;
    }
    if (Object.keys(changes).length) this.hydrate(record);
    else {
      this.revision = revision;
      this.history = history;
    }
    this.render();
  }
  /** Every channel reply carries both names its player answers to. */
  noteNames(this: CasinoWallet, reply: { uname?: unknown; alias?: unknown }) {
    if (typeof reply?.uname !== 'string') return;
    const alias = typeof reply.alias === 'string' ? reply.alias : null;
    if (reply.uname === this.uname && alias === this.alias) return;
    this.uname = reply.uname;
    this.alias = alias;
    this.profile = null;
    void this.refreshProfile().catch(() => {});
  }
  /** This account's public record, read from the route everyone reads it from. */
  async refreshProfile(this: CasinoWallet) {
    if (!this.uname) return null;
    const profile = await this.api(`/api/players/~${this.uname}`);
    if (profile?.uname === this.uname) {
      this.profile = profile;
      this.alias = profile.alias;
      this.render();
    }
    return this.profile;
  }
  /** Take the alias this account is shown by, or give it up. Only from a funded channel. */
  async pickAlias(this: CasinoWallet, alias: string | null) {
    const c = this.channel;
    if (!c?.key || Number(c.onchain?.status) !== 1) throw new Error('Open a funded channel before taking an alias');
    this.profile = await this.api(`/api/channels/${c.state.channelId}/alias`, { alias: alias?.trim() ?? null }, c);
    this.uname = this.profile!.uname;
    this.alias = this.profile!.alias;
    this.render();
    return this.profile;
  }
  /**
   * Publish a game under this account, its developer, or, with no URL, take it out of the profile. Publishing
   * claims a public name and asks for a funded channel; taking your own game down only has to be you, so a
   * developer who has closed their channel can still withdraw a game that turned out to be broken.
   */
  async publishGame(this: CasinoWallet, name: string, url: string | null) {
    // Publishing speaks from the open channel. Taking a game down speaks from any channel this account
    // still holds a key for, including one already closed, because a broken game has to come down
    // whether or not its developer still has money at stake.
    const c = url ? this.channel : (this.channel ?? Object.values(this.channels).find(row => row.key));
    if (!c?.key) throw new Error('This account has no channel to publish from');
    if (url && Number(c.onchain?.status) !== 1) throw new Error('Open a funded channel to publish games');
    this.profile = await this.api(`/api/channels/${c.state.channelId}/games`, { name: name.trim(), url }, c);
    this.render();
    return this.profile;
  }
  render() {
    this.syncSession();
    const c = this.channel;
    this.publicState = {
      address: this.address,
      balance: c && Number(c.onchain?.status) === 1 ? c.state.balance : '0',
      nativeBalance: this.nativeBalance || '0',
      channelId: c?.state.channelId || null,
      channelStatus: c?.onchain?.status || '0',
      protectedDeposit: c && Number(c.onchain?.status) !== 3 ? c.opening.deposit : '0',
      deadline: c?.onchain?.deadline || '0',
      observedAt: this.lastChainCheck || 0,
      savedSequence: c?.state.sequence || '0',
      closingSequence: c?.onchain?.closingSequence || '0',
      challengePending: this.transactionIntent?.method === 'challengeClose',
      balanceAtRisk:
        c && Number(c.onchain?.status) === 2
          ? String(
              BigInt(c.state.balance) > BigInt(c.onchain.closingBalance)
                ? BigInt(c.state.balance) - BigInt(c.onchain.closingBalance)
                : 0n,
            )
          : '0',
      needsChallenge: Boolean(
        c && Number(c.onchain?.status) === 2 && BigInt(c.state.sequence) > BigInt(c.onchain.closingSequence),
      ),
      claims: Object.values(this.channels)
        .filter(v => v.claim)
        .map(v => ({ channelId: v.state.channelId, observedAt: v.observedAt, ...v.claim })),
      chainId: String(this.expectedChainId),
      // What games play with in this tab: the test coins it practices with, or the channel's ETH.
      playBalance: this.practicing ? String(this.practiceBalance) : c!.state.balance,
      practiceBalance: String(this.practiceBalance),
      // Commission this account's games have earned, as the casino reports it to this channel.
      developerEarnings: this.developerEarnings,
    };
    this.onChange(this);
    return this.publicState;
  }
  /** Run `fn` holding this channel's lock, after loading a newer revision saved by another tab
   * (`changed`). Without `wait`, a lock held elsewhere runs `fn` with `held` false. */
  async withChannelLock<T>(wait: boolean | number, fn: (held: boolean, changed: boolean) => Promise<T>) {
    return withLock(`hookedin:channel:${this.storageKey}`, wait, async held => {
      if (!held) return fn(false, false);
      const saved = await this.storage.get(this.storageKey);
      this.requireDurableState();
      const changed = (saved?.revision || 0) > this.revision;
      if (changed) this.hydrate(saved);
      return fn(true, changed);
    });
  }
  async refresh({ channelId }: { channelId?: string | null } = {}) {
    this.requireDurableState();
    if (this.busy) return this.publicState;
    if (this.refreshing) {
      await this.refreshing;
      return this.publicState;
    }
    const pending = this.withChannelLock(false, async held => {
      if (!held) return;
      try {
        await this.refreshLocked({ channelId });
      } catch (error) {
        this.lastChainCheck = 0;
        throw error;
      }
    });
    this.refreshing = pending;
    try {
      await pending;
    } finally {
      if (this.refreshing === pending) this.refreshing = null;
    }
    void this.refreshDetails();
    return this.publicState;
  }
  async observeChannels(keys: string[], block: ChainBlock): Promise<[string, any, any][]> {
    return mapBounded(keys, async key => {
      const value = await this.observer.contractRead(this.reader, 'channels', [key], block);
      const onchain = channelRecord(value);
      let claim = null;
      if (Number(value.status) === 3) {
        // Two reads of one block, asked together.
        const [terms, allocated] = await Promise.all([
          this.observer.contractRead(this.reader, 'claims', [key], block),
          this.observer.contractRead(this.reader, 'allocatedWinnings', [key], block),
        ]);
        claim = {
          ...picked(terms, [
            'beneficiary',
            'stateHash',
            'amount',
            'paid',
            'protectedRemaining',
            'winningsRemaining',
            'finalizedAt',
          ]),
          allocatedWinnings: String(allocated),
        };
      }
      return [key, onchain, claim];
    });
  }
  applyChannelObservations(records: any[]) {
    for (const [key, onchain, claim] of records) {
      this.channels[key].onchain = onchain;
      this.channels[key].claim = claim;
      this.channels[key].observedAt = Date.now();
    }
  }
  async refreshLocked({ channelId: also }: { channelId?: string | null } = {}) {
    this.requireDurableState();
    // Both must pass before anything is read; together their requests share a round trip.
    const [, observation] = await Promise.all([this.assertNetwork(), this.observer.observe()]);
    const [native, active] = await Promise.all([
      this.observer.balance(this.address, observation.block),
      this.observer.contractRead(this.reader, 'activeChannel', [this.address], observation.block),
    ]);
    // Only current recovery state belongs inside the action lock.
    const selected = [...new Set([active, this.channelId, also])].filter(key => this.channels[key]);
    const before = this.durable();
    const records = await this.observeChannels(selected, observation.block);
    await this.observer.accept(observation);
    this.nativeBalance = String(native);
    this.lastChainCheck = Date.now();
    this.missingChannel = active !== ZeroHash && !this.channels[active] ? active : null;
    this.applyChannelObservations(records);
    if (this.channel && Number(this.channel.onchain?.status) === 3) this.channelId = null;
    if (active !== ZeroHash && this.channels[active]) this.channelId = active;
    await this.saveChanges(before);
    return this.publicState;
  }
  /** The record contents that warrant a new durable revision; observation times are display only. */
  durable() {
    return json([
      this.channelId,
      this.transactionIntent,
      this.history,
      Object.entries(this.channels).map(([key, c]) => [key, { ...c, observedAt: undefined }]),
    ]);
  }
  /** An unchanged observation must not bump the durable revision that other tabs act on;
   * the first observation of a fresh account still creates its record. */
  async saveChanges(before: string) {
    if (!this.revision || this.durable() !== before) await this.save();
    else this.render();
  }
  async refreshDetails() {
    if (this.detailsRefreshing) return this.detailsRefreshing;
    if (this.busy || this.storageFailed) return this.publicState;
    const storageKey = this.storageKey,
      reader = this.reader,
      observer = this.observer;
    const current = () => this.storageKey === storageKey && this.reader === reader;
    const errors: Record<string, string | undefined> = {};
    const report = (part: string, error: any = undefined) => {
      if (!current()) return;
      errors[part] = error?.message;
      this.detailsError = Object.values(errors).filter(Boolean).join('; ') || null;
      this.render();
    };
    // Only these short commits join the action lock. Merge into the latest
    // durable record so unrelated active-channel refreshes cannot starve history.
    const commit = async (apply: () => void) => {
      while (this.refreshing) await this.refreshing.catch(() => {});
      if (!current() || this.busy || this.storageFailed) return;
      const pending = this.withChannelLock(false, async held => {
        if (!held || !current() || this.busy || this.storageFailed) return;
        const before = this.durable();
        apply();
        await this.saveChanges(before);
      });
      this.refreshing = pending;
      try {
        await pending;
      } finally {
        if (this.refreshing === pending) this.refreshing = null;
      }
    };
    this.detailsRefreshing = (async () => {
      const bankrollBefore = this.reportedBankroll;
      await Promise.all([
        (async () => {
          try {
            const observation = await observer.observe();
            if (!current()) return;
            const keys = Object.keys(this.channels).filter(key => key !== this.channelId);
            const cursor = (this.monitorCursor || 0) % (keys.length || 1);
            const selected = Array.from(
              { length: Math.min(keys.length, HISTORICAL_CHANNEL_BATCH) },
              (_, i) => keys[(cursor + i) % keys.length],
            );
            const before = new Map(selected.map(key => [key, json(this.channels[key])]));
            const history = this.history;
            const historyBefore = new Map(history.map(entry => [entry.operationId, json(entry)]));
            // Share the eight-read budget between old claims and activity.
            const records = await this.observeChannels(selected, observation.block);
            const activity = new Map(
              (await this.observeTransactionHistory(observation.block, history)).map(entry => [
                entry.operationId,
                entry,
              ]),
            );
            await observer.corroborate('wallet activity block', async rpc => {
              await requireCanonicalBlock(rpc, observation.block);
              return observation.block.hash;
            });
            await commit(() => {
              this.applyChannelObservations(
                records.filter(([key]) => key !== this.channelId && before.get(key) === json(this.channels[key])),
              );
              this.history = this.history.map(entry =>
                activity.has(entry.operationId) && historyBefore.get(entry.operationId) === json(entry)
                  ? activity.get(entry.operationId)
                  : entry,
              );
              this.monitorCursor = (cursor + HISTORICAL_CHANNEL_BATCH) % (keys.length || 1);
              this.detailsObservedAt = Date.now();
            });
            report('activity');
          } catch (error) {
            report('activity', error);
          }
        })(),
        (async () => {
          if (this.recoveryOnly || !this.uname) return;
          try {
            await this.refreshProfile();
            report('profile');
          } catch (error) {
            report('profile', error);
          }
        })(),
        (async () => {
          if (this.recoveryOnly) return;
          try {
            const { bankroll } = await this.api('/api/metrics');
            gameAmount(bankroll, false);
            await commit(() => {
              if (this.reportedBankroll === bankrollBefore) this.reportedBankroll = bankroll;
            });
            report('bankroll');
          } catch (error) {
            report('bankroll', error);
          }
        })(),
      ]);
      return this.publicState;
    })().finally(() => {
      this.detailsRefreshing = null;
    });
    return this.detailsRefreshing;
  }
  async exclusive<T>(fn: () => T | Promise<T>, { wait = false } = {}) {
    if (wait && this.busy && this.actionDone) await this.actionDone;
    this.requireDurableState();
    if (this.busy) throw new Error('Wallet is busy or storage needs recovery');
    this.busy = true;
    let finish!: () => void;
    this.actionDone = new Promise<void>(resolve => {
      finish = resolve;
    });
    this.render();
    try {
      // Do not mistake this instance's background observation for another tab.
      // busy is already set, so no new local refresh can enter while we wait.
      await this.refreshing?.catch(() => {});
      this.requireDurableState();
      // Every open tab observes the chain under this lock for a moment; an action waits that out instead of failing.
      return await this.withChannelLock(wait || 5000, async (held, changed) => {
        if (!held) throw new Error('Another tab is using this channel');
        if (changed && !wait) throw new Error('Wallet changed in another tab. Recover before continuing');
        return fn();
      });
    } finally {
      this.busy = false;
      finish();
      this.actionDone = undefined;
      this.render();
    }
  }
  ready(): asserts this is this & { channel: WalletChannel } {
    this.requireDurableState();
    this.requireService();
    if (!this.channel || Number(this.channel.onchain?.status) !== 1 || this.channel.closing)
      throw new Error('Open or recover a channel before playing');
    if (!this.lastChainCheck || Date.now() - this.lastChainCheck > 60000)
      throw new Error('Chain observations stale; refresh before playing');
    if (!this.channel.key) throw new Error('Channel key unavailable. Use independent recovery to close');
  }
  channelSigner(channel = this.channel!) {
    this.requireDurableState();
    return new Wallet(channel.key!);
  }
  async api(path: string, body: unknown = undefined, channel: WalletChannel | null = this.channel) {
    if (body !== undefined) this.requireDurableState();
    if (path !== '/api/config') this.requireService();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (path.startsWith('/api/channels/') && channel?.key) {
      const now = Math.floor(Date.now() / 1000);
      let token = this.tokens.get(channel.state.channelId);
      // A token is signed for a minute and used while it has twenty seconds left, room for a slow request.
      if (!token || token.expiresAt - now < 20) {
        const message = { channelId: channel.state.channelId, expiresAt: now + 60 };
        token = {
          expiresAt: message.expiresAt,
          header: authorization(
            message,
            await this.channelSigner(channel).signTypedData(this.domain, ACCESS_TYPES, message),
          ),
        };
        this.tokens.set(channel.state.channelId, token);
      }
      headers.authorization = token.header;
    }
    const response = await fetch(this.casinoURL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : json(body) }),
    });
    const reader = response.body!.getReader(),
      chunks = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error('Casino response too large; saved operations remain recoverable');
      }
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    const value = JSON.parse(new TextDecoder().decode(buffer));
    // The status tells a considered refusal from a reply that never arrived.
    if (!response.ok)
      throw Object.assign(new Error(value.error || 'Casino unavailable'), {
        status: response.status,
        code: value.code,
      });
    return value;
  }
  async connectInjected() {
    if (!window.ethereum) throw new Error('No browser wallet found');
    const provider = new BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    await this.useSigner(await provider.getSigner(), 'injected');
  }
  async importKey(privateKey: string) {
    await this.useSigner(new Wallet(privateKey.trim(), this.provider), 'demo');
  }
  async selectSavedAccount(address: string) {
    const vault = await readFundingAccounts(this.storage, this.expectedChainId);
    const key = vault.accounts[getAddress(address)];
    if (!key) throw new Error('No saved funding key for this address');
    await this.importKey(key);
  }
  requireService() {
    if (this.recoveryOnly)
      throw new Error(
        'Recovery mode: casino unavailable or incompatible. Saved evidence and on-chain settlement remain available; reload to reconnect',
      );
  }
  exportKey() {
    if (this.mode !== 'demo') throw new Error('Use your connected wallet to export its key');
    return (this.signer as Wallet).privateKey;
  }
  async encryptedBackup(password: string) {
    const value = await this.withSavedRecord(async record => ({
      schema: 'HOOKEDIN/WALLET/1',
      chainId: String(this.expectedChainId),
      casino: this.config.contractAddress,
      address: this.address,
      fundingKey: this.mode === 'demo' ? (this.signer as Wallet).privateKey : null,
      scope: 'selected-account',
      record,
    }));
    return encryptBackup(value, password);
  }
  async restoreBackup(backup: any, password: string) {
    if (this.busy || this.pending || this.needsOpening || this.transactionIntent)
      throw new Error('Recover the current operation before restoring a wallet');
    const value = await decryptBackup(backup, password);
    if (
      value.schema !== 'HOOKEDIN/WALLET/1' ||
      value.scope !== 'selected-account' ||
      value.chainId !== String(this.expectedChainId) ||
      !same(value.casino, this.config.contractAddress)
    )
      throw new Error('Backup belongs to another deployment');
    if (value.record?.schema !== 'HOOKEDIN/WALLET-STATE/1') throw new Error('Unsupported backup contents');
    // Verify signed settlement evidence and every retained channel key before writes.
    for (const c of Object.values(value.record.channels || {}) as WalletChannel[]) {
      if (!same(c.opening.player, value.address) || (c.key && !same(new Wallet(c.key!).address, c.opening.signer)))
        throw new Error('Backup channel identity differs');
      verifyEvidence({
        chainId: value.chainId,
        casino: value.casino,
        operator: this.operator,
        opening: c.opening,
        evidence: this.evidence(c),
      });
    }
    if (value.fundingKey && !same(new Wallet(value.fundingKey).address, value.address))
      throw new Error('Backup funding key differs');
    if (!same(value.address, this.address)) {
      if (!value.fundingKey) throw new Error('Connect the funding wallet named by this backup first');
      await this.importKey(value.fundingKey);
    }
    await this.exclusive(async () => {
      if (!same(value.address, this.address))
        throw new Error('Wallet changed while restoring; retry with the backup wallet');
      if (this.pending || this.transactionIntent)
        throw new Error('Recover the current operation before restoring a wallet');
      // exclusive reloads the persisted revision while holding the shared lock.
      for (const [id, old] of Object.entries(this.channels)) {
        const next = value.record.channels[id];
        if (
          !next ||
          BigInt(old.state.sequence) > BigInt(next.state.sequence) ||
          (BigInt(old.state.sequence) === BigInt(next.state.sequence) &&
            !same(hashState(this.domain, old.state), hashState(this.domain, next.state)))
        )
          throw new Error('Backup would discard newer or conflicting saved evidence');
        if (old.pending && canonicalJSON(old.pending) !== canonicalJSON(next.pending ?? null))
          throw new Error('Backup would discard or change a saved pending operation');
        // A close signature this wallet has released stays usable to the casino, even after a reorg.
        if (old.closing) next.closing = true;
      }
      const record = { ...value.record, revision: this.revision + 1 };
      try {
        await this.storage.commit([
          [this.storageKey, record],
          ...record.history.map((r: any) => [this.storageKey + ':receipt:' + r.operationId, r] as const),
        ]);
      } catch (error) {
        this.storageFailed = true;
        throw error;
      }
      this.hydrate(record);
    });
    await this.refresh();
    return this.publicState;
  }
  async recover() {
    const result = await this.exclusive(async () => {
      if (this.transactionIntent) await this.recoverTransaction();
      if (this.needsOpening) {
        const c = this.channel!,
          value = await this.reader.channels(c.state.channelId);
        if (Number(value.status) === 0) {
          const tx = await this.sendTransaction('openChannel', [c.opening.signer], {
            value: BigInt(c.opening.deposit),
          });
          await this.waitTransaction(tx);
        }
        return this.activate();
      }
      if (this.pending?.request) return this.resume();
      if (this.channel)
        this.noteNames(
          await this.api(`/api/channels/${this.channelId}/activate`, { opening: this.channel.opening }, this.channel),
        );
      await this.reconcile();
    });
    // A verified stored result is recoverable even while new play is paused.
    if (result?.verified)
      await this.refresh().catch(() => {
        this.lastChainCheck = 0;
      });
    else await this.refresh();
    return result;
  }
  evidence(channel = this.channel!) {
    if (channel.playerSignature && channel.playerSignature !== '0x')
      return checkpointEvidence(channel.state, channel.playerSignature, channel.casinoSignature);
    return channel.lastResponse?.evidence || checkpointEvidence(channel.state);
  }
  async withSavedRecord<T>(read: (record: any) => T | Promise<T>) {
    if (this.busy) throw new Error('Wait for the current wallet operation');
    this.busy = true;
    try {
      await this.refreshing?.catch(() => {});
      return await withLock('hookedin:channel:' + this.storageKey, true, async () => {
        const record = await this.storage.get(this.storageKey);
        if (!record) throw new Error('No wallet record to back up');
        return read(record);
      });
    } finally {
      this.busy = false;
      this.render();
    }
  }
  async exportEvidence(channelId?: string | null) {
    return this.withSavedRecord(async record => {
      const c = record.channels[channelId ?? record.channelId];
      if (!c) throw new Error('No channel evidence saved');
      return plain({
        chainId: String(this.expectedChainId),
        casino: this.config.contractAddress,
        operator: this.operator,
        opening: c.opening,
        evidence: plain(this.evidence(c)),
        claim: c.claim,
      });
    });
  }
  async importEvidence(bundle: any) {
    await this.exclusive(async () => {
      if (this.pending || this.transactionIntent)
        throw new Error('Recover the saved operation before importing another checkpoint');
      // A file that is JSON but not a bundle is answered here, before the protocol reads its parts.
      if (!bundle?.chainId || !bundle.casino || !bundle.operator || !bundle.opening || !bundle.evidence)
        throw new Error('That file is not a recovery bundle: it names no deployment, channel or evidence.');
      const checked = verifyEvidence(bundle);
      if (
        String(bundle.chainId) !== String(this.expectedChainId) ||
        !same(bundle.casino, this.config.contractAddress) ||
        !same(bundle.operator, this.operator) ||
        !same(bundle.opening.player, this.address)
      )
        throw new Error('Evidence belongs to a different wallet or deployment');
      const channelId = checked.state.channelId,
        old = this.channels[channelId!];
      if (old && BigInt(old.state.sequence) > BigInt(checked.state.sequence))
        throw new Error('Backup is older than the saved checkpoint');
      if (
        old &&
        BigInt(old.state.sequence) === BigInt(checked.state.sequence) &&
        !same(hashState(this.domain, old.state), hashState(this.domain, checked.state))
      )
        throw new Error('Conflicting checkpoint at the saved sequence');
      const registered = await this.reader.channels(channelId);
      if (
        !Number(registered.status) ||
        !same(registered.initialHash, hashState(this.domain, initialState(bundle.opening)))
      )
        throw new Error('Recovery opening is not registered on this contract');
      const evidence = bundle.evidence;
      this.channels[channelId] = {
        ...old,
        opening: bundle.opening,
        state: checked.state,
        playerSignature: Number(evidence.step.operation.kind) ? '0x' : evidence.playerSignature,
        casinoSignature: Number(evidence.step.operation.kind)
          ? evidence.step.casinoSignature
          : evidence.casinoSignature,
        lastResponse: Number(evidence.step.operation.kind) ? { evidence } : null,
        onchain: old?.onchain || { status: 0 },
      };
      if (old?.key && Number(evidence.step.operation.kind)) {
        this.channels[channelId].playerSignature = await this.channelSigner(this.channels[channelId]).signTypedData(
          this.domain,
          STATE_TYPES,
          checked.state,
        );
      }
      if (!this.channelId || this.channelId === channelId) this.channelId = channelId;
      await this.save();
    });
    await this.refresh();
  }
  destroy() {
    this.revision++; // Discard any optional reads still in flight.
    clearInterval(this.timer);
    this.provider?.destroy();
    this.witnessProvider?.destroy();
  }
}
