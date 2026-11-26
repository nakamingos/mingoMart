import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { formatUnits, Transaction } from 'viem';

import { Event } from '@/modules/storage/models/db';
import { StorageService } from '@/modules/storage/storage.service';
import { NotificationMessage, NotifItemData } from './models/message.model';

import { rarityData } from './constants/rarity';

import { DiscordService } from './services/discord.service';
import { TwitterService } from './services/twitter.service';
import { Web3Service } from '@/modules/shared/services/web3.service';

import { AppConfigService } from '@/config/config.service';
import { CardsService } from '@/modules/cards/cards.service';
import {
  ETCH_MARKET_ADDRESS_L1,
  ETHERPHUNKS_MARKET_ADDRESS_L1,
  ETHSCRIPTIONS_MARKET_ADDRESS_L1,
  ETHSCRIPTIONS_TRANSFER_PROXY_ADDRESS_L1,
  ORDEX_MARKET_ADDRESS_L1,
} from '@/modules/external-venues/external-venues.constants';

/** Venue contracts that hold items in escrow; an item coming back from one isn't an acquisition. */
const VENUE_ESCROW_ADDRESSES = [
  ETHERPHUNKS_MARKET_ADDRESS_L1,
  ETHSCRIPTIONS_MARKET_ADDRESS_L1,
  ETCH_MARKET_ADDRESS_L1,
  ORDEX_MARKET_ADDRESS_L1,
  ETHSCRIPTIONS_TRANSFER_PROXY_ADDRESS_L1,
];

/** Where a seller's cost basis came from. */
type CostSource = 'purchase' | 'inscription' | 'mint' | 'free' | 'airdrop';

/** Column where values start in the notification code block ("From: " is 6 wide). */
const MESSAGE_VALUE_COLUMN = 6;

/** Mainnet block where EIP-7623 (Pectra) introduced the calldata gas floor. */
const PECTRA_BLOCK_L1 = 22_431_084;

/**
 * Service for handling notifications about marketPlace sales
 */
@Injectable()
export class NotifsService implements OnModuleInit {

  /** Current ETH/USD price */
  usdPrice: number = 0;

  /** Minimum gap between posted notifications, so backfilled sales don't flood the channel. */
  private readonly POST_INTERVAL_MS = 2500;
  /** Sales older than this are valued at the historical ETH price instead of the current one. */
  private readonly HISTORICAL_PRICE_AFTER_MS = 60 * 60 * 1000;

  private postQueue: Promise<void> = Promise.resolve();
  private hourlyUsdPrices = new Map<number, number>();

  constructor(
    @Inject('WEB3_SERVICE_L1') private readonly web3Svc: Web3Service,
    private readonly twitterSvc: TwitterService,
    private readonly discordSvc: DiscordService,
    private readonly storageSvc: StorageService,
    private readonly configSvc: AppConfigService,
    private readonly cardsSvc: CardsService,
  ) {}

  async onModuleInit() {
    this.storageSvc.listenSales().subscribe(event => {
      this.enqueueNotification(event);
    });

    // Fetch USD price every 10 minutes
    this.fetchUSDPrice().then(price => {
      this.usdPrice = price;
      setInterval(async () => {
        this.usdPrice = await this.fetchUSDPrice();
      }, 10 * 60 * 1000);
    });
  }

  /**
   * Handles notification for a specific hash ID
   * Sends based on last sale of hash ID
   * @param hashId The transaction hash ID
   */
  async handleNotificationFromHashId(hashId: string) {
    const event = await this.storageSvc.getLatestBoughtEventByHashId(hashId);
    await this.handleNotification(event);
  }

  /**
   * Posts notifications one at a time, oldest first, with a gap between posts.
   */
  enqueueNotification(boughtEvent: Event): void {
    this.postQueue = this.postQueue
      .then(() => this.handleNotification(boughtEvent))
      .catch((error) => Logger.error(`Sale notification failed: ${error?.message || error}`, boughtEvent?.hashId))
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, this.POST_INTERVAL_MS)));
  }

  /**
   * Processes notifications for item sale events
   * @param boughtEvent The sale event data
   */
  async handleNotification(boughtEvent: Event): Promise<void> {
    const ethscriptionData = await this.getEthscriptionWithCollectionAndAttributes(boughtEvent.hashId);
    if (!ethscriptionData) return;

    const message = await this.createMessage(boughtEvent, ethscriptionData);
    if (!message) return;

    await this.twitterSvc.sendTweet(message);
    await this.discordSvc.postMessage(message);
  }

  /**
   * Creates a notification message for an item sale event
   * @param event The sale event data
   * @returns Formatted notification message object
   */
  async createMessage(
    event: Event,
    ethscriptionData: NotifItemData
  ): Promise<NotificationMessage> {
    const { ethscription, collection } = ethscriptionData;

    const chainId = this.configSvc.chain.chainIdL1;
    const baseUrl = chainId === 1 ? 'https://mingomart.com' : 'https://sepolia.mingomart.com';

    const weiValue = BigInt(event.value);
    if (!weiValue) return;

    const value = formatUnits(weiValue, 18);

    const [fromAddress, toAddress] = await Promise.all([
      this.formatAddress(event.from),
      this.formatAddress(event.to)
    ]);

    const soldAt = event.blockTimestamp ? new Date(event.blockTimestamp) : new Date();
    const usdPrice = await this.getUsdPriceAt(soldAt);

    const pnlRows = await this.getSellerPnlRows(event);

    const title = `${collection.singleName} #${ethscription.tokenId} was flipped`;
    const message = [
      this.messageRow('From', fromAddress),
      this.messageRow('To', toAddress),
      '',
      this.messageRow('For', `${value} ETH ($${this.formatCash(Number(value) * usdPrice)})`),
      ...pnlRows,
    ].join('\n');
    const link = `${baseUrl}/details/${ethscription.hashId}`;
    const imageBuffer = await this.cardsSvc.generateEthscriptionCardImage(ethscription.hashId);

    return {
      title,
      message,
      link,
      imageBuffer: imageBuffer || undefined,
      filename: `${ethscription.hashId}.png`,
      timestamp: soldAt,
      codeLanguage: 'diff',
    };
  }

  /**
   * Retrieves full Ethscription data including collection and attributes
   * @param hashId The Ethscription hash ID
   * @returns Ethscription data with collection and attributes
   * !FIXME: Update to use new attributes!
   */
  async getEthscriptionWithCollectionAndAttributes(hashId: string): Promise<NotifItemData> {
    const {
      ethscription,
      collection,
      attributes,
    } = await this.storageSvc.getEthscriptionWithCollectionAndAttributes(hashId);

    if (!attributes || !collection?.notifications) return null;

    const result = {
      ethscription,
      collection,
      attributes: Object.keys(attributes.values)?.map((key: string) => {
        const k = key;
        const v = Array.isArray(attributes.values[key])
          ? attributes.values[key].join(', ')
          : attributes.values[key];

        return {
          k,
          v,
          rarity: rarityData[ethscription.slug][v],
        };
      }).sort((a, b) => (a.rarity || Infinity) - (b.rarity || Infinity)),
    };

    return result;
  }

  /**
   * Fetches current ETH/USD price from CoinGecko API
   * @returns Current ETH price in USD
   */
  async fetchUSDPrice(): Promise<number> {
    const url = `https://api.coingecko.com/api/v3/simple/price`;

    const params = new URLSearchParams({
      ids: 'ethereum',
      vs_currencies: 'usd',
    });

    try {
      const response = await fetch(`${url}?${params}`);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      return data.ethereum.usd;
    } catch (error) {
      console.log(error);
      return 0;
    }
  }

  /**
   * One aligned row of the notification code block. Rows start with a two-character gutter that
   * holds the 'diff' marker: "+ " rows render green, "- " rows red, "  " rows uncoloured.
   */
  private messageRow(label: string, value: string, marker: '+' | '-' | ' ' = ' '): string {
    // A leading +/- on the value hangs into the padding so the digits stay aligned.
    const width = /^[+-]/.test(value) ? MESSAGE_VALUE_COLUMN - 1 : MESSAGE_VALUE_COLUMN;
    return `${marker} ${`${label}:`.padEnd(width)}${value}`;
  }

  /**
   * The seller's P&L row for a sale (including what they paid), or none when their cost basis
   * isn't known.
   */
  async getSellerPnlRows(sale: Event): Promise<string[]> {
    const pnl = await this.getSellerPnl(sale);
    if (!pnl) return [];

    const { profit, cost, source } = pnl;
    const sign = profit > BigInt(0) ? '+' : profit < BigInt(0) ? '-' : '';
    const abs = profit < BigInt(0) ? -profit : profit;
    const pct = cost > BigInt(0) ? Number((abs * BigInt(10000)) / cost) / 100 : null;
    const pctText = pct === null ? '' : ` (${sign}${pct >= 10 ? Math.round(pct) : pct.toFixed(1).replace(/\.0$/, '')}%)`;

    const marker = sign === '+' ? '+' : sign === '-' ? '-' : ' ';
    return [
      this.messageRow('P&L', `${sign}${this.formatEthAmount(abs)} ETH${pctText}`, marker),
      this.messageRow('Paid', this.describeCost(cost, source), marker),
    ];
  }

  /** The Paid row's value, e.g. "0.0042 ETH to mint" or "free airdrop". */
  private describeCost(cost: bigint, source: CostSource): string {
    if (source === 'free') return 'free mint';
    if (source === 'airdrop') return 'free airdrop';
    const suffix = source === 'inscription' ? ' to inscribe' : source === 'mint' ? ' to mint' : '';
    return `${this.formatEthAmount(cost)} ETH${suffix}`;
  }

  /**
   * Works out what the seller paid, from their most recent acquisition of the item before the sale:
   * a purchase (price paid), an inscription they made themselves (gas + value), or a mint fulfilled
   * by a collection's mint service (imported mint cost). Items coming back from a venue's escrow
   * are skipped. Anything else (gifts, transfers from other wallets) means the cost is unknown.
   */
  private async getSellerPnl(sale: Event): Promise<{ profit: bigint; cost: bigint; source: CostSource } | null> {
    try {
      const seller = sale.from?.toLowerCase();
      if (!seller || !sale.hashId || !sale.value || !sale.blockTimestamp) return null;
      const saleValue = BigInt(sale.value);

      const escrows = new Set<string>([
        ...VENUE_ESCROW_ADDRESSES,
        this.configSvc.contracts.market.l1,
        this.configSvc.contracts.auctionHouse.l1,
        ...await this.storageSvc.getWrapperVaultAddresses(sale.hashId),
      ].map((address) => address?.toLowerCase()).filter((address) => address && !/^0x0{40}$/.test(address)));

      const received = (await this.storageSvc.getEventsReceivedByAddress(sale.hashId, seller, sale.blockTimestamp))
        .filter((event) => event.txHash?.toLowerCase() !== sale.txHash?.toLowerCase());

      for (const event of received) {
        if (event.type === 'HashBought') {
          const cost = BigInt(event.value || 0);
          return { profit: saleValue - cost, cost, source: 'purchase' };
        }

        if (event.type === 'created') {
          if (event.from?.toLowerCase() !== seller) {
            // Inscribed to them by a mint service: use the imported mint cost, if known.
            const item = await this.storageSvc.checkEthscriptionExistsByHashId(sale.hashId);
            if (!item?.mintKind || item.mintCost === null || item.mintCost === undefined) return null;
            const cost = BigInt(item.mintCost);
            const source: CostSource = item.mintKind === 'paid' ? 'mint' : item.mintKind;
            return { profit: saleValue - cost, cost, source };
          }
          const cost = await this.getInscriptionCost(event.txHash as `0x${string}`);
          return cost === null ? null : { profit: saleValue - cost, cost, source: 'inscription' };
        }

        if (event.type === 'transfer') {
          if (escrows.has(event.from?.toLowerCase())) continue; // came back from a venue's escrow
          const purchase = received.find((e) => e.type === 'HashBought' && e.txHash === event.txHash);
          if (purchase) {
            const cost = BigInt(purchase.value || 0);
            return { profit: saleValue - cost, cost, source: 'purchase' };
          }
          return null;
        }
      }
      return null;
    } catch (error) {
      Logger.warn(`Could not work out P&L: ${error?.message || error}`, sale?.hashId);
      return null;
    }
  }

  /**
   * What the creator paid for an inscription transaction: gas + any ETH value sent.
   * Uses the receipt when the RPC still has it; otherwise, for a plain calldata transaction
   * (sent to an address without code), computes the gas from the calldata and the block's base fee.
   */
  private async getInscriptionCost(txHash: `0x${string}`): Promise<bigint | null> {
    const client = this.web3Svc.client;
    const tx = await client.getTransaction({ hash: txHash });

    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      if (receipt?.gasUsed && receipt?.effectiveGasPrice) {
        return receipt.gasUsed * receipt.effectiveGasPrice + tx.value;
      }
    } catch {
      // Receipt pruned by the RPC; fall through to the calculation.
    }

    if (!tx.to || tx.accessList?.length) return null;
    const code = await client.getCode({ address: tx.to });
    if (code && code !== '0x') return null; // contract call: gas isn't derivable from calldata

    const gasUsed = this.plainTransactionGas(tx);
    const gasPrice = await this.effectiveGasPrice(tx);
    if (gasPrice === null) return null;
    return gasUsed * gasPrice + tx.value;
  }

  /** Gas used by a transaction with no execution: intrinsic cost, with the EIP-7623 floor after Pectra. */
  private plainTransactionGas(tx: Transaction): bigint {
    const data = (tx.input || '0x').slice(2);
    let zeroBytes = BigInt(0);
    let nonZeroBytes = BigInt(0);
    for (let i = 0; i < data.length; i += 2) {
      if (data.slice(i, i + 2) === '00') zeroBytes++;
      else nonZeroBytes++;
    }
    const standard = BigInt(21000) + zeroBytes * BigInt(4) + nonZeroBytes * BigInt(16);
    if (Number(tx.blockNumber) < PECTRA_BLOCK_L1) return standard;
    const tokens = zeroBytes + nonZeroBytes * BigInt(4);
    const floor = BigInt(21000) + tokens * BigInt(10);
    return standard > floor ? standard : floor;
  }

  private async effectiveGasPrice(tx: Transaction): Promise<bigint | null> {
    if (tx.type === 'legacy' || tx.type === 'eip2930') return tx.gasPrice ?? null;
    if (tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined) return tx.gasPrice ?? null;
    const block = await this.web3Svc.client.getBlock({ blockNumber: tx.blockNumber });
    if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) return null;
    const tip = tx.maxFeePerGas - block.baseFeePerGas;
    const priority = tx.maxPriorityFeePerGas < tip ? tx.maxPriorityFeePerGas : tip;
    return block.baseFeePerGas + priority;
  }

  /** Compact ETH amount: up to 4 significant digits below 1 ETH, 3 decimals above. */
  private formatEthAmount(wei: bigint): string {
    const value = Number(formatUnits(wei, 18));
    if (value === 0) return '0';
    return value < 1
      ? new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 }).format(value)
      : new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(value);
  }

  /**
   * ETH/USD price at a given time. Recent sales use the current price; older ones use the
   * hourly close from Coinbase for that hour (cached), falling back to the current price.
   */
  async getUsdPriceAt(at: Date): Promise<number> {
    if (Number.isNaN(at.getTime()) || Date.now() - at.getTime() < this.HISTORICAL_PRICE_AFTER_MS) {
      return this.usdPrice;
    }

    const HOUR_MS = 60 * 60 * 1000;
    const hourStart = Math.floor(at.getTime() / HOUR_MS) * HOUR_MS;
    const cached = this.hourlyUsdPrices.get(hourStart);
    if (cached) return cached;

    const params = new URLSearchParams({
      granularity: '3600',
      start: new Date(hourStart).toISOString(),
      end: new Date(hourStart + HOUR_MS).toISOString(),
    });

    try {
      const response = await fetch(`https://api.exchange.coinbase.com/products/ETH-USD/candles?${params}`, {
        headers: { 'User-Agent': 'mingomart-indexer' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Each candle: [time, low, high, open, close, volume], newest first.
      const candles = await response.json() as number[][];
      const candle = candles.find((c) => c[0] * 1000 === hourStart) || candles[candles.length - 1];
      const close = candle?.[4];
      if (!close) throw new Error('no candle data');
      this.hourlyUsdPrices.set(hourStart, close);
      return close;
    } catch (error) {
      Logger.warn(`Historical ETH price unavailable for ${new Date(hourStart).toISOString()}: ${error?.message || error}`);
      return this.usdPrice;
    }
  }

  /**
   * Formats an Ethereum address, using ENS name if available
   * @param address The Ethereum address
   * @returns Formatted address or ENS name
   */
  async formatAddress(address: string): Promise<string> {
    let fmatAddress = await this.web3Svc.getEnsFromAddress(address);
    if (!fmatAddress) fmatAddress = address.slice(0, 6) + '...' + address.slice(-4);
    return fmatAddress;
  }

  /**
   * Formats a number into a human-readable currency string with K/M/B/T suffixes
   * @param n The number to format
   * @param decimals Number of decimal places (default 2)
   * @returns Formatted currency string
   */
  formatCash(n: number, decimals: number = 2): string {
    if (n === 0) return '0';
    if (n < 1) return n.toFixed(2) + '';
    if (n < 1e3) return n.toFixed(decimals) + '';
    if (n >= 1e3 && n < 1e6) return +(n / 1e3).toFixed(1) + 'K';
    if (n >= 1e6 && n < 1e9) return +(n / 1e6).toFixed(1) + 'M';
    if (n >= 1e9 && n < 1e12) return +(n / 1e9).toFixed(1) + 'B';
    if (n >= 1e12) return +(n / 1e12).toFixed(1) + 'T';
    return 0 + '';
  };
}
