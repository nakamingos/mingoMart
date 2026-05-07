import { Injectable, Logger } from '@nestjs/common';

import { ContractEventName, DecodeEventLogReturnType, Log, Transaction, TransactionReceipt, decodeEventLog, erc721Abi, toHex, zeroAddress } from 'viem';
import { ExtractAbiEvent } from 'abitype';

import { AppConfigService } from '@/config/config.service';
import { StorageService } from '@/modules/storage/storage.service';
import { Event, WrappedEthscription } from '@/modules/storage/models/db';

import {
  EMBLEM_VAULT_METADATA_BASE_URL,
  EMBLEM_VAULT_WRAPPER_ADDRESS_L1,
  ETCH_MARKET_ADDRESS_L1,
  ETHSCRIPTIONS_MARKET_ADDRESS_L1,
  ETHSCRIPTIONS_TRANSFER_PROXY_ADDRESS_L1,
  ETH_ADDRESS,
  OPENSEA_SEAPORT_ADDRESSES_L1,
  ORDEX_MARKET_ADDRESS_L1,
  WETH_ADDRESS_L1,
  BLUR_EXCHANGE_ADDRESS_L1,
  blurExchangeL1,
  etchMarketL1,
  ethscriptionsMarketL1,
  ethscriptionsTransferProxyL1,
  ordexMarketL1,
  seaportL1,
} from './external-venues.constants';

type EmblemVaultBalance = {
  coin?: string;
  id?: string;
  name?: string;
  number?: number;
};

type EmblemVaultMetadata = {
  tokenId?: string;
  status?: string;
  values?: EmblemVaultBalance[];
  addresses?: Array<{ address?: string }>;
  ownershipInfo?: {
    owner?: string;
    contract?: string;
    status?: string;
    balances?: EmblemVaultBalance[];
  };
  targetContract?: Record<string, any>;
};

export type EmblemVaultMapping = {
  hashId: string;
  wrapperVenue: 'emblem-vault';
  wrapperContract: string;
  wrapperTokenId: string;
  vaultAddress: string | null;
  wrappedOwner: string | null;
  status: string | null;
  metadataUrl: string;
  metadata: EmblemVaultMetadata;
};

type EmblemVaultTransfer = {
  hashId: string;
  wrapperContract: string;
  wrapperTokenId: string;
  from: string;
  to: string;
  logIndex: number;
};

type SeaportItem = {
  itemType: number;
  token: string;
  identifier: bigint;
  amount: bigint;
};

type BlurOrder = {
  trader: string;
  side: number;
  collection: string;
  tokenId: bigint;
  paymentToken: string;
  price: bigint;
};

@Injectable()
export class ExternalVenuesService {

  constructor(
    private readonly configSvc: AppConfigService,
    private readonly storageSvc: StorageService,
  ) {}

  async processExternalVenueEvents(
    transaction: Transaction,
    receipt: TransactionReceipt,
    createdAt: Date,
  ): Promise<Event[]> {
    if (this.configSvc.chain.chainIdL1 !== 1) return [];

    const emblemVaultEvents = await this.processEmblemVaultWrapperEvents(transaction, receipt, createdAt);

    const events = [
      ...await this.processEthscriptionsMarketEvents(transaction, receipt, createdAt),
      ...await this.processEtchMarketEvents(transaction, receipt, createdAt),
      ...await this.processOrdexMarketEvents(transaction, receipt, createdAt),
      ...emblemVaultEvents.events,
      ...await this.processOpenSeaWrapperSaleEvents(transaction, receipt, createdAt, emblemVaultEvents.transfers),
      ...await this.processBlurWrapperSaleEvents(transaction, receipt, createdAt, emblemVaultEvents.transfers),
    ];

    return events.sort((a, b) => Number(a.txId.replace(transaction.hash, '')) - Number(b.txId.replace(transaction.hash, '')));
  }

  async resolveEmblemVaultToken(wrapperTokenId: string | bigint): Promise<EmblemVaultMapping | null> {
    const tokenId = wrapperTokenId.toString();
    const metadataUrl = `${EMBLEM_VAULT_METADATA_BASE_URL}/${tokenId}`;
    const response = await fetch(metadataUrl);

    if (!response.ok) {
      Logger.warn(`Could not fetch Emblem Vault metadata ${response.status}`, tokenId);
      return null;
    }

    const metadata = await response.json() as EmblemVaultMetadata;
    const ethscriptionBalance = [
      ...(metadata.values || []),
      ...(metadata.ownershipInfo?.balances || []),
    ].find((balance) => balance.coin === 'ethscription' && balance.id?.startsWith('0x'));

    if (!ethscriptionBalance?.id) {
      Logger.warn('Emblem Vault metadata missing ethscription hashId', tokenId);
      return null;
    }

    const wrapperContract = (
      metadata.targetContract?.['1'] ||
      metadata.ownershipInfo?.contract ||
      EMBLEM_VAULT_WRAPPER_ADDRESS_L1
    ).toLowerCase();

    return {
      hashId: ethscriptionBalance.id.toLowerCase(),
      wrapperVenue: 'emblem-vault',
      wrapperContract,
      wrapperTokenId: metadata.tokenId || tokenId,
      vaultAddress: metadata.addresses?.[0]?.address?.toLowerCase() || null,
      wrappedOwner: metadata.ownershipInfo?.owner?.toLowerCase() || null,
      status: metadata.ownershipInfo?.status || metadata.status || null,
      metadataUrl,
      metadata,
    };
  }

  async syncEmblemVaultToken(
    wrapperTokenId: string | bigint,
    args: {
      wrappedAtBlock?: number | null;
      wrappedTxHash?: string | null;
      wrappedOwner?: string | null;
    } = {},
  ): Promise<WrappedEthscription | null> {
    if (this.configSvc.chain.chainIdL1 !== 1) return null;

    const mapping = await this.resolveEmblemVaultToken(wrapperTokenId);
    if (!mapping) return null;

    const ethscription = await this.storageSvc.checkEthscriptionExistsByHashId(mapping.hashId);
    if (!ethscription) {
      Logger.warn('Emblem Vault maps to unknown local ethscription', mapping.hashId);
      return null;
    }

    const existing = await this.storageSvc.getWrappedEthscriptionByWrapper(
      mapping.wrapperVenue,
      mapping.wrapperContract,
      mapping.wrapperTokenId,
    );

    return this.storageSvc.upsertWrappedEthscription({
      ...mapping,
      active: true,
      lastMetadataSyncAt: new Date(),
      wrappedOwner: args.wrappedOwner?.toLowerCase() || mapping.wrappedOwner,
      wrappedAtBlock: args.wrappedAtBlock ?? existing?.wrappedAtBlock ?? null,
      wrappedTxHash: args.wrappedTxHash ?? existing?.wrappedTxHash ?? null,
      unwrappedAtBlock: null,
      unwrappedTxHash: null,
    });
  }

  private async processEmblemVaultWrapperEvents(
    transaction: Transaction,
    receipt: TransactionReceipt,
    createdAt: Date,
  ): Promise<{ events: Event[]; transfers: EmblemVaultTransfer[] }> {
    const events: Event[] = [];
    const transfers: EmblemVaultTransfer[] = [];
    const logs = (receipt.logs as Log[]).filter((log) => log.address.toLowerCase() === EMBLEM_VAULT_WRAPPER_ADDRESS_L1);

    for (const log of logs) {
      let decoded: DecodeEventLogReturnType<typeof erc721Abi, 'Transfer'>;
      try {
        decoded = decodeEventLog({
          abi: erc721Abi,
          data: log.data,
          topics: (log as any).topics,
        }) as DecodeEventLogReturnType<typeof erc721Abi, 'Transfer'>;
      } catch (error) {
        Logger.warn('Could not decode Emblem Vault wrapper transfer log', transaction.hash);
        continue;
      }

      if (decoded.eventName !== 'Transfer') continue;

      const from = decoded.args.from.toLowerCase();
      const to = decoded.args.to.toLowerCase();
      const wrapperTokenId = decoded.args.tokenId.toString();
      const isWrap = from === zeroAddress;
      const isUnwrap = to === zeroAddress;
      const wrapperContract = log.address.toLowerCase();

      let wrapped = await this.storageSvc.getWrappedEthscriptionByWrapper(
        'emblem-vault',
        wrapperContract,
        wrapperTokenId,
      );

      if (!wrapped && !isUnwrap) {
        wrapped = await this.syncEmblemVaultToken(wrapperTokenId, {
          wrappedOwner: to,
          wrappedAtBlock: isWrap ? Number(transaction.blockNumber) : null,
          wrappedTxHash: isWrap ? transaction.hash : null,
        });
      }

      if (!wrapped) {
        Logger.warn('Could not map Emblem Vault wrapper token to local ethscription', `${transaction.hash}:${wrapperTokenId}`);
        continue;
      }

      if (isWrap) {
        wrapped = await this.storageSvc.upsertWrappedEthscription({
          ...wrapped,
          wrappedOwner: to,
          active: true,
          status: wrapped.status || 'minted',
          wrappedAtBlock: wrapped.wrappedAtBlock ?? Number(transaction.blockNumber),
          wrappedTxHash: wrapped.wrappedTxHash ?? transaction.hash,
          lastMetadataSyncAt: wrapped.lastMetadataSyncAt || null,
          unwrappedAtBlock: null,
          unwrappedTxHash: null,
        });
      } else if (isUnwrap) {
        await this.storageSvc.markWrappedEthscriptionUnwrapped(
          'emblem-vault',
          wrapperContract,
          wrapperTokenId,
          {
            unwrappedAtBlock: Number(transaction.blockNumber),
            unwrappedTxHash: transaction.hash,
          },
        );
      } else if (!isWrap) {
        await this.storageSvc.upsertWrappedEthscription({
          ...wrapped,
          wrappedOwner: to,
          active: true,
          status: wrapped.status || 'minted',
          lastMetadataSyncAt: wrapped.lastMetadataSyncAt || null,
          unwrappedAtBlock: null,
          unwrappedTxHash: null,
        });
      }

      transfers.push({
        hashId: wrapped.hashId.toLowerCase(),
        wrapperContract,
        wrapperTokenId,
        from,
        to,
        logIndex: Number(log.logIndex),
      });

      events.push({
        txId: transaction.hash + log.logIndex,
        type: isWrap ? 'wrapped' : isUnwrap ? 'unwrapped' : 'transfer',
        venue: 'emblem-vault',
        hashId: wrapped.hashId.toLowerCase(),
        from,
        to,
        blockHash: transaction.blockHash,
        txIndex: transaction.transactionIndex,
        txHash: transaction.hash,
        blockNumber: Number(transaction.blockNumber),
        blockTimestamp: createdAt,
        value: null,
      });
    }

    return { events, transfers };
  }

  private async processOpenSeaWrapperSaleEvents(
    transaction: Transaction,
    receipt: TransactionReceipt,
    createdAt: Date,
    wrapperTransfers: EmblemVaultTransfer[],
  ): Promise<Event[]> {
    if (!wrapperTransfers.length) return [];

    const events: Event[] = [];
    const seaportLogs = (receipt.logs as Log[]).filter((log) => OPENSEA_SEAPORT_ADDRESSES_L1.has(log.address.toLowerCase()));

    for (const log of seaportLogs) {
      let decoded: DecodeEventLogReturnType<typeof seaportL1, 'OrderFulfilled'>;
      try {
        decoded = decodeEventLog({
          abi: seaportL1,
          data: log.data,
          topics: (log as any).topics,
        }) as DecodeEventLogReturnType<typeof seaportL1, 'OrderFulfilled'>;
      } catch (error) {
        Logger.warn('Could not decode OpenSea Seaport order log', transaction.hash);
        continue;
      }

      if (decoded.eventName !== 'OrderFulfilled') continue;

      for (const wrapperTransfer of wrapperTransfers) {
        const soldWrapperToken = this.seaportOrderIncludesWrapperToken(decoded.args, wrapperTransfer.wrapperTokenId);
        if (!soldWrapperToken) continue;

        const price = this.getSeaportOrderPaymentAmount(decoded.args);
        if (price <= BigInt(0)) {
          Logger.warn('OpenSea wrapper sale missing payment amount', transaction.hash);
          continue;
        }

        events.push({
          txId: transaction.hash + log.logIndex,
          type: 'PhunkBought',
          venue: 'opensea',
          hashId: wrapperTransfer.hashId,
          from: wrapperTransfer.from,
          to: wrapperTransfer.to,
          blockHash: transaction.blockHash,
          txIndex: transaction.transactionIndex,
          txHash: transaction.hash,
          blockNumber: Number(transaction.blockNumber),
          blockTimestamp: createdAt,
          value: price.toString(),
        });
      }
    }

    return events;
  }

  private async processBlurWrapperSaleEvents(
    transaction: Transaction,
    receipt: TransactionReceipt,
    createdAt: Date,
    wrapperTransfers: EmblemVaultTransfer[],
  ): Promise<Event[]> {
    if (!wrapperTransfers.length) return [];

    const events: Event[] = [];
    const blurLogs = (receipt.logs as Log[]).filter((log) => log.address.toLowerCase() === BLUR_EXCHANGE_ADDRESS_L1);

    for (const log of blurLogs) {
      let decoded: DecodeEventLogReturnType<typeof blurExchangeL1, 'OrdersMatched'>;
      try {
        decoded = decodeEventLog({
          abi: blurExchangeL1,
          data: log.data,
          topics: (log as any).topics,
        }) as DecodeEventLogReturnType<typeof blurExchangeL1, 'OrdersMatched'>;
      } catch (error) {
        Logger.warn('Could not decode Blur exchange order log', transaction.hash);
        continue;
      }

      if (decoded.eventName !== 'OrdersMatched') continue;

      for (const wrapperTransfer of wrapperTransfers) {
        const order = this.findBlurWrapperOrder(decoded.args, wrapperTransfer.wrapperTokenId);
        if (!order) continue;

        const paymentToken = order.paymentToken.toLowerCase();
        if (paymentToken !== ETH_ADDRESS && paymentToken !== WETH_ADDRESS_L1) continue;

        events.push({
          txId: transaction.hash + log.logIndex,
          type: 'PhunkBought',
          venue: 'blur',
          hashId: wrapperTransfer.hashId,
          from: wrapperTransfer.from,
          to: wrapperTransfer.to,
          blockHash: transaction.blockHash,
          txIndex: transaction.transactionIndex,
          txHash: transaction.hash,
          blockNumber: Number(transaction.blockNumber),
          blockTimestamp: createdAt,
          value: order.price.toString(),
        });
      }
    }

    return events;
  }

  private findBlurWrapperOrder(
    args: { sell: BlurOrder; buy: BlurOrder },
    wrapperTokenId: string,
  ): BlurOrder | null {
    const tokenId = BigInt(wrapperTokenId);
    const orders = [args.sell, args.buy];

    return orders.find((order) => (
      order.collection.toLowerCase() === EMBLEM_VAULT_WRAPPER_ADDRESS_L1 &&
      BigInt(order.tokenId.toString()) === tokenId &&
      BigInt(order.price.toString()) > BigInt(0)
    )) || null;
  }

  private seaportOrderIncludesWrapperToken(
    args: { offer: readonly SeaportItem[]; consideration: readonly SeaportItem[] },
    wrapperTokenId: string,
  ): boolean {
    const tokenId = BigInt(wrapperTokenId);
    const items = [...args.offer, ...args.consideration];

    return items.some((item) => {
      const itemType = Number(item.itemType);
      return (
        itemType === 2 &&
        item.token.toLowerCase() === EMBLEM_VAULT_WRAPPER_ADDRESS_L1 &&
        BigInt(item.identifier.toString()) === tokenId
      );
    });
  }

  private getSeaportOrderPaymentAmount(
    args: { offer: readonly SeaportItem[]; consideration: readonly SeaportItem[] },
  ): bigint {
    const items = [...args.offer, ...args.consideration];

    return items.reduce((sum, item) => {
      const itemType = Number(item.itemType);
      const token = item.token.toLowerCase();
      const isNativeEth = itemType === 0;
      const isWeth = itemType === 1 && token === WETH_ADDRESS_L1;

      if (!isNativeEth && !isWeth) return sum;
      return sum + BigInt(item.amount.toString());
    }, BigInt(0));
  }

  private async processEthscriptionsMarketEvents(
    transaction: Transaction,
    receipt: TransactionReceipt,
    createdAt: Date,
  ): Promise<Event[]> {
    const events: Event[] = [];
    const logs = receipt.logs as Log<bigint, number, false, ExtractAbiEvent<typeof ethscriptionsMarketL1, ContractEventName<typeof ethscriptionsMarketL1>>>[];
    const venueLogs = logs.filter((log) => log.address.toLowerCase() === ETHSCRIPTIONS_MARKET_ADDRESS_L1);

    for (const log of venueLogs) {
      let decoded: DecodeEventLogReturnType<typeof ethscriptionsMarketL1, ContractEventName<typeof ethscriptionsMarketL1>>;
      try {
        decoded = decodeEventLog({
          abi: ethscriptionsMarketL1,
          data: log.data,
          topics: log.topics,
        });
      } catch (error) {
        Logger.warn(`Could not decode Ethscriptions.com market log`, transaction.hash);
        continue;
      }

      if (decoded.eventName !== 'EthscriptionPurchased') continue;

      const { seller, buyer, ethscriptionId, price } = decoded.args;
      const hashId = ethscriptionId.toLowerCase();
      const ethscription = await this.storageSvc.checkEthscriptionExistsByHashId(hashId);
      if (!ethscription) continue;

      events.push({
        txId: transaction.hash + log.logIndex,
        type: 'PhunkBought',
        venue: 'ethscriptions-market',
        hashId,
        from: seller.toLowerCase(),
        to: buyer.toLowerCase(),
        blockHash: transaction.blockHash,
        txIndex: transaction.transactionIndex,
        txHash: transaction.hash,
        blockNumber: Number(transaction.blockNumber),
        blockTimestamp: createdAt,
        value: price.toString(),
      });
    }

    return events;
  }

  private async processEtchMarketEvents(
    transaction: Transaction,
    receipt: TransactionReceipt,
    createdAt: Date,
  ): Promise<Event[]> {
    const events: Event[] = [];
    const logs = receipt.logs as Log<bigint, number, false, ExtractAbiEvent<typeof etchMarketL1, ContractEventName<typeof etchMarketL1>>>[];
    const venueLogs = logs.filter((log) => log.address.toLowerCase() === ETCH_MARKET_ADDRESS_L1);

    for (const log of venueLogs) {
      let decoded: DecodeEventLogReturnType<typeof etchMarketL1, ContractEventName<typeof etchMarketL1>>;
      try {
        decoded = decodeEventLog({
          abi: etchMarketL1,
          data: log.data,
          topics: log.topics,
        });
      } catch (error) {
        Logger.warn(`Could not decode Etch market log`, transaction.hash);
        continue;
      }

      if (decoded.eventName !== 'EthscriptionOrderExecuted') continue;

      const { seller, buyer, ethscriptionId, currency, price } = decoded.args;
      if (currency.toLowerCase() !== ETH_ADDRESS) continue;

      const hashId = ethscriptionId.toLowerCase();
      const ethscription = await this.storageSvc.checkEthscriptionExistsByHashId(hashId);
      if (!ethscription) continue;

      events.push({
        txId: transaction.hash + log.logIndex,
        type: 'PhunkBought',
        venue: 'etch-market',
        hashId,
        from: seller.toLowerCase(),
        to: buyer.toLowerCase(),
        blockHash: transaction.blockHash,
        txIndex: transaction.transactionIndex,
        txHash: transaction.hash,
        blockNumber: Number(transaction.blockNumber),
        blockTimestamp: createdAt,
        value: price.toString(),
      });
    }

    return events;
  }

  private async processOrdexMarketEvents(
    transaction: Transaction,
    receipt: TransactionReceipt,
    createdAt: Date,
  ): Promise<Event[]> {
    const matchLogs = this.decodeOrdexMatchLogs(transaction, receipt);
    if (matchLogs.length !== 1) return [];

    const events: Event[] = [];
    const logs = receipt.logs as Log<bigint, number, false, ExtractAbiEvent<typeof ethscriptionsTransferProxyL1, ContractEventName<typeof ethscriptionsTransferProxyL1>>>[];
    const transferLogs = logs.filter((log) => log.address.toLowerCase() === ETHSCRIPTIONS_TRANSFER_PROXY_ADDRESS_L1);

    for (const log of transferLogs) {
      let decoded: DecodeEventLogReturnType<typeof ethscriptionsTransferProxyL1, ContractEventName<typeof ethscriptionsTransferProxyL1>>;
      try {
        decoded = decodeEventLog({
          abi: ethscriptionsTransferProxyL1,
          data: log.data,
          topics: log.topics,
        });
      } catch (error) {
        Logger.warn(`Could not decode Ordex transfer proxy log`, transaction.hash);
        continue;
      }

      if (decoded.eventName !== 'InternalItemTransfer') continue;

      const { from, to, itemId } = decoded.args;
      const hashId = toHex(itemId, { size: 32 }).toLowerCase();
      const ethscription = await this.storageSvc.checkEthscriptionExistsByHashId(hashId);
      if (!ethscription) continue;

      events.push({
        txId: transaction.hash + log.logIndex,
        type: 'PhunkBought',
        venue: 'ordex-market',
        hashId,
        from: from.toLowerCase(),
        to: to.toLowerCase(),
        blockHash: transaction.blockHash,
        txIndex: transaction.transactionIndex,
        txHash: transaction.hash,
        blockNumber: Number(transaction.blockNumber),
        blockTimestamp: createdAt,
        value: matchLogs[0].pricePerItem.toString(),
      });
    }

    return events;
  }

  private decodeOrdexMatchLogs(
    transaction: Transaction,
    receipt: TransactionReceipt,
  ): Array<{ pricePerItem: bigint }> {
    const logs = receipt.logs as Log<bigint, number, false, ExtractAbiEvent<typeof ordexMarketL1, ContractEventName<typeof ordexMarketL1>>>[];

    return logs.flatMap((log) => {
      if (log.address.toLowerCase() !== ORDEX_MARKET_ADDRESS_L1) return [];

      try {
        const decoded: any = decodeEventLog({
          abi: ordexMarketL1,
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName !== 'Match') return [];

        const newLeftFill = BigInt(decoded.args.newLeftFill.toString());
        const newRightFill = BigInt(decoded.args.newRightFill.toString());
        if (newRightFill <= BigInt(0)) return [];

        return [{ pricePerItem: newLeftFill / newRightFill }];
      } catch (error) {
        Logger.warn(`Could not decode Ordex match log`, transaction.hash);
        return [];
      }
    });
  }
}
