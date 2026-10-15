import type { JsonRpcProvider } from 'ethers';
import type { Store } from './storage.ts';
import type {
  Carried,
  Domain,
  Deployment,
  Checkpoint,
  Details,
  Opening,
  Evidence,
  EvidenceBundle,
  OnchainChannel,
  Operation,
  PlayerDeveloperBet,
  Quote,
  CollateralOffer,
  SignedStatement,
} from '../protocol/types.ts';
import type { ChainBlock } from '../protocol/chain-observer.ts';
import type { GameAllowance, GameIdentity, GameSession } from '../protocol/game-types.ts';
import { Contract, Wallet, getAddress } from 'ethers';
import * as read from '../protocol/read.ts';
import {
  domain,
  json,
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
  assertProtocol,
  owed,
  protection,
  withdrawalRecorded,
  disputedStep,
  STATUS,
  playsOn,
  assertSignature,
  HEAD_TYPES,
  onchainChannel,
  fold,
  RECORD_ID,
  canonical,
} from '../protocol/protocol.ts';
import * as readers from './readers.ts';
import type { Profile, Redeem } from './readers.ts';
import {
  ChainObserver,
  createRpcProvider,
  requireIndependentRpc,
  requireCanonicalBlock,
} from '../protocol/chain-observer.ts';
import { mapBounded } from '../protocol/concurrency.ts';
import { BrowserStore } from './storage.ts';
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
  onGameReceipt?: (game: GameIntent, receipt: Receipt) => void;
  /** What the open game may stake has changed: what `game.allowance` answers it now, without a group. */
  onGameAllowance?: (game: GameIdentity, allowance: GameAllowance) => void;
  storage?: Store;
  trustedDeployment?: Deployment | null;
}
/** What a finalized channel's close is still owed, under its channel's ID, as the contract holds the claim. */
export interface Claim {
  beneficiary: string;
  recipient: string;
  stateHash: string;
  amount: bigint;
  paid: bigint;
  protectedRemaining: bigint;
  winningsRemaining: bigint;
  collectable: bigint;
}
/** An operation this wallet signed and saved, until the casino's verified answer completes it: what it is, the request
 * and what it means, the signature, and for a casino bet its quote covers, the seed and the quote. */
export interface PendingOperation {
  kind: string;
  operationId: string;
  request: Operation;
  details: Details;
  signature: string;
  game?: GameIntent;
  seed?: string;
  quote?: Quote;
  /** The name a transfer's other player or a game's bank went by, as the receipt shows it. */
  name?: string;
  /** The account's signature of the casino's proposed rejection, and why the casino declined. */
  rejectionSignature?: string;
  rejection?: { reason: string; used?: true; carried?: Carried };
}
export interface WalletChannel {
  opening: Opening;
  state: Checkpoint;
  playerSignature: string;
  casinoSignature: string;
  /** The channel as the contract holds it, at the last look; null for one imported and not looked at yet. */
  onchain: OnchainChannel | null;
  claim?: Claim | null;
  observedAt?: number;
  lastResponse?: { evidence: Evidence } | null;
  /** The casino's quote for this channel's next casino bet, from its reply to the last operation or asked for. */
  quote?: Quote;
  pending?: PendingOperation | null;
  /** Registered with the casino, which has the same state: play and deposits taken in need it. */
  registered?: boolean;
  /** A close without the casino this wallet started: nothing more is played on the channel. */
  closing?: boolean;
}
/** One entry of the wallet's activity: the receipt of an operation it signed, a transaction it sent, or ETH that
 * arrived at its address. Every amount in it is a bigint. */
export interface Receipt {
  kind: string;
  operationId: string;
  status: string;
  createdAt: string;
  amount?: bigint;
  stake?: bigint;
  payout?: bigint;
  outcome?: bigint;
  maxPayout?: bigint;
  expectedPayout?: bigint;
  commission?: bigint;
  balance?: bigint;
  fee?: bigint;
  shares?: bigint;
  holding?: bigint;
  owed?: bigint;
  winningsRemaining?: bigint;
  collectable?: bigint;
  collateral?: bigint;
  kept?: bigint;
  /** A step that drew no bet: the seed the wallet drew it with, which a bet's proof holds for one that did. */
  seed?: string;
  [field: string]: any;
}
/** A transaction this account signed, saved before it is broadcast: what it calls, its value and fees, and the signed
 * transaction itself. */
export interface TransactionIntent {
  method: string;
  args: unknown[];
  value: bigint;
  nonce: number;
  to: string;
  data: string;
  fees: Fees;
  /** A deposit of everything the address held. */
  whole?: boolean;
  raw: string;
  hash: string;
  /** Every transaction sent for it, a speed-up's included. */
  attempts?: string[];
}
/** A transaction's gas limit and fee caps, as the wallet prices and pins them. */
export interface Fees {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  type?: number;
}
/** What the wallet shows of itself, worked out from its state on every render. */
export interface PublicState {
  address: string;
  /** The signed balance, with what was deposited into the channel and not taken in yet. */
  balance: bigint;
  arriving: bigint;
  nativeBalance: bigint;
  channelId: string | null;
  channelStatus: bigint;
  withdrawable: bigint;
  principal: bigint;
  collateral: bigint;
  protection: ReturnType<typeof protection> | null;
  collateralRate: bigint | null;
  buying: CollateralOffer['message'] | null;
  observedAt: number;
  savedSequence: bigint;
  closingChannelId: string | null;
  deadline: bigint;
  closingSequence: bigint;
  closingSaved: bigint;
  challengePending: boolean;
  balanceAtRisk: bigint;
  challengeDisputes: boolean;
  needsChallenge: boolean;
  disputedPrize: bigint;
  disputeHold: bigint;
  claims: {
    id: string;
    channelId?: string;
    to: string;
    amount: bigint;
    paid: bigint;
    winningsRemaining: bigint;
    collectable: bigint;
    observedAt?: number;
  }[];
}
/** The game an operation belongs to, saved with the pending request so a reload can attribute its receipt. */
export interface GameIntent {
  /** The game's ID. */
  id: string;
  /** The game's own name for the operation, by which it asks for the receipt. */
  operation: string;
  /** The game's own name, so a receipt still says where the money went long after the game is closed. */
  name: string;
  /** The game's developer, whose bank takes its developer bets and whose key signs their settlements. */
  developer: string;
  /** The group whose bets the operation's result belongs to, while the game holds back what they won. */
  group?: string;
  /** What of the group's cash stays out of the operation and with the group. */
  kept?: bigint;
}
export const HISTORICAL_CHANNEL_BATCH = 16;
/** How often the wallet checks the chain and the casino by itself, in milliseconds: every 10 minutes, and every 20
 * seconds while the page shows the deposit address. An operation signs only on a check at most `CHECK_EVERY` old. */
export const CHECK_EVERY = 600_000,
  DEPOSIT_CHECK_EVERY = 20_000;
const networks: Record<string, { id: bigint; name: string; stake: bigint }> = {
  mainnet: { id: 1n, name: 'Ethereum', stake: 1000000000000n },
  local: { id: 31337n, name: 'Anvil test chain', stake: 1000000000000000n },
};
/** The account's names and profile, as `POST /api/account/uname` answers: whether the casino registers its current
 * channel before any deposit comes with them. */
const unameReply = read.object<{ uname: string; profile: Profile; registers: boolean }>({
  uname: read.uname,
  profile: readers.profile,
  registers: read.flag,
});
/** Whether a wallet record this browser saved is in its one form: every checkpoint as it was signed, and every amount
 * and sequence a bigint. */
const readable = (saved: any) =>
  saved.schema === 'HOOKEDIN/WALLET-STATE/1' &&
  Object.values(saved.channels ?? {}).every(
    (c: any) => typeof c?.opening?.index === 'bigint' && canonical(STATE_TYPES, c.state),
  ) &&
  (saved.fund === undefined || (typeof saved.fund.sequence === 'bigint' && typeof saved.fund.shares === 'bigint')) &&
  (saved.atAddress == null || typeof saved.atAddress === 'bigint') &&
  (saved.transactionIntent == null || typeof saved.transactionIntent.value === 'bigint');
/** Whether the player `profile` describes answers to `name`, `~uname` or `@username`, as the casino reads names. */
export const answersTo = (profile: Profile, name: string) =>
  name.startsWith('~')
    ? profile.uname === fold(name.slice(1))
    : profile.discordUsername !== null && fold(profile.discordUsername) === fold(name.slice(1));
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
  declare recommendedStake: bigint;
  declare onChange: (wallet: CasinoWallet) => void;
  declare onProgress: (message: string) => void;
  declare onGameReceipt: (game: GameIntent, receipt: Receipt) => void;
  declare onGameAllowance: (game: GameIdentity, allowance: GameAllowance) => void;
  declare storage: Store;
  declare trustedDeployment: Deployment | null;
  declare publicState: Partial<PublicState>;
  declare history: Receipt[];
  /** This account's bankroll shares: the casino's latest signed statement, and redeemed money not yet collected. */
  declare fund: {
    sequence: bigint;
    shares: bigint;
    statement: SignedStatement | null;
    redeeming?: { message: Redeem; signature: string } | null;
    owed?: bigint[];
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
  /** The newest head of the casino's signing history it signed that this wallet holds, which every check holds the
   * history to, and what that check found when the history has lost or changed it. */
  declare head: SignedStatement | null;
  declare historyAlert: string | null;
  /** A newer head the casino signed since, which takes the held head's place once the check finds that one intact. */
  declare nextHead: SignedStatement | null;
  /** What the last attempt to send the pending operation it names ran into: a casino that refuses an operation
   * refuses it the same way on every retry. */
  pendingError: { operationId: string; message: string; code?: string } | null = null;
  /** The banks of this account's games that it has put money into or taken money out of, by the game's ID: the game's
   * name, the casino's statement for the latest deposit or withdrawal, a withdrawal signed and not yet answered, and
   * withdrawn money not yet collected. */
  declare banks: Record<
    string,
    {
      name?: string;
      statement?: SignedStatement;
      withdrawing?: { message: { game: string; amount: bigint; sequence: bigint }; signature: string } | null;
      owed?: bigint[];
    }
  >;
  declare channels: Record<string, WalletChannel>;
  declare busy: boolean;
  declare transactionIntent: TransactionIntent | null;
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
  /** Every account this browser holds a key for, once the wallet has started. */
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
  declare nativeBalance: bigint;
  /** What the address held at the wallet's last look, after its own last transaction: ETH beyond it has arrived since.
   * Null until the wallet has looked. */
  declare atAddress: bigint | null;
  declare missingChannel: string | null;
  declare detailsError: string | null;
  declare detailsRefreshing: Promise<Record<string, any>> | null;
  declare monitorCursor: number;
  declare detailsObservedAt: number;
  /** This account's uname, as the casino last reported it: permanent, and written `~uname`. */
  declare uname: string | null;
  /** Whether the casino registers this account's current channel before the chain holds a deposit for it, as it last
   * said: it owes the account something, such as a transfer, or registered it already, from this device or another. */
  declare registers: boolean;
  /** The Discord username it is shown by instead, written `@bob`: the username of the Discord account it verified; null
   * while it has verified none. */
  declare discordUsername: string | null;
  /** The public profile those names carry: what it has played, and the games it publishes. Read from the public route,
   * like anybody else's. */
  declare profile: Profile | null;
  /** Whether ETH at this account's address goes into its balance. Off, it stays available for withdrawal and
   * transaction fees. */
  declare autoDeposit: boolean;
  /** What a deposit under way is adding to the balance, from this account's address; nothing between deposits. */
  depositing = 0n;
  /** The fee the last deposit was priced at: the sweep leaves alone an address holding less than twice it, since a
   * deposit of that would cost more than half of it. */
  depositFee = 0n;
  /** What the casino last said sending a withdrawal or a lock-in to the contract costs. */
  withdrawalFee = 0n;
  /** The casino's offer of collateral the account asked to buy, until it is bought or expires: the sweep buys it with
   * ETH at the account's address before it adds anything to the balance. */
  buying: CollateralOffer | null = null;
  /** Each account's signed `Access` token while it has time left: one signature serves a minute of requests. */
  tokens = new Map<string, { expiresAt: number; header: string }>();
  declare actionDone: Promise<void> | undefined;
  declare game: GameSession | null;
  constructor({
    casinoURL = 'http://127.0.0.1:4183',
    network = 'mainnet',
    onChange = () => {},
    onProgress = () => {},
    onGameReceipt = () => {},
    onGameAllowance = () => {},
    storage = new BrowserStore(),
    trustedDeployment = null,
  }: WalletOptions = {}) {
    super();
    const n = networks[network];
    if (!n) throw new Error('Only Ethereum and explicit local Anvil are supported');
    Object.assign(this, {
      casinoURL,
      network,
      expectedChainId: n.id,
      networkName: n.name,
      recommendedStake: n.stake,
      onChange,
      onProgress,
      onGameReceipt,
      onGameAllowance,
      storage,
      trustedDeployment,
      publicState: {},
      uname: null,
      registers: false,
      discordUsername: null,
      profile: null,
      busy: false,
      depositShown: false,
      historyAlert: null,
      nextHead: null,
      nativeBalance: 0n,
    });
    this.hydrate(undefined);
  }
  /** A started wallet with no account in this browser: its player has not created one or signed in. */
  get guest() {
    return this.savedAddresses?.length === 0;
  }
  /** A local Anvil casino, which sends a wallet demo ETH: the casino says so, and it is refused anywhere else. */
  get isLocalDevelopment() {
    return this.network === 'local' && this.config?.isLocalDevelopment === true;
  }
  /** The casino's signing key: the contract's signer, as the deployment check read it. */
  get operator(): string {
    return this.config.operator;
  }
  validateConfiguredNetwork() {
    if (this.config?.chainId !== this.expectedChainId)
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
  /** Whether `url` is a page the wallet may send a player to: https, or http on a local development network. */
  link(url: unknown) {
    try {
      const { protocol } = new URL(url as string);
      return typeof url === 'string' && (protocol === 'https:' || (protocol === 'http:' && this.network === 'local'));
    } catch {
      return false;
    }
  }
  /** Start on the deployment this wallet was built to trust. A casino that differs from it, or does not answer, leaves
   * the wallet in recovery mode. */
  async start() {
    const trusted = this.trustedDeployment;
    if (!trusted) throw new Error('This wallet names no deployment to trust');
    let casino, serviceError;
    try {
      const advertised = await this.api('/api/config');
      assertProtocol(advertised);
      if (
        read.whole(advertised.chainId) !== this.expectedChainId ||
        !same(advertised.contractAddress, trusted.contractAddress) ||
        !same(advertised.operator, trusted.operator)
      )
        throw new Error('Casino configuration differs from the trusted network, deployment or protocol');
      // What the wallet takes of the rest, each in its one form: what collateral costs and what of a deposit's network
      // fee the casino pays, in millionths, whether it is a local casino that sends demo ETH, and its Discord's invite.
      casino = {
        collateralRate: read.whole(advertised.collateralRate),
        depositFeeLimit: read.whole(advertised.depositFeeLimit),
        isLocalDevelopment: read.flag(advertised.isLocalDevelopment),
        discord: read.nullable(read.exactly((url): url is string => this.link(url), 'A link'))(advertised.discord),
      };
    } catch (error: any) {
      serviceError = error.message;
    }
    this.config = { ...casino, ...trusted, confirmations: this.network === 'local' ? 1 : 2 };
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
    // A browser holding no account is a guest's, until the player creates one or signs in.
    const saved = await readAccounts(this.storage, this.expectedChainId);
    this.savedAddresses = Object.keys(saved.accounts);
    if (saved.selected) await this.useKey(saved.accounts[saved.selected], { select: false });
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
    if (!this.signer) return;
    // Asked again if the casino did not answer, and first while no balance plays: what waits for the account registers
    // its channel before any deposit.
    if (!this.profile || !this.playable)
      await this.lookUpNames().catch(error => console.error('Looking up your name failed', error));
    await this.refresh();
    await this.sweep().catch(error => console.error('Adding ETH to your balance failed', error));
    await this.collectPayouts();
    await this.checkHistory().catch(error => console.error('Checking the casino history failed', error));
  }
  /** Keep a head of the casino's signing history for the next check, if the casino signed it, it is newer than the one
   * this wallet holds and none waits for the check yet: a newer head never takes the place of one not yet checked. */
  offerHead(head: SignedStatement | null | undefined) {
    try {
      if (this.nextHead || !head || !RECORD_ID.test(head.message.record)) return;
      if (this.head && head.message.record <= this.head.message.record) return;
      assertSignature(this.domain, HEAD_TYPES, head.message, head.signature, this.operator);
      this.nextHead = head;
    } catch {}
  }
  /** Hold the casino's history to the newest head of it the casino signed that this wallet holds: the record it signed
   * must still be there, with the digest it signed, which commits to every record before it. Only then does the head
   * waiting for the check take its place, and it is checked the same way at once, so a history that lost a head cannot
   * hide that behind a newer one. */
  async checkHistory() {
    for (;;) {
      if (this.head) {
        const { record, digest } = this.head.message;
        const link = await this.api(`/api/history/${record}`).then(
          read.object<{ id: string; digest: string }>({ id: read.recordId, digest: read.hash }),
          (error: any) => {
            if (error.status === 404) return null;
            throw error;
          },
        );
        this.historyAlert =
          link && link.id === record && link.digest === digest
            ? null
            : `The casino rewrote its history: the record ${record} it signed is missing or changed. Keep this browser's wallet, which holds the casino's signature.`;
        this.render();
        if (this.historyAlert) return;
      }
      if (!this.nextHead) return;
      this.head = this.nextHead;
      this.nextHead = null;
      await this.save();
    }
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
      const contract = new Contract(this.config.contractAddress, trustedArtifact.abi, signer);
      const reader = contract.connect(this.provider) as Contract;
      const storageKey =
        'wallet:' +
        this.expectedChainId +
        ':' +
        this.config.contractAddress.toLowerCase() +
        ':' +
        address.toLowerCase();
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
        registers: false,
        discordUsername: null,
        profile: null,
      });
      this.hydrate(await this.storage.get(storageKey));
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
    // What waits for the account decides whether its channel registers before any deposit.
    await named;
    await this.refreshLocked();
    if (this.channel?.registered) await this.activate().catch(() => {});
    this.render();
  }
  hydrate(saved: any) {
    // A record this wallet cannot read is left as it is: nothing is written over it until the player starts over.
    if (saved && !readable(saved)) {
      this.storageFailed = true;
      throw Object.assign(
        new Error(
          "This browser's saved wallet data can't be read. Use Start over in Settings, then sign in again with your passkey or key file.",
        ),
        { code: 'unreadable-state' },
      );
    }
    Object.assign(this, {
      channels: saved?.channels || {},
      channelId: saved?.channelId || null,
      history: saved?.history || [],
      transactionIntent: saved?.transactionIntent || null,
      // Bankroll shares, developer bets and the banks of the account's games belong to the account, not to any one
      // channel.
      fund: saved?.fund || { sequence: 0n, shares: 0n, statement: null },
      developerBets: saved?.developerBets || {},
      developerBetCursor: saved?.developerBetCursor || '',
      developerBetError: null,
      banks: saved?.banks || {},
      autoDeposit: saved?.autoDeposit ?? true,
      atAddress: saved?.atAddress ?? null,
      head: saved?.head ?? null,
    });
  }
  get channel(): WalletChannel | null {
    return this.channels[this.channelId!] || null;
  }
  /** This account's newest channel whose close is under way. It no longer holds the account's balance, which its next
   * channel holds from then on, but it may need a challenge, and it needs finishing. */
  get closingChannel(): WalletChannel | null {
    const closing = Object.values(this.channels).filter(c => c.onchain?.status === STATUS.closing);
    return closing.sort((a, b) => (b.opening.index > a.opening.index ? 1 : -1))[0] || null;
  }
  /** What a closing channel's latest saved state is owed beyond what its close proposes: what a challenge would win. */
  atRisk(closing: WalletChannel) {
    const { deposited, claimed, closingBalance } = closing.onchain!,
      due = owed(closing.state, deposited, claimed);
    return due > closingBalance ? due - closingBalance : 0n;
  }
  /** Whether this account can play with ETH: its channel is registered, plays (`playsOn`) and is not closing. */
  get playable() {
    const c = this.channel;
    return Boolean(c?.registered) && playsOn(c!.onchain, c!.state) && !c!.closing;
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
    return !this.channel && Object.values(this.channels).some(c => c.claim || c.onchain?.status === STATUS.closing);
  }
  /** Whether ETH at this account's address goes into its balance by itself: with the setting on, while the casino is
   * there and nothing is closing or in flight. After a close it waits for the player, who may want it elsewhere. */
  get sweeps() {
    const c = this.channel;
    return (
      this.autoDeposit &&
      !this.recoveryOnly &&
      !this.storageFailed &&
      !this.transactionIntent &&
      !this.missingChannel &&
      !(this.pending && !inbound(this.pending.kind)) &&
      (c ? c.onchain?.status === STATUS.active && !c.closing : !this.forceClosed) &&
      this.nativeBalance > 2n * this.depositFee
    );
  }
  /** Turn on or off whether ETH that arrives at this account's address goes into its balance by itself. */
  async setAutoDeposit(on: boolean) {
    await this.exclusive(() => this.save(undefined, { autoDeposit: on }), { wait: true });
  }
  requireDurableState() {
    if (this.storageFailed) throw new Error('Wallet storage needs recovery; reload from durable state');
  }
  async save(receipt: Receipt | null = null, changes: Record<string, any> = {}) {
    this.requireDurableState();
    // Newest first by the clock, not by when a receipt was last written: a developer bet's receipt is
    // rewritten when what it was paid is collected, and would otherwise jump above the bets placed after it.
    const outstanding = new Set(
      Object.values((changes.developerBets ?? this.developerBets) as CasinoWallet['developerBets']).map(
        bet => bet.operationId,
      ),
    );
    // Past the newest 100, a receipt stays while more is to come of it: a developer bet not settled, and a withdrawal
    // not paid or returned.
    const open = (entry: Receipt) =>
      outstanding.has(entry.operationId) || (entry.withdrawal && !entry.paid && !entry.returned);
    const history = receipt
      ? [receipt, ...this.history.filter(r => r.operationId !== receipt.operationId)]
          .sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''))
          .filter((entry, index) => index < 100 || open(entry))
      : this.history;
    let record;
    try {
      // What IndexedDB keeps, a copy as it clones it: a bigint stays one.
      record = structuredClone({
        schema: 'HOOKEDIN/WALLET-STATE/1',
        channels: this.channels,
        channelId: this.channelId,
        history,
        transactionIntent: this.transactionIntent,
        fund: this.fund,
        developerBets: this.developerBets,
        developerBetCursor: this.developerBetCursor,
        banks: this.banks,
        autoDeposit: this.autoDeposit,
        atAddress: this.atAddress,
        head: this.head,
        ...changes,
      });
      const entries: [string, unknown][] = [[this.storageKey, record]];
      if (receipt) entries.push([this.storageKey + ':receipt:' + receipt.operationId, receipt]);
      await this.storage.commit(entries);
    } catch (error) {
      this.storageFailed = true;
      throw error;
    }
    if (Object.keys(changes).length) this.hydrate(record);
    else this.history = history;
    this.render();
  }
  /** Ask the casino something for this account itself, whatever its channels: its uname, and verifying its Discord
   * account. */
  accountRequest(this: CasinoWallet, action: string) {
    return this.api(`/api/account/${action}`, {});
  }
  /** Ask the casino for this account's uname, with its profile: a uname is the account's before its first deposit,
   * and asking is how the casino meets an account that has none, so others find it by its name. Whether the casino
   * registers the account's channel before any deposit comes with it. A profile already here came from a later reply,
   * and stays. */
  async lookUpNames(this: CasinoWallet) {
    if (this.recoveryOnly) return;
    const address = this.address;
    const { uname, profile, registers } = unameReply(await this.accountRequest('uname'));
    if (this.address !== address) return;
    if (profile.uname !== uname) throw new Error('The casino named this account in another form');
    this.registers = registers;
    if (!this.profile) Object.assign(this, { uname, discordUsername: profile.discordUsername, profile });
    this.render();
  }
  /** Every channel reply carries both names its player answers to, and a registered channel means the casino has met
   * the account, so its public profile exists. */
  noteNames(this: CasinoWallet, { uname, discordUsername }: { uname: string; discordUsername: string | null }) {
    if (uname === this.uname && discordUsername === this.discordUsername && this.profile) return;
    Object.assign(this, { uname, discordUsername, profile: null });
    this.render();
    void this.refreshProfile().catch(() => {});
  }
  /** This account's public record, read from the route everyone reads it from. */
  async refreshProfile(this: CasinoWallet) {
    if (!this.uname) return null;
    const profile = readers.profile(await this.api(`/api/players/~${this.uname}`));
    if (profile.uname === this.uname) {
      this.profile = profile;
      this.discordUsername = profile.discordUsername;
      this.render();
    }
    return this.profile;
  }
  /** A code to run `/verify` with in the HookedIn Discord, `{code, expires}`: the member who runs it gives this account
   * their Discord username to go by. */
  async discordCode(this: CasinoWallet) {
    return read.object<{ code: string; expires: number }>({ code: read.text, expires: read.time })(
      await this.accountRequest('discord/code'),
    );
  }
  /** This account's own profile, asked again: how the wallet learns the name `/verify` gave it. */
  async refreshOwnProfile(this: CasinoWallet) {
    const address = this.address,
      { profile } = unameReply(await this.accountRequest('uname'));
    if (this.address === address) this.takeProfile(profile);
    return this.profile;
  }
  /** Give up the Discord account this account verified: it is shown by its uname again. */
  async unlinkDiscord(this: CasinoWallet) {
    return this.takeProfile(readers.profile(await this.accountRequest('discord/unlink')));
  }
  /** This account's profile as the casino answers the account itself with it, and the names it shows. */
  takeProfile(this: CasinoWallet, profile: Profile) {
    Object.assign(this, { profile, uname: profile.uname, discordUsername: profile.discordUsername });
    this.render();
    return profile;
  }
  /**
   * Publish a game under this account, its developer: a new one, or with its `id` one of its games again, under
   * another name or at another URL; or, with no URL, take it out of the profile. Publishing claims a public name and
   * asks for a balance that plays; taking your own game down only has to be you, so a developer who has closed their
   * channel can still withdraw a game that turned out to be broken. Returns the account's profile, each game with the
   * ID the casino gave it.
   */
  async publishGame(this: CasinoWallet, name: string, url: string | null, id?: string) {
    if (url && !this.playable) throw new Error('Open a balance to publish games');
    return this.takeProfile(
      readers.profile(await this.api('/api/account/games', { name: name.trim(), url, ...(id ? { game: id } : {}) })),
    );
  }
  /** The withdrawals the contract owes from the channel `c`, in the order it records them, each with the deposits its
   * checkpoint took in: those this browser made, from their proofs, and any made on another device, whose proof is not
   * here, taken to draw on every deposit. */
  owing(c: WalletChannel) {
    const onchain = c.onchain!,
      proven = this.history
        .map(entry => entry.withdrawal && (entry.proof as Evidence))
        .filter(
          proof =>
            proof &&
            channelId(proof.base.player, proof.base.index) === c.opening.channelId &&
            !withdrawalRecorded(onchain.claimed, proof),
        )
        .sort((a, b) => (a.base.withdrawn < b.base.withdrawn ? -1 : 1))
        .map(proof => ({ amount: proof.step.operation.amount, deposited: proof.base.deposited })),
      unproven = c.state.withdrawn - onchain.claimed - proven.reduce((n, w) => n + w.amount, 0n);
    return unproven > 0n ? [{ amount: unproven, deposited: onchain.deposited }, ...proven] : proven;
  }
  render() {
    const c = this.channel,
      onchain = c?.onchain,
      closing = this.closingChannel,
      ending = closing?.onchain,
      open = onchain?.status === STATUS.active,
      // Deposited into the channel and not taken into its balance yet: the player's all the same.
      due = open ? onchain.deposited - c!.state.deposited : 0n,
      arriving = due > 0n ? due : 0n;
    const state: PublicState = {
      address: this.address,
      balance: open ? c!.state.balance + arriving : 0n,
      arriving,
      nativeBalance: this.nativeBalance,
      channelId: c?.opening.channelId || null,
      channelStatus: onchain?.status ?? STATUS.active,
      // What a withdrawal can take.
      withdrawable: this.withdrawable(),
      // The deposits the contract still holds for this balance, and the collateral locked into it.
      principal: open ? onchain.principal : 0n,
      collateral: open ? onchain.collateral : 0n,
      // What protects the balance once the contract has recorded the withdrawals it owes.
      protection: open ? protection(c!.state, onchain, this.owing(c!)) : null,
      // What collateral costs at the casino, in millionths of the amount; none while the casino offers none.
      collateralRate: this.recoveryOnly ? null : (this.config?.collateralRate ?? null),
      // The collateral offer waiting for ETH at the address.
      buying: this.buying?.message ?? null,
      observedAt: this.lastChainCheck || 0,
      savedSequence: c?.state.sequence ?? 0n,
      // The channel whose close is under way, beside the open one.
      closingChannelId: closing?.opening.channelId || null,
      deadline: ending?.deadline ?? 0n,
      closingSequence: ending?.closingSequence ?? 0n,
      closingSaved: closing?.state.sequence ?? 0n,
      challengePending: ['challengeClose', 'dispute'].includes(this.transactionIntent?.method ?? ''),
      // What the latest saved state is owed beyond what the close proposes.
      balanceAtRisk: closing ? this.atRisk(closing) : 0n,
      // A close that stops short of a casino bet its quote covers is challenged by disputing the bet.
      challengeDisputes: Boolean(closing && this.disputesClose(closing)),
      needsChallenge: Boolean(
        closing && (closing.state.sequence > ending!.closingSequence || this.disputesClose(closing)),
      ),
      // The prize of the casino bet the close disputes, until the casino settles it: 0 with none.
      disputedPrize: ending?.disputedPrize ?? 0n,
      // The house cash the dispute locked into the close's collateral, until the casino settles the bet: 0 with none.
      disputeHold: ending?.disputeHold ?? 0n,
      // What the contract still owes: closed balances, under their channels, and withdrawals it has not paid in full.
      claims: [
        ...Object.values(this.channels).flatMap(({ claim, opening, observedAt }) =>
          claim
            ? [{ id: opening.channelId, channelId: opening.channelId, to: claim.recipient, observedAt, ...claim }]
            : [],
        ),
        ...this.history
          .filter(entry => entry.withdrawal && entry.recorded && !entry.paid)
          .map(entry => ({
            id: entry.withdrawal,
            to: entry.to,
            amount: entry.amount!,
            paid: entry.amount! - entry.owed!,
            winningsRemaining: entry.winningsRemaining!,
            collectable: entry.collectable!,
          })),
      ],
    };
    this.publicState = state;
    this.tellAllowance();
    this.onChange(this);
    return state;
  }
  async refresh({ channelId }: { channelId?: string | null } = {}) {
    await this.synced;
    this.requireDurableState();
    if (this.busy) return this.publicState;
    if (this.refreshing) {
      await this.refreshing;
      return this.publicState;
    }
    await this.asRefresh(async () => {
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
  /** Run `fn` as this wallet's one refresh: an action waits for it. */
  async asRefresh(fn: () => Promise<void>) {
    const pending = fn();
    this.refreshing = pending;
    try {
      await pending;
    } finally {
      if (this.refreshing === pending) this.refreshing = null;
    }
  }
  async observeChannels(openings: Opening[], block: ChainBlock): Promise<[string, OnchainChannel, Claim | null][]> {
    return mapBounded(openings, async ({ channelId: key, player, index }) => {
      const onchain = onchainChannel(await this.observer.contractRead(this.reader, 'channels', [player, index], block));
      let claim = null;
      if (onchain.status === STATUS.finalized) {
        const [terms, collectable] = await Promise.all([
          this.observer.contractRead(this.reader, 'claims', [key], block),
          this.observer.contractRead(this.reader, 'collectable', [key], block),
        ]);
        // The claim is for what the close was owed, on the checkpoint it finalized.
        const remaining: bigint = terms.protectedRemaining + terms.winningsRemaining;
        claim = {
          beneficiary: terms.beneficiary,
          recipient: terms.recipient,
          stateHash: onchain.closingHash,
          amount: onchain.closingBalance,
          paid: onchain.closingBalance - remaining,
          protectedRemaining: terms.protectedRemaining,
          winningsRemaining: terms.winningsRemaining,
          collectable,
        };
      }
      return [key, onchain, claim];
    });
  }
  applyChannelObservations(records: [string, OnchainChannel, Claim | null][]) {
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
    const opening: Opening = { channelId: channelId(this.address, index), player: this.address, index },
      current = opening.channelId;
    // Only current recovery state is read here, where an action may wait for it: the current channel, the one before
    // it, whose close may be under way, and any known to be closing.
    const previous = index > 0n ? channelId(this.address, index - 1n) : null,
      closing = Object.keys(this.channels).filter(key => this.channels[key].onchain?.status === STATUS.closing);
    const selected = [
      opening,
      ...[...new Set([this.channelId, also, previous, ...closing])]
        .filter(key => key && key !== current && this.channels[key])
        .map(key => this.channels[key!].opening),
    ];
    const records = await this.observeChannels(selected, observation.block);
    await this.observer.accept(observation);
    this.nativeBalance = native;
    this.lastChainCheck = Date.now();
    const at = new Date().toISOString(),
      seen: Receipt[] = [];
    // ETH sent to the address since the last look. A transaction of this wallet's in flight moves what it holds: the
    // wallet looks again once it is recorded.
    if (!this.transactionIntent) {
      if (this.atAddress !== null && native > this.atAddress) seen.push(addressReceipt(native - this.atAddress, at));
      this.atAddress = native;
    }
    const onchain = records.find(([key]) => key === current)![1];
    // The current channel is this account's to sign for from the start: taken up at its base once the chain holds a
    // deposit for it, from this wallet or from anybody, or once the casino registers it before then, as it does while it
    // owes the account something, such as a transfer, or registered it already, here or on another device. It is
    // registered with the casino below.
    const deposited = onchain.deposited > 0n;
    if (!this.channels[current] && (deposited || this.registers))
      this.channels[current] = {
        opening,
        state: baseState(this.address, index),
        playerSignature: '0x',
        casinoSignature: '0x',
        onchain,
      };
    this.history = [...seen, ...this.history];
    this.applyChannelObservations(records.filter(([key]) => this.channels[key]));
    this.channelId = this.channels[current] ? current : null;
    const c = this.channel;
    if (c && !c.registered && !this.recoveryOnly)
      await this.activate().catch(error => {
        if (deposited) console.error('Registering your balance failed', error);
      });
    // One with no deposit that the casino did not register is no balance. Taking up the casino's state of it replaces
    // the channel, so it is read again.
    if (this.channel && !this.channel.registered && !deposited) {
      delete this.channels[current];
      this.channelId = null;
    }
    await this.save();
    return this.publicState;
  }
  async refreshDetails() {
    if (this.detailsRefreshing) return this.detailsRefreshing;
    if (this.busy || this.storageFailed) return this.publicState;
    const storageKey = this.storageKey,
      reader = this.reader,
      observer = this.observer;
    const current = () => this.storageKey === storageKey && this.reader === reader;
    // Only this short commit runs as a refresh, which an action waits for. It merges into the record as it stands by
    // then, so what a refresh changed meanwhile stays.
    const commit = async (apply: () => void) => {
      while (this.refreshing) await this.refreshing.catch(() => {});
      if (!current() || this.busy || this.storageFailed) return;
      await this.asRefresh(async () => {
        apply();
        await this.save();
      });
    };
    // Channels this account closed before, and the transactions its activity lists: read a few at a time.
    this.detailsRefreshing = (async () => {
      try {
        const observation = await observer.observe();
        if (!current()) return this.publicState;
        const keys = Object.keys(this.channels).filter(
          key => key !== this.channelId && this.channels[key].onchain?.status !== STATUS.closing,
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
        const records = await this.observeChannels(
          selected.map(key => this.channels[key].opening),
          observation.block,
        );
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
              ? activity.get(entry.operationId)!
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
    if (this.busy) throw new Error('Wallet is busy');
    this.busy = true;
    let finish!: () => void;
    this.actionDone = new Promise<void>(resolve => {
      finish = resolve;
    });
    try {
      this.render();
      // busy is already set, so no new refresh can start while the one under way finishes.
      await this.refreshing?.catch(() => {});
      this.requireDurableState();
      return await fn();
    } finally {
      this.busy = false;
      finish();
      this.actionDone = undefined;
      this.render();
    }
  }
  /** Refuses unless this wallet may sign on its channel now. A check older than `CHECK_EVERY` is made again first,
   * inside the caller's `exclusive`. */
  async ready() {
    this.requireDurableState();
    this.requireService();
    if (!this.lastChainCheck || Date.now() - this.lastChainCheck > CHECK_EVERY) await this.refreshLocked();
    if (!this.playable) throw new Error('Open or recover a channel before playing');
  }
  /** A request to the casino. One under `/api/channels/:id` or `/api/account/` carries the account's access token. */
  async api(path: string, body: unknown = undefined) {
    if (body !== undefined) this.requireDurableState();
    if (path !== '/api/config') this.requireService();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (/^\/api\/(channels|account)\//.test(path)) {
      if (!this.signer) throw new Error('Create your wallet, or sign in, first.');
      const now = Math.floor(Date.now() / 1000),
        { address, signer } = this;
      let token = this.tokens.get(address);
      // A token is signed for a minute and used while it has twenty seconds left, room for a slow request.
      if (!token || token.expiresAt - now < 20) {
        const message = { player: address, expiresAt: BigInt(now + 60) };
        token = {
          expiresAt: now + 60,
          header: authorization(message, await signer.signTypedData(this.domain, ACCESS_TYPES, message)),
        };
        this.tokens.set(address, token);
      }
      headers.authorization = token.header;
    }
    // A request that never reached the casino, or whose reply never came, says so in words that stay true once the
    // casino is back: the browser's own text is a developer's.
    const response = await fetch(this.casinoURL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : json(body) }),
    }).catch((error: Error) => {
      throw new Error(
        error.name === 'TimeoutError'
          ? 'The casino did not answer in time.'
          : 'Couldn’t reach the casino. Check your connection, then try again.',
      );
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
    const difference = saved.sequence - state.sequence;
    return difference > 0n || (!difference && !same(hashState(this.domain, saved), hashState(this.domain, state)));
  }
  evidence(channel = this.channel!) {
    if (channel.playerSignature && channel.playerSignature !== '0x')
      return checkpointEvidence(channel.state, channel.playerSignature, channel.casinoSignature);
    return channel.lastResponse?.evidence || checkpointEvidence(channel.state);
  }
  /** The evidence that disputes the channel's pending casino bet: its saved checkpoint, and the bet with its seed. */
  disputeEvidence(channel = this.channel!) {
    const { request, signature, seed } = channel.pending!;
    return { ...this.evidence(channel), step: disputedStep(request, signature, seed!) };
  }
  /** Whether a close of `channel` under way stops short of its pending casino bet, which its quote still covers. */
  disputesClose(channel: WalletChannel) {
    return this.disputable(channel) && channel.state.sequence + 1n > channel.onchain!.closingSequence;
  }
  async withSavedRecord<T>(read: (record: any) => T | Promise<T>) {
    if (this.busy) throw new Error('Wait for the current wallet operation');
    this.busy = true;
    try {
      await this.refreshing?.catch(() => {});
      const record = await this.storage.get(this.storageKey);
      if (!record) throw new Error('No wallet record saved');
      return await read(record);
    } finally {
      this.busy = false;
      this.render();
    }
  }
  /** The recovery bundle of a channel, the current one by default: its latest evidence, the withdrawals the contract
   * may still owe something, and a casino bet the casino has not settled. */
  async exportEvidence(channelId?: string | null): Promise<EvidenceBundle> {
    return this.withSavedRecord(async record => {
      const c = record.channels[channelId ?? record.channelId ?? this.closingChannel?.opening.channelId];
      if (!c) throw new Error('No channel evidence saved');
      return {
        chainId: this.expectedChainId,
        casino: this.config.contractAddress,
        operator: this.operator,
        evidence: this.evidence(c),
        // The proofs of the account's withdrawals the contract may still owe something: each is collected under the
        // hash of its operation.
        withdrawals: record.history
          .filter((entry: Receipt) => entry.withdrawal && !entry.paid && !entry.returned)
          .map((entry: Receipt) => entry.proof),
        // A casino bet the casino has not settled, which a watchtower disputes before its quote expires.
        ...(this.disputable(c) ? { dispute: { step: this.disputeEvidence(c).step, quote: c.pending.quote } } : {}),
      };
    });
  }
  /** Take up a recovery bundle the player picked, as JSON holds it. */
  async importEvidence(file: any) {
    await this.exclusive(async () => {
      if (this.pending || this.transactionIntent)
        throw new Error('Recover the saved operation before importing another checkpoint');
      // A file that is JSON but not a bundle is answered here, before the protocol reads its parts.
      if (!file?.chainId || !file.casino || !file.operator || !file.evidence?.base)
        throw new Error('That file is not a recovery bundle: it names no deployment or evidence.');
      const bundle = read.bundle(file),
        checked = verifyEvidence(bundle);
      if (
        bundle.chainId !== this.expectedChainId ||
        !same(bundle.casino, this.config.contractAddress) ||
        !same(bundle.operator, this.operator) ||
        !same(checked.state.player, this.address)
      )
        throw new Error('Evidence belongs to a different wallet or deployment');
      const opening: Opening = {
          channelId: channelId(this.address, checked.state.index),
          player: this.address,
          index: checked.state.index,
        },
        old = this.channels[opening.channelId];
      if (old && this.behind(old.state, checked.state))
        throw new Error('The evidence is older than the saved checkpoint, or conflicts with it');
      // The bundle's withdrawals join the activity as ones this wallet sent do, whatever the chain says of them now: it
      // says how each stands from here on. Each must be this account's operation, followed by the casino's signature.
      const known = new Set(this.history.map(entry => entry.withdrawal)),
        withdrawals: Receipt[] = [];
      for (const proof of bundle.withdrawals ?? []) {
        const op = proof.step.operation;
        let next;
        try {
          if (op.kind !== KIND.withdrawal && op.kind !== KIND.lockIn) throw new Error('Not a withdrawal');
          next = verifyStep(this.domain, proof.base, proof.step, this.address, this.operator);
        } catch {
          throw new Error('The bundle names a withdrawal that is not one this account and the casino signed');
        }
        const id = hashOperation(this.domain, op).toLowerCase();
        if (known.has(id)) continue;
        known.add(id);
        withdrawals.push({
          kind: op.kind === KIND.withdrawal ? 'withdrawal' : 'lock-in',
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
        });
      }
      const { evidence } = bundle,
        stepped = evidence.step.operation.kind !== KIND.none;
      this.channels[opening.channelId] = {
        ...old,
        opening,
        state: checked.state,
        playerSignature: stepped ? '0x' : evidence.playerSignature,
        casinoSignature: stepped ? evidence.step.casinoSignature : evidence.casinoSignature,
        lastResponse: stepped ? { evidence } : null,
        // Read from the chain by the refresh that follows.
        onchain: old?.onchain ?? null,
      };
      if (stepped)
        this.channels[opening.channelId].playerSignature = await this.signer.signTypedData(
          this.domain,
          STATE_TYPES,
          checked.state,
        );
      if (!this.channelId || this.channelId === opening.channelId) this.channelId = opening.channelId;
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
