import { Injectable, Logger } from '@nestjs/common';

import { ContractEventName, DecodeEventLogReturnType, Log, Transaction, TransactionReceipt, decodeEventLog, zeroAddress } from 'viem';
import { ExtractAbiEvent } from 'abitype';

import { marketL1 } from '@/abi';

import { StorageService } from '@/modules/storage/storage.service';
import { AppConfigService } from '@/config/config.service';

import { Event } from '@/modules/storage/models/db';
import { mkdir, writeFile } from 'fs/promises';

@Injectable()
export class MarketplaceService {

  constructor(
    private readonly configSvc: AppConfigService,
    private readonly storageSvc: StorageService,
  ) {}

  /**
   * Processes the Mingo Mart marketplace contract events.
   *
   * @param transaction - The transaction object.
   * @param receipt - The transaction receipt.
   * @param createdAt - The creation date of the events.
   * @returns A promise that resolves to an array of events.
   */
  async processMingoMartMarketplaceEvents(
    transaction: Transaction,
    receipt: TransactionReceipt,
    createdAt: Date
  ): Promise<Event[]> {

    const events = [];

    // Filter logs for Mingo Mart Marketplace events
    const logs = receipt.logs as Log<bigint, number, false, ExtractAbiEvent<typeof marketL1, ContractEventName<typeof marketL1>>>[];
    const marketplaceLogs = logs.filter(
      (log) => log.address.toLowerCase() === this.configSvc.contracts.market.l1.toLowerCase()
    );

    if (marketplaceLogs.length) {
      Logger.debug(
        `Processing Mingo Mart Marketplace event (L1)`,
        transaction.hash
      );

      for (const log of marketplaceLogs) {
        if (!this.configSvc.contracts.market.l1.includes(log.address?.toLowerCase())) continue;

        let decoded: DecodeEventLogReturnType<typeof marketL1, ContractEventName<typeof marketL1>>;
        try {
          decoded = decodeEventLog({
            abi: marketL1,
            data: log.data,
            topics: log.topics,
          });
        } catch (error) {
          console.log(error);
          continue;
        }

        const event = await this.processMingoMartMarketplaceEvent(
          transaction,
          createdAt,
          decoded,
          log
        );

        if (event) events.push(event);
      }
    }

    return events;
  }

  /**
   * Processes an individual Mingo Mart marketplace event.
   *
   * @param txn - The transaction object.
   * @param createdAt - The timestamp when the event was created.
   * @param decoded - The decoded event log.
   * @param log - The log object.
   * @returns A promise that resolves to an Event object.
   */
  async processMingoMartMarketplaceEvent(
    txn: Transaction,
    createdAt: Date,
    decoded: DecodeEventLogReturnType<typeof marketL1, ContractEventName<typeof marketL1>>,
    log: Log
  ): Promise<Event> {
    const { eventName } = decoded;
    const { args } = decoded as any;

    if (!eventName || !args) return;

    const hashId =
      args.hashId ||
      args.id ||
      args.potentialEthscriptionId;

    if (!hashId) return;

    const marketItem = await this.storageSvc.checkEthscriptionExistsByHashId(hashId);
    if (!marketItem) return;

    // A MingoMartMarket listing is stored per seller (hashesOfferedForSale[seller][hashId]), and
    // the contract can't verify deposits, so anyone can list, delist or "sell" any hash under their
    // own address without touching the real owner's listing. We keep one listing per item: the one
    // created by the item's verified previous owner (see HashOffered). Sales and delistings only
    // affect that listing when they come from the same seller; anything else is ignored.

    if (eventName === 'HashBought') {
      const { hashId, fromAddress, toAddress, value } = args;

      const removedListing = await this.removeListingFromSeller(hashId, fromAddress);
      if (!removedListing) return;

      return {
        txId: txn.hash + log.logIndex,
        type: eventName,
        venue: 'mingomart-market',
        hashId: hashId.toLowerCase(),
        from: fromAddress.toLowerCase(),
        to: toAddress.toLowerCase(),
        blockHash: txn.blockHash,
        txIndex: txn.transactionIndex,
        txHash: txn.hash,
        blockNumber: Number(txn.blockNumber),
        blockTimestamp: createdAt,
        value: value.toString(),
      };
    }

    if (eventName === 'HashNoLongerForSale') {
      const { hashId, seller } = args;

      // Also emitted by withdrawHash, after the item has already left escrow, so the seller can't
      // be checked against prevOwner here. The listing it removes was validated when created.
      const removedListing = await this.removeListingFromSeller(hashId, seller);
      if (!removedListing) return;

      return {
        txId: txn.hash + log.logIndex,
        type: eventName,
        venue: 'mingomart-market',
        hashId: hashId.toLowerCase(),
        from: seller.toLowerCase(),
        to: zeroAddress,
        blockHash: txn.blockHash,
        txIndex: txn.transactionIndex,
        txHash: txn.hash,
        blockNumber: Number(txn.blockNumber),
        blockTimestamp: createdAt,
        value: BigInt(0).toString(),
      };
    }

    if (eventName === 'HashOffered') {
      const { hashId, seller, toAddress, minValue } = args;

      // This event is emitted after the transfer of ownership, so a valid listing has the
      // marketplace contract as owner and the seller as previous owner. Anything else is a listing
      // by someone who doesn't own the item; it lives in its own slot on the contract, so the
      // real owner's listing (if any) stays valid and is left alone.
      if (
        !marketItem.prevOwner ||
        marketItem.prevOwner.toLowerCase() !== seller.toLowerCase() ||
        marketItem.owner?.toLowerCase() !== this.configSvc.contracts.market.l1.toLowerCase()
      ) {

        // Write the failed listing to a file
        try { await mkdir('./failed'); } catch (error) {}
        await writeFile(`./failed/${hashId}.json`, JSON.stringify({ txn: txn.hash, marketItem }));
        Logger.error(
          'Listing not created by previous owner or owner is not the marketplace contract',
          hashId
        );
        return;
      }

      await this.storageSvc.createListing(txn, createdAt, hashId, toAddress, minValue, 'mingomart-market', false, seller);
      return {
        txId: txn.hash + log.logIndex,
        type: eventName,
        venue: 'mingomart-market',
        hashId: hashId.toLowerCase(),
        from: seller?.toLowerCase(),
        to: toAddress?.toLowerCase(),
        blockHash: txn.blockHash,
        txIndex: txn.transactionIndex,
        txHash: txn.hash,
        blockNumber: Number(txn.blockNumber),
        blockTimestamp: createdAt,
        value: minValue.toString(),
      };
    }
  }

  /**
   * Removes the item's listing only if it was created by `seller`.
   *
   * @returns True if a listing by that seller was found and removed.
   */
  private async removeListingFromSeller(hashId: string, seller: string): Promise<boolean> {
    const listing = await this.storageSvc.getListing(hashId, 'mingomart-market');
    if (!listing) return false;

    if (!seller || listing.listedBy?.toLowerCase() !== seller.toLowerCase()) {
      Logger.warn(
        `Ignoring market event from ${seller}: the listing belongs to ${listing.listedBy}`,
        hashId
      );
      return false;
    }

    return this.storageSvc.removeListing(hashId, 'mingomart-market');
  }
}
