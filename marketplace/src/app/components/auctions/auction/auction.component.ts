import { Component, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';

import { Store } from '@ngrx/store';
import { toObservable } from '@angular/core/rxjs-interop';
import { combineLatest, delay, distinctUntilChanged, filter, map, of, switchMap, tap } from 'rxjs';
import { zeroAddress } from 'viem';

import { Collection } from '@/models/data.state';
import { MarketItem } from '@/models/db';
import { GlobalState, Notification } from '@/models/global-state';

import { Web3Service } from '@/services/web3.service';
import { DataService } from '@/services/data.service';
import { UtilService } from '@/services/util.service';

import { TimerComponent } from './timer/timer.component';
import { BidHistoryComponent } from './bid-history/bid-history.component';

import { WeiToEthPipe } from '@/pipes/wei-to-eth.pipe';

import { WalletAddressDirective } from '@/directives/wallet-address.directive';

import { upsertNotification } from '@/state/notification/notification.actions';

@Component({
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    ReactiveFormsModule,

    TimerComponent,
    BidHistoryComponent,

    WalletAddressDirective,

    WeiToEthPipe
  ],
  selector: 'app-auction',
  templateUrl: './auction.component.html',
  styleUrls: ['./auction.component.scss']
})

export class AuctionComponent {

  zeroAddr = zeroAddress;

  item = input.required<MarketItem>();
  item$ = toObservable(this.item);

  collection = input<Collection | undefined>();
  collection$ = toObservable(this.collection);

  navButtons = input<boolean>(false);
  nextClicked = output<void>();
  prevClicked = output<void>();

  itemWithAuction$ = combineLatest([this.item$, this.collection$]).pipe(
    filter(([item]) => !!item?.auction || !!item?.isAuctioned),
    map(([item, collection]) => {
      const hasCollection = !!item.collection;
      if (hasCollection) return item;
      return { ...item, collection };
    }),
    switchMap((item) => this.web3Svc.watchAuctionByPrevOwnerAndHashId({
      prevOwner: item!.prevOwner!,
      hashId: item!.hashId
    }).pipe(
      map((auction): MarketItem | null => ({ ...item, auction })),
    )),
  );

  auctionBids$ = this.item$.pipe(
    distinctUntilChanged((a, b) => a?.auction?.auctionId === b?.auction?.auctionId),
    switchMap((item) => {
      if (!item?.auction) return of([]);
      return this.dataSvc.watchAuctionBids(item.auction.auctionId);
    }),
  );

  name$ = this.item$.pipe(
    map((item: MarketItem) => item.attributes?.filter(attribute => attribute.k === 'Name')[0]?.v),
  );

  bidValue = new FormControl<number | null>(null);

  auctionComplete = signal(false);
  inputError = signal(false);

  constructor(
    private store: Store<GlobalState>,
    public web3Svc: Web3Service,
    public dataSvc: DataService,
    public utilSvc: UtilService,
  ) {}

  async submitBid(): Promise<void> {
    // Get the item
    const item = this.item();
    if (!item) throw new Error('MarketItem not found');

    // Get the bid value
    const bidValue: number | null = this.bidValue.value;
    if (!bidValue) throw new Error('You must enter a bid value');

    // Create the notification
    let notification: Notification = {
      id: this.utilSvc.createIdFromString('createBid' + item.hashId),
      timestamp: Date.now(),
      slug: item.slug,
      type: 'wallet',
      function: 'createBid',
      hashId: item.hashId,
      tokenId: item.tokenId,
      value: bidValue,
    };

    // Dispatch the notification
    this.store.dispatch(upsertNotification({ notification }));

    try {
      // Get the current active auction
      // const currentAuction = await this.web3Svc.getAuctionByPrevOwnerAndHashId({
      //   prevOwner: item.prevOwner!,
      //   hashId: item.hashId
      // });

      // Send the tx
      const hash = await this.web3Svc.createBid(bidValue, item.hashId, item.prevOwner!);
      if (!hash) throw new Error('Transaction failed');

      // Reset the bid value
      this.resetBid();

      // Update the notification
      notification = {
        ...notification,
        type: 'pending',
        hash,
      };

      // Dispatch the notification
      this.store.dispatch(upsertNotification({ notification }));

      // Poll the receipt
      const receipt = await this.web3Svc.pollReceipt(hash!);

      // Update the notification
      notification = {
        ...notification,
        type: 'complete',
        hash: receipt.transactionHash,
      };

    } catch (err) {
      console.log(err);

      // Update the notification
      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
    } finally {
      // Dispatch the notification
      this.store.dispatch(upsertNotification({ notification }));
    }
  }

  async settleAuction(): Promise<void> {
    const item = this.item();
    if (!item) throw new Error('MarketItem not found');

    // Create the notification
    let notification: Notification = {
      id: this.utilSvc.createIdFromString('settleAuction' + item.hashId),
      timestamp: Date.now(),
      slug: item.slug,
      type: 'wallet',
      function: 'settleAuction',
      hashId: item.hashId,
      tokenId: item.tokenId,
    };

    // Dispatch the notification
    this.store.dispatch(upsertNotification({ notification }));

    try {
      // Get the current active auction
      // const currentAuction = await this.web3Svc.getAuctionByPrevOwnerAndHashId({
      //   prevOwner: item.prevOwner!,
      //   hashId: item.hashId
      // });

      // Send the tx
      const hash = await this.web3Svc.settleAuction(item.hashId, item.prevOwner!);
      if (!hash) throw new Error('Transaction failed');

      // Reset the bid value
      this.resetBid();

      // Update the notification
      notification = {
        ...notification,
        type: 'pending',
        hash,
      };

      // Dispatch the notification
      this.store.dispatch(upsertNotification({ notification }));

      // Poll the receipt
      const receipt = await this.web3Svc.pollReceipt(hash!);

      // Update the notification
      notification = {
        ...notification,
        type: 'complete',
        hash: receipt.transactionHash,
      };

    } catch (err) {
      console.log(err);

      // Update the notification
      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
    } finally {
      // Dispatch the notification
      this.store.dispatch(upsertNotification({ notification }));
    }
  }

  resetBid(): void {
    this.bidValue.reset();
  }

  handleTimeLeft(timeLeft: any): void {
    this.auctionComplete.set(timeLeft.left <= 0);
  }

  nextAuction(): void {
    this.nextClicked.emit();
  }

  prevAuction(): void {
    this.prevClicked.emit();
  }
}
