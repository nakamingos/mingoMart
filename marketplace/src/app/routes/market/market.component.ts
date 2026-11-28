import { Component, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { FormArray, FormBuilder, FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms';

import { Store } from '@ngrx/store';
import { NgxPaginationModule } from 'ngx-pagination';
import { LazyLoadImageModule } from 'ng-lazyload-image';

import { filter, map, tap } from 'rxjs';

import { MarketSortsComponent } from './components/market-sorts/market-sorts.component';
import { MarketHeaderComponent } from './components/market-header/market-header.component';

import { MarketItemGridComponent } from '@/components/market-item-grid/market-item-grid.component';
import { CommentsComponent } from '@/components/comments/comments.component';
import { MarketFiltersComponent } from '@/routes/market/components/market-filters/market-filters.component';
import { SlideoutComponent } from '@/components/slideout/slideout.component';

import { MarketItem } from '@/models/db';
import { GlobalState, Notification, TraitFilter } from '@/models/global-state';

import { DataService } from '@/services/data.service';
import { Web3Service } from '@/services/web3.service';
import { UtilService } from '@/services/util.service';

import { WeiToEthPipe } from '@/pipes/wei-to-eth.pipe';
import { CalcPipe } from '@/pipes/calculate.pipe';
import { FormatCashPipe } from '@/pipes/format-cash.pipe';
import { AddressPipe } from '@/pipes/address.pipe';

import * as appStateSelectors from '@/state/app/app-state.selectors';
import * as appStateActions from '@/state/app/app-state.actions';
import * as dataStateSelectors from '@/state/data/data-state.selectors';
import * as marketStateSelectors from '@/state/market/market-state.selectors';
import { upsertNotification } from '@/state/notification/notification.actions';
import { ExternalEscrowVenue, getExternalEscrow, getExternalEscrowByVenue } from '@/constants/escrow-venues';

import { environment } from '@environments/environment';

const defaultActionState = {
  canList: false,
  canTransfer: false,
  canWithdraw: false,
  canEscrow: false,
};

@Component({
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    LazyLoadImageModule,
    NgxPaginationModule,
    FormsModule,
    ReactiveFormsModule,

    MarketHeaderComponent,
    MarketItemGridComponent,
    MarketFiltersComponent,
    SlideoutComponent,
    MarketSortsComponent,
    CommentsComponent,

    WeiToEthPipe,
    CalcPipe,
    FormatCashPipe,
    AddressPipe,
  ],
  selector: 'app-market-item-grid-view',
  templateUrl: './market.component.html',
  styleUrls: ['./market.component.scss']
})

export class MarketComponent {

  @ViewChild('transferAddressInput') transferAddressInput!: ElementRef<HTMLInputElement>;

  env = environment;

  escrowAddress = environment.marketAddress;

  filtersVisible: boolean = false;

  bulkActionsForm = this.fb.group({
    listingItems: this.fb.array([]),
    transferItems: this.fb.array([]),
    escrowItems: this.fb.array([]),
    withdrawItems: this.fb.array([]),
    buyItems: this.fb.array([]),
  });

  selectedMarketItemsFormArray: FormArray = this.fb.array([]);
  transferAddress = new FormControl<string | null>('');

  selected: { [string: MarketItem['hashId']]: MarketItem } = {};
  deselected: MarketItem[] = [];
  selectedValue: string = '';

  selectMultipleActive: boolean = false;
  selectAll: boolean = false;

  isListingBulk: boolean = false;
  isTransferingBulk: boolean = false;
  isEscrowingBulk: boolean = false;
  isWithdrawingBulk: boolean = false;
  isBuyingBulk: boolean = false;

  actionsState: {
    canList: boolean,
    canTransfer: boolean,
    canWithdraw: boolean,
    canEscrow: boolean,
  } = defaultActionState;

  globalConfig$ = this.store.select(appStateSelectors.selectConfig);
  activeCollection$ = this.store.select(dataStateSelectors.selectActiveCollection);
  walletAddress$ = this.store.select(appStateSelectors.selectWalletAddress);

  routeParamAddress$ = this.route.queryParams.pipe(
    map((params) => params['address'])
  );

  slideoutActive$ = this.store.select(appStateSelectors.selectSlideoutActive).pipe(
    tap((slideoutActive: boolean) => {
      if (!slideoutActive) this.resetState();
    })
  );

  activeSort$ = this.store.select(marketStateSelectors.selectActiveSort);
  marketType$ = this.store.select(marketStateSelectors.selectMarketType)
  activeMarketRouteData$ = this.store.select(marketStateSelectors.selectActiveMarketRouteData).pipe(
    tap(() => {
      this.clearSelectedAndClose();
    })
  );

  activeTraitFilters$ = this.store.select(marketStateSelectors.selectActiveTraitFilters).pipe(
    map((traitFilters: any) => {
      const traitFiltersCopy = { ...traitFilters };
      delete traitFiltersCopy['address'];
      return traitFiltersCopy as TraitFilter;
    })
  );

  indexerIsBehind$ = this.store.select(appStateSelectors.selectIndexerIsBehind);

  advancedMode$ = this.store.select(appStateSelectors.selectAdvancedMode);
  usd$ = this.store.select(dataStateSelectors.selectUsd);

  ceil = Math.ceil;
  objectKeys = Object.keys;
  objectValues = Object.values;

  countActiveTraitFilters(filters: TraitFilter | null | undefined): number {
    if (!filters) return 0;

    return Object.values(filters).reduce((count, value) => {
      if (Array.isArray(value)) return count + value.filter(Boolean).length;
      return value ? count + 1 : count;
    }, 0);
  }

  constructor(
    private store: Store<GlobalState>,
    public dataSvc: DataService,
    public web3Svc: Web3Service,
    private utilSvc: UtilService,
    private fb: FormBuilder,
    private route: ActivatedRoute,
  ) {}

  /**
   * Executes a batch action on selected items
   * @param type - The type of batch action to perform (transfer, escrow, withdraw, list, or sweep)
   */
  async batchAction(type: 'transfer' | 'escrow' | 'withdraw' | 'list' | 'sweep'): Promise<void> {
    if (!Object.keys(this.selected).length) return;

    if (type === 'sweep') await this.buySelected();
    if (type === 'transfer') await this.transferSelected();
    if (type === 'escrow') await this.escrowSelected();
    if (type === 'list') await this.listSelected();
    if (type === 'withdraw') await this.withdrawSelected();
  }

  /**
   * Prepares the UI for bulk buying of selected items
   * Filters out items that are not in escrow or invalid, then sets up the form
   */
  async buySelected(): Promise<void> {
    this.isBuyingBulk = true;
    this.store.dispatch(appStateActions.setSlideoutActive({ slideoutActive: true }));

    const { inEscrow, notInEscrow, invalid } = await this.checkSelected(true);
    this.deselected = [ ...notInEscrow, ...invalid ];

    const formArray = this.fb.array(inEscrow.map((item: MarketItem) => this.fb.group({
      tokenId: [item.tokenId],
      hashId: [item.hashId],
      sha: [item.sha],
      listing: {
        minValue: [item.listing?.minValue]
      },
    }))) as FormArray;

    this.bulkActionsForm.setControl('buyItems', formArray);
    this.selectedMarketItemsFormArray = this.bulkActionsForm.get('buyItems') as FormArray;
  }

  /**
   * Prepares the UI for bulk transfer of selected items
   * Filters out items that are in escrow or invalid, then sets up the form and focuses the address input
   */
  async transferSelected(): Promise<void> {
    this.isTransferingBulk = true;
    this.store.dispatch(appStateActions.setSlideoutActive({ slideoutActive: true }));

    const { inEscrow, notInEscrow, invalid } = await this.checkSelected();
    this.deselected = [ ...inEscrow, ...invalid ];

    const formArray = this.fb.array(notInEscrow.map((item: MarketItem) => this.fb.group({
      tokenId: [item.tokenId],
      hashId: [item.hashId],
      sha: [item.sha],
      listPrice: [''],
    }))) as FormArray;

    this.bulkActionsForm.setControl('transferItems', formArray);
    this.selectedMarketItemsFormArray = this.bulkActionsForm.get('transferItems') as FormArray;

    setTimeout(() => this.transferAddressInput.nativeElement.focus(), 100);
  }

  /**
   * Prepares the UI for bulk listing of selected items
   * Filters out items that are not in escrow, then sets up the form
   */
  async listSelected(): Promise<void> {
    this.isListingBulk = true;
    this.store.dispatch(appStateActions.setSlideoutActive({ slideoutActive: true }));

    const { inEscrow, notInEscrow } = await this.checkSelected();
    this.deselected = notInEscrow;

    const formArray = this.fb.array(inEscrow.map((item: MarketItem) => this.fb.group({
      tokenId: [item.tokenId],
      hashId: [item.hashId],
      sha: [item.sha],
      listing: [item.listing],
      listPrice: [''],
    }))) as FormArray;

    this.bulkActionsForm.setControl('listingItems', formArray);
    this.selectedMarketItemsFormArray = this.bulkActionsForm.get('listingItems') as FormArray;
  }

  /**
   * Prepares the UI for bulk escrow of selected items
   * Filters out items that are already in escrow or invalid, then sets up the form
   */
  async escrowSelected(): Promise<void> {
    this.isEscrowingBulk = true;
    this.store.dispatch(appStateActions.setSlideoutActive({ slideoutActive: true }));

    const { inEscrow, notInEscrow, invalid } = await this.checkSelected();
    this.deselected = [ ...inEscrow, ...invalid ];

    const formArray = this.fb.array(notInEscrow.map((item: MarketItem) => this.fb.group({
      tokenId: [item.tokenId],
      hashId: [item.hashId],
      slug: [item.slug],
      sha: [item.sha],
      listPrice: [''],
    }))) as FormArray;

    this.bulkActionsForm.setControl('escrowItems', formArray);
    this.selectedMarketItemsFormArray = this.bulkActionsForm.get('escrowItems') as FormArray;
  }

  /**
   * Prepares the UI for bulk withdrawal of selected items
   * Filters out items that are not in escrow, then sets up the form
   */
  async withdrawSelected(): Promise<void> {
    this.isWithdrawingBulk = true;
    this.store.dispatch(appStateActions.setSlideoutActive({ slideoutActive: true }));

    const { inEscrow, notInEscrow, invalid, inVenueEscrow } = await this.checkSelected();
    const venueWithdrawable = await this.filterVenueWithdrawable(inVenueEscrow);
    const withdrawable = [...inEscrow, ...venueWithdrawable];
    this.deselected = [...notInEscrow, ...invalid.filter((item) => !withdrawable.includes(item))];

    const formArray = this.fb.array(withdrawable.map((item: MarketItem) => this.fb.group({
      tokenId: [item.tokenId],
      hashId: [item.hashId],
      sha: [item.sha],
      listing: [item.listing],
      listPrice: [''],
    }))) as FormArray;

    this.bulkActionsForm.setControl('withdrawItems', formArray);
    this.selectedMarketItemsFormArray = this.bulkActionsForm.get('withdrawItems') as FormArray;
  }

  /**
   * Submits a batch transfer transaction for selected items
   * Validates the transfer address and executes the blockchain transaction
   */
  async submitBatchTransfer(): Promise<void> {

    if (!this.bulkActionsForm.value.transferItems) return;
    const hashIds = this.bulkActionsForm.value.transferItems.map((item: any) => item.hashId);

    if (!hashIds?.length) return;
    if (!this.transferAddress.value) return;

    let notification: Notification = {
      id: this.utilSvc.createIdFromString('transferHash' + hashIds.map((hashId: string) => hashId.substring(2)).join('')),
      timestamp: Date.now(),
      type: 'wallet',
      function: 'transferHash',
      hashId: hashIds[0],
      hashIds,
      isBatch: true,
    };

    this.store.dispatch(upsertNotification({ notification }));
    this.closeSlideout();

    try {
      let toAddress: string | null = this.transferAddress.value;
      toAddress = await this.web3Svc.verifyAddressOrEns(toAddress);
      if (!toAddress) throw new Error('Invalid address');

      const hash = await this.web3Svc.batchTransferHashes(hashIds, toAddress);
      if (!hash) throw new Error('Transaction failed');

      notification = {
        ...notification,
        type: 'pending',
        hash,
      };
      this.store.dispatch(upsertNotification({ notification }));

      const receipt = await this.web3Svc.pollReceipt(hash!);
      notification = {
        ...notification,
        type: 'complete',
        hash: receipt.transactionHash,
      };
      this.store.dispatch(upsertNotification({ notification }));
      this.clearSelectedAndClose();
    } catch (err) {
      console.log(err);
      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
      this.store.dispatch(upsertNotification({ notification }));
    }
  }

  /**
   * Submits a batch listing transaction for selected items
   * Validates listing prices and executes the blockchain transaction
   */
  async submitBatchListing(): Promise<void> {
    if (!this.bulkActionsForm.value.listingItems) return;

    const newListings = this.bulkActionsForm.value.listingItems
      .filter((item: any) => item.listPrice);

    if (!newListings.length) return;

    const listings = newListings.map((item: any) => ({ hashId: item.hashId, listPrice: item.listPrice }))|| [];
    const hashIds = newListings.map((item: any) => item.hashId) || [];

    if (!hashIds?.length) return;

    let notification: Notification = {
      id: this.utilSvc.createIdFromString('offerHashForSale' + hashIds.map((hashId: string) => hashId.substring(2)).join('')),
      timestamp: Date.now(),
      type: 'wallet',
      function: 'offerHashForSale',
      hashId: hashIds[0],
      hashIds,
      isBatch: true,
    };

    this.store.dispatch(upsertNotification({ notification }));
    this.closeSlideout();

    try {
      const hash = await this.web3Svc.batchOfferHashForSale(
        listings.map(item => item.hashId),
        listings.map(item => item.listPrice)
      );
      if (!hash) throw new Error('Transaction failed');

      notification = {
        ...notification,
        type: 'pending',
        hash,
      };
      this.store.dispatch(upsertNotification({ notification }));

      const receipt = await this.web3Svc.pollReceipt(hash!);
      notification = {
        ...notification,
        type: 'complete',
        hash: receipt.transactionHash,
      };
      this.store.dispatch(upsertNotification({ notification }));

      this.clearSelectedAndClose();
    } catch (err) {
      console.log(err);
      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
      this.store.dispatch(upsertNotification({ notification }));
    }
  }

  /**
   * Submits a batch escrow transaction for selected items
   * Transfers items to the escrow contract address
   */
  async submitBatchEscrow(): Promise<void> {
    if (!this.bulkActionsForm.value.escrowItems) return;

    const { notInEscrow } = await this.checkSelected();

    const selected: { [string: MarketItem['hashId']]: MarketItem } = {};
    notInEscrow.forEach((item: MarketItem) => selected[item.hashId] = item);
    this.selected = selected;

    const hashIds = Object.values(selected).map((item: MarketItem) => item.hashId);
    const hexString = Object.keys(selected).map(hashId => hashId?.substring(2)).join('');

    const hex = `0x${hexString}`;

    let notification: Notification = {
      id: this.utilSvc.createIdFromString('sendToEscrow' + hashIds.map((hashId: string) => hashId.substring(2)).join('')),
      timestamp: Date.now(),
      type: 'wallet',
      function: 'sendToEscrow',
      hashId: hashIds[0],
      hashIds,
      isBatch: true,
    }

    this.store.dispatch(upsertNotification({ notification }));
    this.closeSlideout();

    try {
      if (!hashIds?.length || hex === '0x') throw new Error('Invalid selection');

      const hash = await this.web3Svc.transferHash(hex, this.escrowAddress);
      if (!hash) throw new Error('Transaction failed');

      notification = {
        ...notification,
        type: 'pending',
        hash,
      };
      this.store.dispatch(upsertNotification({ notification }));

      const receipt = await this.web3Svc.pollReceipt(hash!);
      notification = {
        ...notification,
        type: 'complete',
        hash: receipt.transactionHash,
      };
      this.store.dispatch(upsertNotification({ notification }));
      this.clearSelectedAndClose();
    } catch (err) {
      console.log(err);
      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
      this.store.dispatch(upsertNotification({ notification }));
    }
  }

  /**
   * Submits a batch withdrawal transaction for selected items
   * Withdraws items from the escrow contract back to the user's wallet
   */
  async submitBatchWithdraw(): Promise<void> {
    if (!this.bulkActionsForm.value.withdrawItems) return;

    const { inEscrow, inVenueEscrow } = await this.checkSelected();
    const venueItems = await this.filterVenueWithdrawable(inVenueEscrow);

    const selected: { [string: MarketItem['hashId']]: MarketItem } = {};
    inEscrow.forEach((item: MarketItem) => selected[item.hashId] = item);
    this.selected = selected;

    // Other markets first: each needs its own transaction(s), sent from the user's wallet.
    if (venueItems.length) {
      this.closeSlideout();
      await this.withdrawFromVenues(venueItems);
      if (!inEscrow.length) {
        this.clearSelectedAndClose();
        return;
      }
    }

    const hashIds = Object.values(selected).map((item: MarketItem) => item.hashId);

    let notification: Notification = {
      id: this.utilSvc.createIdFromString('withdrawHash' + hashIds.map((hashId: string) => hashId.substring(2)).join('')),
      timestamp: Date.now(),
      type: 'wallet',
      function: 'withdrawHash',
      hashId: hashIds[0],
      hashIds,
      isBatch: true,
    };

    this.store.dispatch(upsertNotification({ notification }));
    this.closeSlideout();

    try {
      if (!hashIds?.length) throw new Error('Invalid selection');

      const hash = await this.web3Svc.withdrawBatchHashes(Object.keys(selected));
      if (!hash) throw new Error('Transaction failed');

      notification = {
        ...notification,
        type: 'pending',
        hash,
      };
      this.store.dispatch(upsertNotification({ notification }));

      const receipt = await this.web3Svc.pollReceipt(hash!);
      notification = {
        ...notification,
        type: 'complete',
        hash: receipt.transactionHash,
      };
      this.store.dispatch(upsertNotification({ notification }));
      this.clearSelectedAndClose();
    } catch (err) {
      console.log(err);
      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
      this.store.dispatch(upsertNotification({ notification }));
    }
  }

  /**
   * Submits a batch buy transaction for selected items
   * Purchases multiple items that are currently listed for sale
   */
  async submitBatchBuy(): Promise<void> {
    if (!this.bulkActionsForm.value.buyItems) return;

    const { inEscrow } = await this.checkSelected(true);

    const selected: { [string: MarketItem['hashId']]: MarketItem } = {};
    inEscrow.forEach((item: MarketItem) => selected[item.hashId] = item);
    this.selected = selected;

    const hashIds = Object.keys(selected);

    let notification: Notification = {
      id: this.utilSvc.createIdFromString('buyHash' + hashIds.map((hashId: string) => hashId.substring(2)).join('')),
      timestamp: Date.now(),
      type: 'wallet',
      function: 'buyHash',
      hashId: hashIds[0],
      hashIds,
      isBatch: true,
    };

    this.store.dispatch(upsertNotification({ notification }));
    this.closeSlideout();

    try {
      if (!hashIds?.length) throw new Error('One or more items are no longer for sale.');

      const hash = await this.web3Svc.batchBuyHashes(Object.values(selected));
      if (!hash) throw new Error('Transaction failed');

      notification = {
        ...notification,
        type: 'pending',
        hash,
      };
      this.store.dispatch(upsertNotification({ notification }));

      const receipt = await this.web3Svc.pollReceipt(hash!);
      notification = {
        ...notification,
        type: 'complete',
        hash: receipt.transactionHash,
      };
      this.store.dispatch(upsertNotification({ notification }));
      this.clearSelectedAndClose();
    } catch (err) {
      console.log(err);
      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
      this.store.dispatch(upsertNotification({ notification }));
    }
  }

  /**
   * Handles changes to the selected items collection
   * Updates the total value and available actions based on the current selection
   * @param $event - The selection change event
   */
  selectedChange($event: any): void {
    this.selectedValue = Object.values(this.selected).reduce(
      (acc: number, item: MarketItem) => acc += Number(item.listing?.minValue || '0'),
    0).toString();

    this.actionsState = {
      canList: false,
      canTransfer: false,
      canWithdraw: false,
      canEscrow: false,
    };

    Object.values(this.selected).forEach((item: MarketItem) => {
      // console.log({item});
      if (item.escrowVenue) {
        // Held by another market: withdrawing it from there is the only bulk action.
        if (getExternalEscrowByVenue(item.escrowVenue)?.canWithdraw) this.actionsState.canWithdraw = true;
      } else if (item.isEscrowed) {
        this.actionsState.canWithdraw = true;
        this.actionsState.canList = true;
      } else {
        this.actionsState.canTransfer = true;
        this.actionsState.canEscrow = true;
      };
    });
    this.actionsState = { ...this.actionsState };
  }

  /**
   * Toggles the multiple selection mode on/off
   * Clears any existing selections when disabling multiple selection
   */
  setSelectActive() {
    this.selectMultipleActive = !this.selectMultipleActive;
    this.selectAll = false;
    if (!this.selectMultipleActive) {
      this.selected = {};
      this.deselected = [];
    }
    this.filtersVisible = false;
  }

  /**
   * Clears all selected items and closes the selection mode
   * Resets the actions state to default values
   */
  clearSelectedAndClose() {
    this.selectMultipleActive = false;
    this.selectAll = false;
    this.selected = {};
    this.actionsState = defaultActionState;
  }

  /**
   * Closes the slideout panel by dispatching the appropriate action
   */
  closeSlideout(): void {
    this.store.dispatch(appStateActions.setSlideoutActive({ slideoutActive: false }));
  }

  /**
   * Copies the list price from one form control to the next
   * @param index - The index of the current form control
   */
  copyToNext(index: number) {
    this.selectedMarketItemsFormArray.controls[index + 1].get('listPrice')?.setValue(
      this.selectedMarketItemsFormArray.controls[index].get('listPrice')?.value
    );
  }

  /**
   * Resets all bulk action states and form arrays
   * Called when the slideout is closed or actions are completed
   */
  resetState() {
    this.isListingBulk = false;
    this.isTransferingBulk = false;
    this.isEscrowingBulk = false;
    this.isWithdrawingBulk = false;
    this.isBuyingBulk = false;
    this.selectedMarketItemsFormArray = this.fb.array([]);
  }

  /**
   * Validates and categorizes selected items based on their escrow status and ownership
   * @param removeOwnedItems - Whether to filter out items owned by the current user
   * @returns Object containing arrays of items categorized by their status
   */
  async checkSelected(
    removeOwnedItems = false
  ): Promise<{ notInEscrow: MarketItem[], inEscrow: MarketItem[], invalid: MarketItem[], inVenueEscrow: MarketItem[] }> {

    let selected = Object.values(this.selected);
    let invalid: MarketItem[] = [];

    if (removeOwnedItems) {
      [ selected, invalid ] = await this.filterOwnedItems(selected);
    }

    [ selected, invalid ] = await this.filterLockedItems(selected);

    selected = await this.dataSvc.checkConsensus(Object.values(selected));

    const consensusInvalid = selected.filter((item: MarketItem) => item.consensus === false);
    invalid = [...invalid, ...consensusInvalid];

    const inEscrow = selected.filter(
      (item: MarketItem) => item.owner.toLowerCase() === environment.marketAddress.toLowerCase()
    );

    // Items another market holds for the user can only be withdrawn from that market, so they
    // are invalid for every Mingo Mart action (transfer, escrow, list, buy).
    const inVenueEscrow = selected.filter((item: MarketItem) => !!getExternalEscrow(item.owner));
    invalid = [...invalid, ...inVenueEscrow];

    const notInEscrow = selected.filter(
      (item: MarketItem) =>
        item.owner.toLowerCase() !== environment.marketAddress.toLowerCase()
        && !getExternalEscrow(item.owner)
    );

    // console.log({ notInEscrow, inEscrow, invalid });
    return { notInEscrow, inEscrow, invalid, inVenueEscrow };
  }

  /**
   * Keeps the items another market holds for the connected wallet that can be withdrawn from
   * there right now. Etch's contract cannot check the caller, so the previous owner must match.
   */
  async filterVenueWithdrawable(items: MarketItem[]): Promise<MarketItem[]> {
    const walletAddress = (await this.web3Svc.getCurrentAddress())?.toLowerCase();
    const enabled: Record<string, boolean> = {};
    const result: MarketItem[] = [];
    for (const item of items) {
      const escrow = getExternalEscrow(item.owner);
      if (!escrow?.canWithdraw || item.prevOwner?.toLowerCase() !== walletAddress) continue;
      enabled[escrow.venue] ??= await this.web3Svc.isVenueWithdrawEnabled(escrow.venue);
      if (enabled[escrow.venue]) result.push(item);
    }
    return result;
  }

  /**
   * Withdraws items from the other markets holding them: one transaction per market when it
   * supports batches, otherwise one per item.
   */
  async withdrawFromVenues(items: MarketItem[]): Promise<void> {
    const byVenue = new Map<ExternalEscrowVenue, MarketItem[]>();
    for (const item of items) {
      const escrow = getExternalEscrow(item.owner);
      if (!escrow) continue;
      byVenue.set(escrow.venue, [...(byVenue.get(escrow.venue) || []), item]);
    }

    for (const [venue, venueItems] of byVenue) {
      const groups = getExternalEscrowByVenue(venue)?.canBatchWithdraw
        ? [venueItems]
        : venueItems.map((item) => [item]);

      for (const group of groups) {
        const hashIds = group.map((item) => item.hashId);
        let notification: Notification = {
          id: this.utilSvc.createIdFromString('withdrawFromVenue' + venue + hashIds.map((hashId) => hashId.substring(2)).join('')),
          timestamp: Date.now(),
          type: 'wallet',
          function: 'withdrawFromVenue',
          venue,
          slug: group[0].slug,
          tokenId: group[0].tokenId,
          hashId: hashIds[0],
          hashIds,
          isBatch: hashIds.length > 1,
        };
        this.store.dispatch(upsertNotification({ notification }));

        try {
          const hash = await this.web3Svc.withdrawFromVenue(venue, hashIds);
          if (!hash) throw new Error('Transaction failed');
          notification = { ...notification, type: 'pending', hash };
          this.store.dispatch(upsertNotification({ notification }));

          const receipt = await this.web3Svc.pollReceipt(hash);
          notification = { ...notification, type: 'complete', hash: receipt.transactionHash };
          this.store.dispatch(upsertNotification({ notification }));
        } catch (err) {
          console.log(err);
          notification = { ...notification, type: 'error', detail: err };
          this.store.dispatch(upsertNotification({ notification }));
        }
      }
    }
  }

  /**
   * Filters out items that are bridged/locked and cannot be traded
   * @param items - Array of items to filter
   * @returns Tuple containing valid and invalid items
   */
  async filterLockedItems(items: MarketItem[]): Promise<[MarketItem[], MarketItem[]]> {
    let validItems: MarketItem[] = [];
    let invalidItems: MarketItem[] = [];

    validItems = items.filter(item => !item.isBridged);
    invalidItems = items.filter(item => item.isBridged);
    return [validItems, invalidItems];
  }

  /**
   * Filters out items that are owned by the current user
   * @param items - Array of items to filter
   * @returns Tuple containing valid and invalid items
   */
  async filterOwnedItems(items: MarketItem[]): Promise<[MarketItem[], MarketItem[]]> {
    const walletAddress = (await this.web3Svc.getCurrentAddress())?.toLowerCase();
    const marketAddress = environment.marketAddress.toLowerCase();
    let validItems: MarketItem[] = [];
    let invalidItems: MarketItem[] = [];

    items.forEach(item => {
      const owner = item.owner.toLowerCase();
      if (
        (owner === marketAddress && item.prevOwner === walletAddress) ||
        owner === walletAddress
      ) {
        invalidItems.push(item);
      } else {
        validItems.push(item);
      }
    });

    return [validItems, invalidItems];
  }

  /**
   * Toggles the visibility of the filters panel
   * Disables multiple selection mode when showing filters
   */
  toggleFilters() {
    this.filtersVisible = !this.filtersVisible;
    this.selectMultipleActive = false;
  }
}
