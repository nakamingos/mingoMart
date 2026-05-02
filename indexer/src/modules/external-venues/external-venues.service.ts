import { Injectable, Logger } from '@nestjs/common';

import { ContractEventName, DecodeEventLogReturnType, Log, Transaction, TransactionReceipt, decodeEventLog, toHex } from 'viem';
import { ExtractAbiEvent } from 'abitype';

import { AppConfigService } from '@/config/config.service';
import { StorageService } from '@/modules/storage/storage.service';
import { Event } from '@/modules/storage/models/db';

import {
  ETCH_MARKET_ADDRESS_L1,
  ETHSCRIPTIONS_MARKET_ADDRESS_L1,
  ETHSCRIPTIONS_TRANSFER_PROXY_ADDRESS_L1,
  ETH_ADDRESS,
  ORDEX_MARKET_ADDRESS_L1,
  etchMarketL1,
  ethscriptionsMarketL1,
  ethscriptionsTransferProxyL1,
  ordexMarketL1,
} from './external-venues.constants';

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

    const events = [
      ...await this.processEthscriptionsMarketEvents(transaction, receipt, createdAt),
      ...await this.processEtchMarketEvents(transaction, receipt, createdAt),
      ...await this.processOrdexMarketEvents(transaction, receipt, createdAt),
    ];

    return events.sort((a, b) => Number(a.txId.replace(transaction.hash, '')) - Number(b.txId.replace(transaction.hash, '')));
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
