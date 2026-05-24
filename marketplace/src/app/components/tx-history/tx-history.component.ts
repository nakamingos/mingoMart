import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

import { TimeagoModule } from 'ngx-timeago';
import { LazyLoadImageModule } from 'ng-lazyload-image';

import { Store } from '@ngrx/store';
import { BehaviorSubject, catchError, filter, of, switchMap } from 'rxjs';
import { zeroAddress } from 'viem';

import { WalletAddressDirective } from '@/directives/wallet-address.directive';

import { WeiToEthPipe } from '@/pipes/wei-to-eth.pipe';

import { DataService } from '@/services/data.service';

import { EventType, GlobalState } from '@/models/global-state';
import { getEventVenueLabel } from '@/constants/event-venues';
import { MarketItem } from '@/models/db';

import { environment } from '@environments/environment';

type EventLabels = {
  [type in EventType]: string;
};

@Component({
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    TimeagoModule,
    LazyLoadImageModule,

    WalletAddressDirective,

    WeiToEthPipe,
  ],
  selector: 'app-tx-history',
  templateUrl: './tx-history.component.html',
  styleUrls: ['./tx-history.component.scss']
})

export class TxHistoryComponent implements OnChanges {

  ZERO_ADDRESS = zeroAddress;
  explorerUrl = environment.explorerUrl;

  @Input() phunk!: MarketItem;

  private fetchTxHistory = new BehaviorSubject<string | null>(null);
  fetchTxHistory$ = this.fetchTxHistory.asObservable();

  tokenSales$ = this.fetchTxHistory$.pipe(
    filter((hashId) => !!hashId),
    switchMap((hashId) => this.dataSvc.fetchSingleTokenEvents(hashId!)),
    catchError(error => {
      console.error('Error fetching transaction history', error);
      return of(null);
    })
  );

  eventLabels: Partial<EventLabels> = {
    created: 'Created',
    transfer: 'Transfer',
    escrow: 'Escrow',
    HashOffered: 'Offered',
    HashBidEntered: 'Bid Entered',
    HashBidWithdrawn: 'Bid Withdrawn',
    HashBought: 'Bought',
    HashNoLongerForSale: 'Offer Withdrawn',
    bridgeOut: 'Lock',
    bridgeIn: 'Unlock',
    AuctionCreated: 'Auction Created',
    AuctionBid: 'Auction Bid',
    AuctionExtended: 'Auction Extended',
    AuctionSettled: 'Auction Settled',
    wrapped: 'Wrapped',
    unwrapped: 'Unwrapped',
  };

  getVenueLabel = getEventVenueLabel;

  constructor(
    private store: Store<GlobalState>,
    private dataSvc: DataService,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.phunk && changes.phunk.currentValue) {
      this.fetchTxHistory.next(this.phunk.hashId);
    }
  }
}
