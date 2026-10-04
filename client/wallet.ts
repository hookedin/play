import type { JsonRpcProvider } from 'ethers';
import type { Store } from './storage.ts';
import type {
  Domain,
  Deployment,
  Checkpoint,
  Opening,
  Evidence,
  PlayerDeveloperBet,
  Quote,
  CollateralOffer,
} from '../protocol/types.ts';
import type { ChainBlock } from '../protocol/chain-observer.ts';
import type { GameSession } from '../protocol/game-types.ts';
import { Contract, Wallet, getAddress } from 'ethers';
import {
  domain,
  json,
  plain,
  same,
  MAX_JSON_BYTES,
  STATE_TYPES,
  ACCESS_TYPES,
  authorization,
  baseState,
  channelId,
  hashState,
  checkpointEvidence,
  verifyEvidence,
  verifyStep,
  hashOperation,
  KIND,
  FAUCET_ID,
  assertProtocol,
  owed,
  protection,
  withdrawalRecorded,
  disputedStep,
} from '../protocol/protocol.ts';
import {
  ChainObserver,
  createRpcProvider,
  requireIndependentRpc,
  requireCanonicalBlock,
} from '../protocol/chain-observer.ts';
import { mapBounded } from '../protocol/concurrency.ts';
import { BrowserStore, withLock } from './storage.ts';
import { saveAccounts, readAccounts } from './accounts.ts';
import { verifyDeployment } from '../protocol/deployment.ts';
import trustedArtifact from './contract-artifact.ts';
import { GameSessions } from './wallet-games.ts';
import { addressReceipt, inbound } from './wallet-transactions.ts';
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
  opening: Opening;
  state: Checkpoint;
  playerSignature: string;
  casinoSignature: string;
  onchain: any;
  claim?: any;
  observedAt?: number;
  lastResponse?: { evidence: Evidence } | null;
  /** The casino's quote for this channel's next casino bet, from its reply to the last operation or asked for. */
  quote?: Quote;
  pending?: any;
  /** Registered with the casino, which has the same state: play and deposits taken in need it. */
  registered?: boolean;
  /** A close without the casino this wallet started: nothing more is played on the channel. */
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
  /** The group whose bets the operation's result belongs to, while the game holds back what they won. */
  group?: string;
  /** What of the group's cash stays out of the operation and with the group. */
  kept?: string;
}
export const HISTORICAL_CHANNEL_BATCH = 16;
/** How often the wallet checks the chain and the casino by itself, in milliseconds: every 10 minutes, and every 20
 * seconds while the page shows the deposit address. An operation signs only on a check at most `CHECK_EVERY` old. */
export const CHECK_EVERY = 600_000,
  DEPOSIT_CHECK_EVERY = 20_000;
/** What the wallet keeps of an on-chain channel record. */
const CHANNEL_FIELDS = [
  'player',
  'deposited',
  'principal',
  'collateral',
  'claimed',
  'status',
  'deadline',
  'closingSequence',
  'closingHash',
  'closingBalance',
  'disputedPrize',
  'disputeHold',
];
const networks: Record<string, { id: bigint; name: string; stake: string }> = {
  sepolia: { id: 11155111n, name: 'Sepolia', stake: '1000000000000' },
  local: { id: 31337n, name: 'Anvil test chain', stake: '1000000000000000' },
};
/**
 * The independent wallet. Its concerns are layered as a class chain kept in their own files:
 * on-chain transactions (`wallet-transactions.ts`), the off-chain channel protocol
 * (`wallet-channel.ts`) and the open game's allowance (`wallet-games.ts`). This file owns
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
  declare developerBetError: string | null;
  /** What the last attempt to send the pending operation it names ran into: a casino that refuses an operation
   * refuses it the same way on every retry. */
  pendingError: { operationId: string; message: string; code?: string } | null = null;
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
  declare revision: number;
  declare transactionIntent: any;
  declare config: any;
  declare recoveryOnly: boolean;
  declare provider: JsonRpcProvider;
  declare witnessProvider: JsonRpcProvider | undefined;
  declare observer: ChainObserver;
  declare timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the page shows the deposit address, which the wallet then checks for ETH every 20 seconds. */
  declare depositShown: boolean;
  /** The deployment check: the contract's code and operator, read from two independent RPCs. */
  declare verified: Promise<unknown>;
  /** The deployment check, then the current account's first chain observation and casino reconciliation. */
  declare synced: Promise<void>;
  /** Every account this browser holds a key for. */
  declare savedAddresses: string[];
  /** This account's key: it signs everything on the account's channel, its address receives deposits, and a close
   * pays it. */
  declare signer: Wallet;
  declare address: string;
  declare contract: Contract;
  declare reader: Contract;
  declare storageKey: string;
  declare domain: Domain;
  declare lastChainCheck: number;
  /** The account's channel: what deposits, play, closes and recovery are about. */
  declare channelId: string | null;
  declare storageFailed: boolean | undefined;
  declare refreshing: Promise<any> | null;
  declare nativeBalance: string;
  /** What the address held at the wallet's last look, after its own last transaction: ETH beyond it has arrived since.
   * Null until the wallet has looked. */
  declare atAddress: string | null;
  declare missingChannel: string | null;
  declare detailsError: string | null;
  declare detailsRefreshing: Promise<Record<string, any>> | null;
  declare monitorCursor: number;
  declare detailsObservedAt: number;
  /** This account's uname, as the casino last reported it: permanent, and written `~uname`. */
  declare uname: string | null;
  /** The alias it is shown by instead, written `@alias`: the username of the X account it signed in with; null while it
   * is signed in with none. */
  declare alias: string | null;
  /** The public profile those names carry: when the casino first knew it, what it has played, whether its X account
   * had X Premium when it last signed in with X, and the games it publishes. Read from the public route, like anybody
   * else's. */
  declare profile: {
    uname: string;
    alias: string | null;
    since: number;
    stats: any;
    x: { premium: boolean; checked: number } | null;
    games: { name: string; url: string; key: string; developer: string }[];
  } | null;
  /** Whether the casino's faucet lends to this account, as the casino last told the account itself: no public profile
   * says it. */
  declare faucet: boolean;
  /** Whether ETH at this account's address goes into its balance. Off, it stays available for withdrawal and
   * transaction fees. */
  declare autoDeposit: boolean;
  /** What a deposit under way is adding to the balance, from this account's address; nothing between deposits. */
  depositing = 0n;
  /** The fee the last deposit was priced at: the sweep leaves alone an address holding less than twice it, since a
   * deposit of that would cost more than half of it. */
  depositFee = 0n;
  /** What the casino last said sending a withdrawal or a transfer to the contract costs. */
  withdrawalFee = 0n;
  /** The casino's offer of collateral the account asked to buy, until it is bought or expires: the sweep buys it with
   * ETH at the account's address before it adds anything to the balance. */
  buying: CollateralOffer | null = null;
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
      faucet: false,
      developerEarnings: null,
      busy: false,
      depositShown: false,
    });
    this.hydrate(undefined);
  }
  /** A local Anvil casino, which sends a wallet demo ETH: the casino says so, and it is refused anywhere else. */
  get isLocalDevelopment() {
    return this.network === 'local' && this.config?.isLocalDevelopment === true;
  }
  /** The casino's signing key: the contract's owner, as the deployment check read it. */
  get operator(): string {
    return this.config.operator;
  }
  validateConfiguredNetwork() {
    if (String(this.config?.chainId) !== String(this.expectedChainId))
      throw new Error(
        `This client requires ${this.networkName} (chain ${this.expectedChainId}). The casino reports chain ${this.config?.chainId ?? 'unknown'}.`,
      );
  }
  async assertNetwork() {
    this.validateConfiguredNetwork();
    // Read the current chain directly, then pin this same chain ID on the transaction.
    if (BigInt(await this.provider.send('eth_chainId', [])) !== this.expectedChainId)
      throw new Error(
        `Casino RPC must be on ${this.networkName} (chain ${this.expectedChainId}). No transaction was signed.`,
      );
  }
  /** Start on the deployment this wallet was built to trust. A casino that differs from it, or does not answer, leaves
   * the wallet in recovery mode. */
  async start() {
    const trusted = this.trustedDeployment;
    if (!trusted) throw new Error('This wallet names no deployment to trust');
    let advertised, serviceError;
    try {
      advertised = await this.api('/api/config');
      assertProtocol(advertised);
      if (
        String(advertised.chainId) !== String(this.expectedChainId) ||
        !same(advertised.contractAddress, trusted.contractAddress) ||
        !same(advertised.operator, trusted.operator)
      )
        throw new Error('Casino configuration differs from the trusted network, deployment or protocol');
    } catch (error: any) {
      serviceError = error.message;
    }
    this.config = { ...(serviceError ? {} : advertised), ...trusted, confirmations: this.network === 'local' ? 1 : 2 };
    this.recoveryOnly = Boolean(serviceError);
    this.validateConfiguredNetwork();
    this.provider = createRpcProvider(this.config.rpcUrl, this.expectedChainId);
    if (this.network !== 'local') {
      requireIndependentRpc(this.config.rpcUrl, this.config.witnessRpcUrl);
      this.witnessProvider = createRpcProvider(this.config.witnessRpcUrl, this.expectedChainId);
    }
    this.provider.pollingInterval = this.network === 'local' ? 100 : 3000;
    this.observer = new ChainObserver({
      provider: this.provider,
      witnessProvider: this.witnessProvider,
      chainId: this.expectedChainId,
      finality: this.config.confirmations,
    });
    // The wallet is ready as soon as its account is loaded; everything that touches ETH waits for this check, through
    // synced.
    this.verified = verifyDeployment({
      observer: this.observer,
      provider: this.provider,
      address: this.config.contractAddress,
      chainId: this.expectedChainId,
      expected: trusted,
    });
    this.verified.catch(() => {});
    const saved = await saveAccounts(this.storage, this.expectedChainId, { create: true });
    await this.useKey(saved.accounts[saved.selected!], { select: false });
    this.schedule();
    return this;
  }
  /** The single observation loop; the page only re-renders from wallet state. A hidden tab does not check. */
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.schedule();
        if (!this.busy && !globalThis.document?.hidden)
          void this.check().catch(error => console.error('Checking the chain and the casino failed', error));
      },
      this.depositShown ? DEPOSIT_CHECK_EVERY : CHECK_EVERY,
    );
    this.timer.unref?.();
  }
  /** Check the chain and the casino now: ETH at the address goes into the balance, and what is owed is collected. */
  async check() {
    await this.refresh();
    // Asked again if the casino did not answer, or had no profile to give before it registered the account's channel.
    if (!this.uname || (this.channel?.registered && !this.profile))
      await this.lookUpNames().catch(error => console.error('Looking up your name failed', error));
    await this.sweep().catch(error => console.error('Adding ETH to your balance failed', error));
    await this.collectPayouts();
  }
  /** The page shows the deposit address, or stops showing it. */
  showDeposit(shown: boolean) {
    if (shown === this.depositShown) return;
    this.depositShown = shown;
    if (this.timer) this.schedule();
  }
  /** Switch to the account of a key, saved in this browser from then on. Its saved state loads at once; its first
   * look at the chain and the casino follows the deployment check, in synced. */
  async useKey(privateKey: string, { select = true } = {}) {
    await this.synced?.catch(() => {});
    this.requireDurableState();
    if (this.busy || this.pending || this.transactionIntent)
      throw new Error('Recover the pending operation before changing wallets');
    const signer = new Wallet(privateKey, this.provider);
    this.busy = true;
    try {
      await this.refreshing?.catch(() => {});
      this.requireDurableState();
      const address = getAddress(signer.address);
      this.developerEarnings = null;
      const contract = new Contract(this.config.contractAddress, trustedArtifact.abi, signer);
      const reader = contract.connect(this.provider) as Contract;
      const storageKey =
        'wallet:' +
        this.expectedChainId +
        ':' +
        this.config.contractAddress.toLowerCase() +
        ':' +
        address.toLowerCase();
      const run = async () => {
        const saved = await saveAccounts(this.storage, this.expectedChainId, {
          privateKeys: [signer.privateKey],
          select,
        });
        this.savedAddresses = Object.keys(saved.accounts);
        Object.assign(this, {
          signer,
          address,
          contract,
          reader,
          storageKey,
          domain: domain(this.expectedChainId, this.config.contractAddress),
          lastChainCheck: 0,
          buying: null,
          uname: null,
          alias: null,
          profile: null,
          faucet: false,
        });
        this.hydrate(await this.storage.get(storageKey));
      };
      await withLock('hookedin:channel:' + storageKey, true, run);
    } finally {
      this.busy = false;
      this.render();
    }
    this.synced = this.sync();
    this.synced.catch(() => {});
  }
  /** The account's first look at the chain and its channel's at the casino, once the deployment check has passed.
   * Nothing else with ETH runs meanwhile: every such path waits for it. Its names come at once, before that check. */
  async sync() {
    const named = this.lookUpNames().catch(error => console.error('Looking up your name failed', error));
    await this.verified;
    await this.withChannelLock(true, async () => {
      await this.refreshLocked();
      if (this.channel?.registered) await this.activate().catch(() => {});
    });
    await named;
    this.render();
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
      autoDeposit: saved?.autoDeposit ?? true,
      atAddress: saved?.atAddress ?? null,
    });
  }
  get channel(): WalletChannel | null {
    return this.channels[this.channelId!] || null;
  }
  /** This account's newest channel whose close is under way. It no longer holds the account's balance, which the next
   * deposit opens a new channel for, but it may need a challenge, and it needs finishing. */
  get closingChannel(): WalletChannel | null {
    const closing = Object.values(this.channels).filter(c => Number(c.onchain?.status) === 2);
    return closing.sort((a, b) => Number(b.opening.index) - Number(a.opening.index))[0] || null;
  }
  /** What a closing channel's latest saved state is owed beyond what its close proposes: what a challenge would win. */
  atRisk(closing: WalletChannel) {
    try {
      const due = owed(closing.state, closing.onchain.deposited, closing.onchain.claimed);
      return due > BigInt(closing.onchain.closingBalance) ? due - BigInt(closing.onchain.closingBalance) : 0n;
    } catch {
      return 0n;
    }
  }
  /** Whether this account can play with ETH: its channel is registered, open and not closing. */
  get playable() {
    const c = this.channel;
    return Boolean(c?.registered) && Number(c!.onchain?.status) === 1 && !c!.closing;
  }
  get pending() {
    return this.channel?.pending || null;
  }
  set pending(value) {
    if (!this.channel) throw new Error('A pending operation requires a channel');
    this.channel.pending = value;
  }
  /** Whether this account's newest balance was closed, or is closing, by either side, and none is open since. */
  get forceClosed() {
    return !this.channel && Object.values(this.channels).some(c => c.claim || Number(c.onchain?.status) === 2);
  }
  /** Whether ETH at this account's address goes into its balance by itself: with the setting on, while the casino is
   * there and nothing is closing or in flight. A channel a reorganisation took back to unopened opens again with it.
   * After a close it waits for the player, who may want it elsewhere. */
  get sweeps() {
    const c = this.channel;
    return (
      this.autoDeposit &&
      !this.recoveryOnly &&
      !this.storageFailed &&
      !this.transactionIntent &&
      !this.missingChannel &&
      !(this.pending && !inbound(this.pending.kind)) &&
      (c ? Number(c.onchain?.status) <= 1 && !c.closing : !this.forceClosed) &&
      BigInt(this.nativeBalance || 0) > 2n * this.depositFee
    );
  }
  /** Turn on or off whether ETH that arrives at this account's address goes into its balance by itself. */
  async setAutoDeposit(on: boolean) {
    await this.exclusive(() => this.save(undefined, { autoDeposit: on }), { wait: true });
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
    // Past the newest 100, a receipt stays while more is to come of it: a developer bet not settled, and a withdrawal
    // not paid or returned.
    const open = (entry: any) =>
      outstanding.has(entry.operationId) || (entry.withdrawal && !entry.paid && !entry.returned);
    const history = receipt
      ? [receipt, ...this.history.filter(r => r.operationId !== receipt.operationId)]
          .sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''))
          .filter((entry, index) => index < 100 || open(entry))
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
        autoDeposit: this.autoDeposit,
        atAddress: this.atAddress,
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
  /** Ask the casino something for this account itself, signed for its first channel, which every account has whether
   * or not it was ever opened: its uname, signing in with X, and the faucet. */
  accountRequest(this: CasinoWallet, action: string, body: Record<string, unknown> = {}) {
    const opening = { channelId: channelId(this.address, 0), player: this.address, index: '0' };
    return this.api(`/api/channels/${opening.channelId}/${action}`, { opening, ...body });
  }
  /** Ask the casino for this account's uname: a uname is the account's before its first deposit. Its profile comes
   * with it once it has one, and whether the faucet lends to it. A profile already here came from a later reply, and
   * stays. */
  async lookUpNames(this: CasinoWallet) {
    if (this.recoveryOnly) return;
    const address = this.address;
    const { uname, profile } = await this.accountRequest('uname');
    if (this.address !== address || typeof uname !== 'string') return;
    this.faucet = Boolean(profile?.faucet);
    if (!this.profile) Object.assign(this, { uname, alias: profile?.alias ?? null, profile });
    this.render();
  }
  /** Every channel reply carries both names its player answers to, and a registered channel means the casino has met
   * the account, so its public profile exists. */
  noteNames(this: CasinoWallet, reply: { uname?: unknown; alias?: unknown }) {
    if (typeof reply?.uname !== 'string') return;
    const alias = typeof reply.alias === 'string' ? reply.alias : null;
    if (reply.uname === this.uname && alias === this.alias && this.profile) return;
    Object.assign(this, { uname: reply.uname, alias, profile: null });
    this.render();
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
  /** Start signing in with X: the page of X's to send the browser to. X sends it back to the wallet's `/x` page. */
  async signInWithX(this: CasinoWallet): Promise<string> {
    return (await this.accountRequest('x/start')).url;
  }
  /** Finish signing in with X, with what X sent the browser back with: this account is shown by the X account's
   * username from then on, and its profile says whether that account has X Premium. */
  async finishSignInWithX(this: CasinoWallet, state: string, code: string) {
    return this.takeProfile(await this.accountRequest('x/finish', { state, code }));
  }
  /** Sign out of X: this account is shown by its uname again, and the faucet lends to it no more. */
  async signOutOfX(this: CasinoWallet) {
    return this.takeProfile(await this.accountRequest('x/sign-out'));
  }
  /** This account's profile as the casino answers the account itself with it, the names it shows and whether the faucet
   * lends to it. */
  takeProfile(this: CasinoWallet, profile: any) {
    Object.assign(this, { profile, uname: profile.uname, alias: profile.alias, faucet: Boolean(profile.faucet) });
    this.render();
    return profile;
  }
  /** Borrow free µETH from the casino's faucet, which lends to an account it tells it lends to (`faucet`), whose balance
   * holds less than it lends: signing in with X Premium lets an account borrow, and the casino lets any, or stops it. A loan that names the faucet: bets stake it, and a withdrawal, a transfer or a close pays it
   * back first. The faucet opens the account's channel first, if it is not open, with a deposit of nothing, and this
   * waits until the wallet has registered it. */
  async borrowFromFaucet(this: CasinoWallet) {
    const { amount, opening } = await this.accountRequest('faucet');
    if (!this.playable) {
      if (opening) this.onProgress('Opening your balance…');
      for (const until = Date.now() + 180_000; !this.playable; await this.refresh()) {
        if (Date.now() > until) throw new Error('Your balance has not opened yet. Try again in a minute.');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    return this.perform('faucet', { amount, source: FAUCET_ID }, crypto.randomUUID());
  }
  /**
   * Publish a game under this account, its developer, or, with no URL, take it out of the profile. Publishing
   * claims a public name and asks for an open channel; taking your own game down only has to be you, so a
   * developer who has closed their channel can still withdraw a game that turned out to be broken.
   */
  async publishGame(this: CasinoWallet, name: string, url: string | null) {
    // Publishing speaks from the open channel. Taking a game down speaks from any channel of this account,
    // including one already closed, because a broken game has to come down whether or not its developer still has
    // money at stake.
    const c = url ? this.channel : (this.channel ?? Object.values(this.channels).find(row => row.registered));
    if (!c?.registered) throw new Error('This account has no channel to publish from');
    if (url && Number(c.onchain?.status) !== 1) throw new Error('Open a balance to publish games');
    return this.takeProfile(await this.api(`/api/channels/${c.state.channelId}/games`, { name: name.trim(), url }));
  }
  /** The withdrawals the contract owes from the channel `c`, in the order it records them, each with the deposits its
   * checkpoint took in: those this browser made, from their proofs, and any made on another device, whose proof is not
   * here, taken to draw on every deposit. */
  owing(c: WalletChannel) {
    const proven = this.history
        .map(entry => entry.withdrawal && entry.proof)
        .filter(
          proof =>
            proof &&
            same(proof.step.operation.channelId, c.state.channelId) &&
            !withdrawalRecorded(c.onchain.claimed, proof),
        )
        .sort((a, b) => (BigInt(a.base.withdrawn) < BigInt(b.base.withdrawn) ? -1 : 1))
        .map(proof => ({ amount: proof.step.operation.amount, deposited: proof.base.deposited })),
      unproven =
        BigInt(c.state.withdrawn) - BigInt(c.onchain.claimed) - proven.reduce((n, w) => n + BigInt(w.amount), 0n);
    return unproven > 0n ? [{ amount: unproven, deposited: c.onchain.deposited }, ...proven] : proven;
  }
  render() {
    const c = this.channel,
      closing = this.closingChannel,
      open = c && Number(c.onchain?.status) === 1,
      // Deposited into the open channel and not taken into its balance yet: the player's all the same.
      arriving = open ? BigInt(c.onchain.deposited) - BigInt(c.state.deposited) : 0n,
      balance = open ? BigInt(c.state.balance) + (arriving > 0n ? arriving : 0n) : 0n;
    this.publicState = {
      address: this.address,
      balance: String(balance),
      arriving: String(arriving > 0n ? arriving : 0n),
      nativeBalance: this.nativeBalance || '0',
      channelId: c?.state.channelId || null,
      channelStatus: c?.onchain?.status || '0',
      // What the casino lent the balance, which a withdrawal, a transfer or a close pays back first, and what a
      // withdrawal can take.
      loan: open ? c.state.loan : '0',
      withdrawable: String(this.withdrawable()),
      // The deposits the contract still holds for this balance, and the collateral locked into it.
      principal: open ? c.onchain.principal : '0',
      collateral: open ? c.onchain.collateral : '0',
      // What protects the balance once the contract has recorded the withdrawals it owes.
      protection: open ? plain(protection(c.state, c.onchain, this.owing(c))) : null,
      // What collateral costs at the casino, in millionths of the amount; none while the casino offers none.
      collateralRate: this.recoveryOnly ? null : (this.config?.collateralRate ?? null),
      // The collateral offer waiting for ETH at the address.
      buying: this.buying && plain(this.buying.message),
      observedAt: this.lastChainCheck || 0,
      savedSequence: c?.state.sequence || '0',
      // The channel whose close is under way, beside the open one.
      closingChannelId: closing?.state.channelId || null,
      deadline: closing?.onchain.deadline || '0',
      closingSequence: closing?.onchain.closingSequence || '0',
      closingSaved: closing?.state.sequence || '0',
      challengePending: ['challengeClose', 'dispute'].includes(this.transactionIntent?.method),
      // What the latest saved state is owed beyond what the close proposes.
      balanceAtRisk: closing ? String(this.atRisk(closing)) : '0',
      // A close that stops short of a casino bet its quote covers is challenged by disputing the bet.
      challengeDisputes: Boolean(closing && this.disputesClose(closing)),
      needsChallenge: Boolean(
        closing &&
        (BigInt(closing.state.sequence) > BigInt(closing.onchain.closingSequence) || this.disputesClose(closing)),
      ),
      // The prize of the casino bet the close disputes, until the casino settles it: 0 with none.
      disputedPrize: closing?.onchain.disputedPrize || '0',
      // The house cash the dispute locked into the close's collateral, until the casino settles the bet: 0 with none.
      disputeHold: closing?.onchain.disputeHold || '0',
      // What the contract still owes: closed balances, under their channels, and withdrawals it has not paid in full.
      claims: [
        ...Object.values(this.channels)
          .filter(v => v.claim)
          .map(v => ({
            id: v.state.channelId,
            channelId: v.state.channelId,
            to: v.claim.recipient,
            observedAt: v.observedAt,
            ...v.claim,
          })),
        // A transfer's claim is the account's it went to.
        ...this.history
          .filter(entry => entry.withdrawal && entry.recorded && !entry.paid && entry.kind !== 'transfer')
          .map(entry => ({
            id: entry.withdrawal,
            to: entry.to,
            amount: entry.amount,
            paid: String(BigInt(entry.amount) - BigInt(entry.owed)),
            winningsRemaining: entry.winningsRemaining,
            collectable: entry.collectable,
          })),
      ],
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
    await this.synced;
    this.requireDurableState();
    if (this.busy) return this.publicState;
    if (this.refreshing) {
      await this.refreshing;
      return this.publicState;
    }
    await this.refreshUnder(async () => {
      try {
        await this.refreshLocked({ channelId });
      } catch (error) {
        this.lastChainCheck = 0;
        throw error;
      }
    });
    void this.refreshDetails();
    return this.publicState;
  }
  /** Run `fn` holding the channel lock, unless another tab has it, as this wallet's one refresh: an action waits for it. */
  async refreshUnder(fn: () => Promise<void>) {
    const pending = this.withChannelLock(false, async held => {
      if (held) await fn();
    });
    this.refreshing = pending;
    try {
      await pending;
    } finally {
      if (this.refreshing === pending) this.refreshing = null;
    }
  }
  async observeChannels(keys: string[], block: ChainBlock): Promise<[string, any, any][]> {
    return mapBounded(keys, async key => {
      const value = await this.observer.contractRead(this.reader, 'channels', [key], block);
      const onchain = plain(Object.fromEntries(CHANNEL_FIELDS.map(field => [field, value[field]])));
      let claim = null;
      if (Number(value.status) === 3) {
        const [terms, collectable] = await Promise.all([
          this.observer.contractRead(this.reader, 'claims', [key], block),
          this.observer.contractRead(this.reader, 'collectable', [key], block),
        ]);
        // The claim is for what the close was owed, on the checkpoint it finalized.
        const remaining = BigInt(terms.protectedRemaining) + BigInt(terms.winningsRemaining);
        claim = plain({
          beneficiary: terms.beneficiary,
          recipient: terms.recipient,
          stateHash: onchain.closingHash,
          amount: onchain.closingBalance,
          paid: BigInt(onchain.closingBalance) - remaining,
          protectedRemaining: terms.protectedRemaining,
          winningsRemaining: terms.winningsRemaining,
          collectable,
        });
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
    const [native, index] = await Promise.all([
      this.observer.balance(this.address, observation.block),
      this.observer.contractRead(this.reader, 'channelIndex', [this.address], observation.block),
    ]);
    // The account's current channel: its first, or the one after the last whose close started.
    const current = channelId(this.address, index);
    // Only current recovery state belongs inside the action lock: the current channel, the one before it, whose close
    // may be under way, and any known to be closing.
    const previous = BigInt(index) > 0n ? channelId(this.address, BigInt(index) - 1n) : null,
      closing = Object.keys(this.channels).filter(key => Number(this.channels[key].onchain?.status) === 2);
    const selected = [...new Set([current, this.channelId, also, previous, ...closing])].filter(
      key => key && (key === current || this.channels[key]),
    ) as string[];
    const before = this.durable();
    const records = await this.observeChannels(selected, observation.block);
    await this.observer.accept(observation);
    this.nativeBalance = String(native);
    this.lastChainCheck = Date.now();
    const at = new Date().toISOString(),
      seen: any[] = [];
    // ETH sent to the address since the last look. A transaction of this wallet's in flight moves what it holds: the
    // wallet looks again once it is recorded.
    if (!this.transactionIntent) {
      if (this.atAddress !== null && native > BigInt(this.atAddress))
        seen.push(addressReceipt(native - BigInt(this.atAddress), at));
      this.atAddress = String(native);
    }
    const onchain = records.find(([key]) => key === current)![1];
    // Opened by this wallet's deposit or by anybody else's, the channel is this account's to sign for: taken up at
    // its base, and registered with the casino below.
    if (!this.channels[current] && Number(onchain.status) === 1) {
      this.channels[current] = {
        opening: { channelId: current, player: this.address, index: String(index) },
        state: baseState(current),
        playerSignature: '0x',
        casinoSignature: '0x',
        onchain,
      };
      seen.push({
        kind: 'opened',
        operationId: 'opened:' + current,
        channelId: current,
        amount: onchain.deposited,
        status: 'confirmed',
        createdAt: at,
      });
    }
    this.history = [...seen, ...this.history];
    this.applyChannelObservations(records.filter(([key]) => this.channels[key]));
    this.channelId = this.channels[current] ? current : null;
    const c = this.channel;
    await this.saveChanges(before);
    if (c && !c.registered && Number(c.onchain.status) === 1 && !this.recoveryOnly)
      await this.activate().catch(error => console.error('Registering your balance failed', error));
    return this.publicState;
  }
  /** The record contents that warrant a new durable revision; observation times are display only. */
  durable() {
    return json([
      this.channelId,
      this.transactionIntent,
      this.history,
      this.atAddress,
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
    // Only this short commit joins the action lock. Merge into the latest
    // durable record so unrelated active-channel refreshes cannot starve history.
    const commit = async (apply: () => void) => {
      while (this.refreshing) await this.refreshing.catch(() => {});
      if (!current() || this.busy || this.storageFailed) return;
      await this.refreshUnder(async () => {
        if (!current() || this.busy || this.storageFailed) return;
        const before = this.durable();
        apply();
        await this.saveChanges(before);
      });
    };
    // Channels this account closed before, and the transactions its activity lists: read a few at a time.
    this.detailsRefreshing = (async () => {
      try {
        const observation = await observer.observe();
        if (!current()) return this.publicState;
        const keys = Object.keys(this.channels).filter(
          key => key !== this.channelId && Number(this.channels[key].onchain?.status) !== 2,
        );
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
          (await this.observeTransactionHistory(observation.block, history)).map(entry => [entry.operationId, entry]),
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
        if (current()) this.detailsError = null;
      } catch (error: any) {
        if (current()) this.detailsError = error.message;
      }
      this.render();
      return this.publicState;
    })().finally(() => {
      this.detailsRefreshing = null;
    });
    return this.detailsRefreshing;
  }
  async exclusive<T>(fn: () => T | Promise<T>, { wait = false } = {}) {
    await this.synced;
    // Waiting takes the wallet as soon as it is free: whoever else was waiting may have taken it first.
    while (wait && this.busy && this.actionDone) await this.actionDone;
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
  /** Refuses unless this wallet may sign on its channel now. A check older than `CHECK_EVERY` is made again first,
   * under the channel lock the caller holds. */
  async ready() {
    this.requireDurableState();
    this.requireService();
    if (!this.lastChainCheck || Date.now() - this.lastChainCheck > CHECK_EVERY) await this.refreshLocked();
    if (!this.playable) throw new Error('Open or recover a channel before playing');
  }
  /** A request to the casino. One under `/api/channels/:id` carries that channel's access token. */
  async api(path: string, body: unknown = undefined) {
    if (body !== undefined) this.requireDurableState();
    if (path !== '/api/config') this.requireService();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const channel = /^\/api\/channels\/(0x[0-9a-fA-F]{64})/.exec(path)?.[1];
    if (channel) {
      const now = Math.floor(Date.now() / 1000);
      let token = this.tokens.get(channel);
      // A token is signed for a minute and used while it has twenty seconds left, room for a slow request.
      if (!token || token.expiresAt - now < 20) {
        const message = { channelId: channel, expiresAt: now + 60 };
        token = {
          expiresAt: message.expiresAt,
          header: authorization(message, await this.signer.signTypedData(this.domain, ACCESS_TYPES, message)),
        };
        this.tokens.set(channel, token);
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
  async importKey(privateKey: string) {
    await this.useKey(privateKey.trim());
  }
  async selectSavedAccount(address: string) {
    const saved = await readAccounts(this.storage, this.expectedChainId);
    const key = saved.accounts[getAddress(address)];
    if (!key) throw new Error('This browser holds no key for that address');
    await this.importKey(key);
  }
  requireService() {
    if (this.recoveryOnly)
      throw new Error(
        'Recovery mode: casino unavailable or incompatible. Saved evidence and on-chain settlement remain available; reload to reconnect',
      );
  }
  exportKey() {
    return this.signer.privateKey;
  }
  async recover() {
    const result = await this.exclusive(async () => {
      if (this.transactionIntent) await this.recoverTransaction();
      // The casino says first where the channel is: it may hold the reply this wallet lost, or play from another device.
      const answer = this.channel ? await this.activate() : undefined;
      return this.pending?.request && this.channel?.registered ? this.resume() : answer;
    });
    // A verified stored result is recoverable even while new play is paused.
    if (result?.verified)
      await this.refresh().catch(() => {
        this.lastChainCheck = 0;
      });
    else await this.refresh();
    return result;
  }
  /** Whether `state` is older than the saved one, or another state at its sequence. */
  behind(saved: Checkpoint, state: Checkpoint) {
    const difference = BigInt(saved.sequence) - BigInt(state.sequence);
    return difference > 0n || (!difference && !same(hashState(this.domain, saved), hashState(this.domain, state)));
  }
  evidence(channel = this.channel!) {
    if (channel.playerSignature && channel.playerSignature !== '0x')
      return checkpointEvidence(channel.state, channel.playerSignature, channel.casinoSignature);
    return channel.lastResponse?.evidence || checkpointEvidence(channel.state);
  }
  /** The evidence that disputes the channel's pending casino bet: its saved checkpoint, and the bet with its seed. */
  disputeEvidence(channel = this.channel!) {
    const { request, signature, seed } = channel.pending;
    return { ...this.evidence(channel), step: disputedStep(request, signature, seed) };
  }
  /** Whether a close of `channel` under way stops short of its pending casino bet, which its quote still covers. */
  disputesClose(channel: WalletChannel) {
    return (
      this.disputable(channel) && BigInt(channel.pending.request.sequence) > BigInt(channel.onchain.closingSequence)
    );
  }
  async withSavedRecord<T>(read: (record: any) => T | Promise<T>) {
    if (this.busy) throw new Error('Wait for the current wallet operation');
    this.busy = true;
    try {
      await this.refreshing?.catch(() => {});
      return await withLock('hookedin:channel:' + this.storageKey, true, async () => {
        const record = await this.storage.get(this.storageKey);
        if (!record) throw new Error('No wallet record saved');
        return read(record);
      });
    } finally {
      this.busy = false;
      this.render();
    }
  }
  async exportEvidence(channelId?: string | null) {
    return this.withSavedRecord(async record => {
      const c = record.channels[channelId ?? record.channelId ?? this.closingChannel?.state.channelId];
      if (!c) throw new Error('No channel evidence saved');
      return plain({
        chainId: String(this.expectedChainId),
        casino: this.config.contractAddress,
        operator: this.operator,
        opening: c.opening,
        evidence: plain(this.evidence(c)),
        // The proofs of the account's withdrawals the contract may still owe something: each is collected under the
        // hash of its operation.
        withdrawals: record.history
          .filter((entry: any) => entry.withdrawal && !entry.paid && !entry.returned)
          .map((entry: any) => entry.proof),
        // A casino bet the casino has not settled, which a watchtower disputes before its quote expires.
        ...(this.disputable(c) ? { dispute: { step: this.disputeEvidence(c).step, quote: c.pending.quote } } : {}),
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
      if (old && this.behind(old.state, checked.state))
        throw new Error('The evidence is older than the saved checkpoint, or conflicts with it');
      const registered = await this.reader.channels(channelId);
      if (!Number(registered.status) || !same(registered.player, this.address))
        throw new Error('Recovery evidence is not for a channel of this account on this contract');
      // The bundle's withdrawals join the activity as ones this wallet sent do, whatever the chain says of them now: it
      // says how each stands from here on. Each must be this account's operation, followed by the casino's signature.
      const known = new Set(this.history.map(entry => entry.withdrawal)),
        withdrawals = [];
      for (const proof of bundle.withdrawals ?? []) {
        const op = proof.step.operation;
        let next;
        try {
          if (![KIND.withdrawal, KIND.transfer].includes(Number(op.kind) as 5)) throw new Error('Not a withdrawal');
          next = verifyStep(this.domain, proof.base, proof.step, this.address, this.operator);
        } catch {
          throw new Error('The bundle names a withdrawal that is not one this account and the casino signed');
        }
        const id = hashOperation(this.domain, op).toLowerCase();
        if (known.has(id)) continue;
        known.add(id);
        withdrawals.push(
          plain({
            kind:
              Number(op.kind) === KIND.withdrawal
                ? 'withdrawal'
                : same(op.recipient, this.address)
                  ? 'lock-in'
                  : 'transfer',
            operationId: 'withdrawal:' + id,
            status: 'signed',
            verified: true,
            proof,
            stake: op.amount,
            amount: op.amount,
            withdrawal: id,
            to: this.destination(op),
            fee: op.fee,
            paid: false,
            balance: next.balance,
            createdAt: new Date().toISOString(),
          }),
        );
      }
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
      if (Number(evidence.step.operation.kind))
        this.channels[channelId].playerSignature = await this.signer.signTypedData(
          this.domain,
          STATE_TYPES,
          checked.state,
        );
      if (!this.channelId || this.channelId === channelId) this.channelId = channelId;
      this.history = [...withdrawals, ...this.history];
      await this.save();
    });
    await this.refresh();
  }
  destroy() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.provider?.destroy();
    this.witnessProvider?.destroy();
  }
}
