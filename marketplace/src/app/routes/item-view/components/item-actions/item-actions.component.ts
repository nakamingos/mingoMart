import { Component, ElementRef, input, QueryList, signal, ViewChild, ViewChildren } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';

import { Store } from '@ngrx/store';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom, map, switchMap } from 'rxjs';
import { signTypedData } from '@wagmi/core';

import { MarketItem } from '@/models/db';
import { GlobalState, Notification } from '@/models/global-state';

import { Web3Service } from '@/services/web3.service';
import { UtilService } from '@/services/util.service';
import { DataService } from '@/services/data.service';

import { selectConfig, selectCooldowns, selectWalletAddress } from '@/state/app/app-state.selectors';
import { upsertNotification } from '@/state/notification/notification.actions';
import { addCooldown } from '@/state/app/app-state.actions';
import { selectNotifications } from '@/state/notification/notification.selectors';
import { setCreateConversationWithAddress } from '@/state/chat/chat.actions';

import { environment } from '@environments/environment';

interface ActionsState {
  sell: boolean;
  withdraw: boolean;
  transfer: boolean;
  escrow: boolean;
  bridge: boolean;
  privateSale: boolean;
  auction: boolean;
  auctionAdvancedOptions: boolean;
};

@Component({
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    FormsModule,
    ReactiveFormsModule,
  ],
  selector: 'app-item-actions',
  templateUrl: './item-actions.component.html',
  styleUrls: ['./item-actions.component.scss'],
})
export class ItemActionsComponent {

  item = input.required<MarketItem>();
  item$ = toObservable(this.item);

  disabled = input.required<boolean>();
  disabled$ = toObservable(this.disabled);

  // Other Forms
  @ViewChild('sellPriceInput') sellPriceInput!: ElementRef<HTMLInputElement>;
  @ViewChild('transferAddressInput') transferAddressInput!: ElementRef<HTMLInputElement>;
  // @ViewChild('revShareInput') revShareInput!: ElementRef<HTMLInputElement>;

  // Auction Forms
  @ViewChild('auctionDurationDaysInput') auctionDurationDaysInput!: ElementRef<HTMLInputElement>;
  @ViewChild('auctionDurationHoursInput') auctionDurationHoursInput!: ElementRef<HTMLInputElement>;
  @ViewChild('auctionDurationMinutesInput') auctionDurationMinutesInput!: ElementRef<HTMLInputElement>;

  @ViewChild('auctionMinBidIncrementPercentageInput') auctionMinBidIncrementPercentageInput!: ElementRef<HTMLInputElement>;
  @ViewChild('auctionTimeBufferMinutesInput') auctionTimeBufferMinutesInput!: ElementRef<HTMLInputElement>;

  // Collapsable
  @ViewChildren('collapsable') collapsable!: QueryList<ElementRef<HTMLDivElement>>;

  actionsState = signal<ActionsState>({
    sell: false,
    withdraw: false,
    transfer: false,
    escrow: false,
    bridge: false,
    privateSale: false,
    auction: false,
    auctionAdvancedOptions: false,
  });

  walletAddress$ = this.store.select(selectWalletAddress);

  pendingTx$ = this.store.select(selectNotifications).pipe(
    filter((transactions) => !!transactions),
    switchMap((transactions) => this.item$.pipe(
      filter((item) => !!item),
      map((item) => transactions.filter((tx) => tx?.hashId === item?.hashId && (tx.type === 'pending' || tx.type === 'wallet'))[0]),
    )),
  );

  config$ = this.store.select(selectConfig);
  isCooling$ = this.store.select(selectCooldowns).pipe(
    // tap((cooldowns) => console.log('isCooling$', cooldowns)),
    filter((cooldowns) => !!cooldowns),
    switchMap((cooldowns) => this.item$.pipe(
      map((item) => cooldowns[item?.hashId || ''] > 0),
    )),
  );

  transferAddress = new FormControl<string | null>('');
  listPrice = new FormControl<number | undefined>(undefined);

  auctionDuration = new FormGroup({
    days: new FormControl<number>(0, {nonNullable: true}),
    hours: new FormControl<number>(0, {nonNullable: true}),
    minutes: new FormControl<number>(0, {nonNullable: true}),
  });

  auctionMinBidIncrementPercentage = new FormControl<number | undefined>(undefined);
  auctionTimeBufferMinutes = new FormControl<number | undefined>(undefined);
  listToAddress = new FormControl<string | null>('');
  // revShare = new FormControl<number | undefined>(undefined);

  chainId = environment.chainId;
  isDev = !environment.production;
  escrowAddress = environment.marketAddress;
  externalMarketUrl = environment.externalMarketUrl;
  bridgeAddress = environment.bridgeAddress;

  constructor(
    private store: Store<GlobalState>,
    private http: HttpClient,
    public web3Svc: Web3Service,
    private utilSvc: UtilService,
    public dataSvc: DataService,
  ) {}

  /**
   * Opens the sell form for listing an item for sale
   * Closes all other action forms and focuses the price input
   */
  sellAction(): void {
    this.closeAll();
    this.actionsState.update((state) => ({ ...state, sell: true }));
    setTimeout(() => this.sellPriceInput?.nativeElement.focus(), 0);
  }

  /**
   * Opens the escrow form for sending an item to the escrow contract
   * Closes all other action forms
   */
  escrowAction(): void {
    this.closeAll();
    this.actionsState.update((state) => ({ ...state, escrow: true }));
  }

  /**
   * Opens the transfer form for transferring an item to another address
   * Closes all other action forms and focuses the address input
   */
  transferAction(): void {
    this.closeAll();
    this.actionsState.update((state) => ({ ...state, transfer: true }));
    setTimeout(() => this.transferAddressInput?.nativeElement.focus(), 0);
  }

  /**
   * Opens the bridge form for bridging an item to another chain
   * Closes all other action forms
   */
  bridgeAction(): void {
    this.closeAll();
    this.actionsState.update((state) => ({ ...state, bridge: true }));
  }

  /**
   * Opens the private sale form for selling an item to a specific address
   * Does not close other forms as it's typically used in conjunction with sell form
   */
  privateSaleAction(): void {
    this.actionsState.update((state) => ({ ...state, privateSale: true }));
  }

  /**
   * Opens the auction form for creating an auction for an item
   * Closes all other action forms
   */
  auctionAction(): void {
    this.closeAll();
    this.actionsState.update((state) => ({ ...state, auction: true }));
  }

  /**
   * Opens the advanced auction options form
   * Does not close other forms as it's used in conjunction with auction form
   */
  auctionAdvancedOptionsAction(): void {
    this.actionsState.update((state) => ({ ...state, auctionAdvancedOptions: true }));
  }

  /**
   * Closes the sell/listing form and clears all form data
   * Also closes the private sale form as it's related
   */
  closeListing(): void {
    this.actionsState.update((state) => ({ ...state, sell: false }));
    this.closePrivateSale();
    this.clearAll();
  }

  /**
   * Closes the escrow form
   */
  closeEscrow(): void {
    this.actionsState.update((state) => ({ ...state, escrow: false }));
  }

  /**
   * Closes the transfer form and clears all form data
   */
  closeTransfer(): void {
    this.actionsState.update((state) => ({ ...state, transfer: false }));
    this.clearAll();
  }

  /**
   * Closes the bridge form
   */
  closeBridge(): void {
    this.actionsState.update((state) => ({ ...state, bridge: false }));
  }

  /**
   * Closes the private sale form
   */
  closePrivateSale(): void {
    this.actionsState.update((state) => ({ ...state, privateSale: false }));
  }

  /**
   * Closes the auction form and clears all form data
   * Also closes the advanced auction options form
   */
  closeAuction(): void {
    this.actionsState.update((state) => ({ ...state, auction: false }));
    this.closeAuctionAdvancedOptions();
    this.clearAll();
  }

  /**
   * Closes the advanced auction options form
   */
  closeAuctionAdvancedOptions(): void {
    this.actionsState.update((state) => ({ ...state, auctionAdvancedOptions: false }));
  }

  /**
   * Resets all form controls to their default values
   * Clears all input fields across all action forms
   */
  clearAll(): void {
    this.listPrice.reset();
    this.listToAddress.reset();
    this.transferAddress.reset();
    this.auctionMinBidIncrementPercentage.reset();
    this.auctionTimeBufferMinutes.reset();

    this.auctionDuration.reset();
  }

  /**
   * Closes all action forms and clears all form data
   * Used when opening a new action form to ensure only one is open at a time
   */
  closeAll(): void {
    this.closeListing();
    this.closeTransfer();
    this.closeEscrow();
    this.closeBridge();
    this.closeAuction();
  }

  /**
   * Submits a listing for an item to be sold on the marketplace
   * Handles both escrowed and non-escrowed items, as well as L1 and L2 variants
   * Supports private sales to specific addresses and ENS name resolution
   *
   * @throws {Error} If hashId is invalid or consensus is not reached
   */
  async submitListing(): Promise<void> {
    const item = this.item();
    const hashId = item.hashId;

    if (!hashId) throw new Error('Invalid hashId');
    if (!this.listPrice.value) return;

    const value = this.listPrice.value;
    // const revShare = (this.revShare.value || 0) * 1000;
    let address = this.listToAddress.value || undefined;

    // console.log({hashId, value, address});

    let notification: Notification = {
      id: this.utilSvc.createIdFromString('offerHashForSale' + hashId),
      timestamp: Date.now(),
      slug: item.slug,
      type: 'wallet',
      function: 'offerHashForSale',
      hashId,
      tokenId: item.tokenId,
      value,
    };

    this.store.dispatch(upsertNotification({ notification }));

    try {
      await this.checkConsenus(item);

      if (address) {
        if (address?.endsWith('.eth')) {
          const ensOwner = await this.web3Svc.getEnsOwner(address);
          if (!ensOwner) throw new Error('ENS name not registered');
          address = ensOwner;
        }
        const validAddress = this.web3Svc.verifyAddress(address);
        if (!validAddress) throw new Error('Invalid address');
      }

      let hash;
      if (item.isEscrowed) {
        hash = await this.web3Svc.offerHashForSale(hashId, value, address);
      } else if (item.nft) {
        hash = await this.web3Svc.offerHashForSaleL2(hashId, value, address);
      } else {
        hash = await this.web3Svc.escrowAndOfferHashForSale(hashId, value, address);
      }

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

      this.store.dispatch(addCooldown({ cooldown: { [hashId]: Number(receipt.blockNumber) }}));
      this.clearAll();
    } catch (err) {
      console.log(err);

      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
    } finally {
      this.store.dispatch(upsertNotification({ notification }));
    }
  }

  /**
   * Sends an item to the escrow contract
   * Required before listing items for sale on the marketplace
   *
   * @throws {Error} If hashId is invalid or consensus is not reached
   */
  async sendToEscrow(): Promise<void> {
    const item = this.item();
    const hashId = item.hashId;

    if (!hashId) throw new Error('Invalid hashId');

    let notification: Notification = {
      id: this.utilSvc.createIdFromString('sendToEscrow' + hashId),
      timestamp: Date.now(),
      slug: item.slug,
      type: 'wallet',
      function: 'sendToEscrow',
      hashId,
      tokenId: item.tokenId,
    };

    this.store.dispatch(upsertNotification({ notification }));

    try {
      await this.checkConsenus(item);

      const tokenId = item.hashId;
      const hash = await this.web3Svc.sendEthscriptionToContract(tokenId);

      notification = {
        ...notification,
        type: 'pending',
        hash,
      };
      this.store.dispatch(upsertNotification({ notification }));

      const receipt = await this.web3Svc.pollReceipt(hash!);
      // this.setNotificationCompleteMessage(receipt);
      notification = {
        ...notification,
        type: 'complete',
        hash: receipt.transactionHash,
      };

      this.store.dispatch(addCooldown({ cooldown: { [hashId]: Number(receipt.blockNumber) }}));
    } catch (err) {
      console.log(err);

      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
    } finally {
      this.store.dispatch(upsertNotification({ notification }));
    }
  }

  /**
   * Removes an item from sale on the marketplace
   * Handles both L1 and L2 variants of items
   *
   * @throws {Error} If hashId is invalid or transaction cannot be processed
   */
  async hashNoLongerForSale(): Promise<void> {
    const item = this.item();
    const hashId = item.hashId;
    if (!hashId) throw new Error('Invalid hashId');

    let notification: Notification = {
      id: this.utilSvc.createIdFromString('hashNoLongerForSale' + hashId),
      timestamp: Date.now(),
      slug: item.slug,
      type: 'wallet',
      function: 'hashNoLongerForSale',
      hashId,
      tokenId: item.tokenId,
    };

    this.store.dispatch(upsertNotification({ notification }));

    try {

      let hash;
      if (item.nft) {
        hash = await this.web3Svc.hashNoLongerForSaleL2(hashId);
      } else {
        hash = await this.web3Svc.hashNoLongerForSale(hashId);
      }
      if (!hash) throw new Error('Could not process transaction');

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

      this.store.dispatch(addCooldown({ cooldown: { [hashId]: Number(receipt.blockNumber) }}));
    } catch (err) {
      console.log(err);

      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
    } finally {
      this.store.dispatch(upsertNotification({ notification }));
    }
  }

  /**
   * Purchases an item that is currently listed for sale
   * Handles both L1 and L2 variants, using batch purchase for L1 items
   *
   * @throws {Error} If hashId is invalid, consensus is not reached, or prevOwner is invalid
   */
  async buyHash(): Promise<void> {
    const item = this.item();
    const hashId = item.hashId;
    if (!hashId) throw new Error('Invalid hashId');

    const value = item.listing?.minValue;

    let notification: Notification = {
      id: this.utilSvc.createIdFromString('buyHash' + hashId),
      timestamp: Date.now(),
      slug: item.slug,
      type: 'wallet',
      function: 'buyHash',
      hashId,
      tokenId: item.tokenId,
      value: Number(this.web3Svc.weiToEth(value)),
    };

    this.store.dispatch(upsertNotification({ notification }));

    try {
      await this.checkConsenus(item);
      if (!item.prevOwner) throw new Error('Invalid prevOwner');

      let hash: string | undefined = undefined;
      if (item.nft) {
        hash = await this.web3Svc.buyHashL2(hashId);
      } else {
        hash = await this.web3Svc.batchBuyHashes([item]);
      }

      if (!hash) throw new Error('Could not process transaction');

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

      this.store.dispatch(addCooldown({ cooldown: { [hashId]: Number(receipt.blockNumber) }}));
    } catch (err) {
      console.log(err);

      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
    } finally {
      this.store.dispatch(upsertNotification({ notification }));
    }
  }

  /**
   * Transfers an item to another address
   * Supports ENS name resolution for the destination address
   *
   * @throws {Error} If hashId is invalid, address is invalid, or consensus is not reached
   */
  async transferHash(): Promise<void> {
    const item = this.item();
    const hashId = item.hashId;
    if (!hashId) throw new Error('Invalid hashId');

    let notification: Notification = {
      id: this.utilSvc.createIdFromString('transferHash' + hashId),
      timestamp: Date.now(),
      slug: item.slug,
      type: 'wallet',
      function: 'transferHash',
      hashId,
      tokenId: item.tokenId,
    };

    try {
      let toAddress: string | null = this.transferAddress.value;
      console.log({toAddress});
      toAddress = await this.web3Svc.verifyAddressOrEns(toAddress);
      console.log({toAddress});
      if (!toAddress) throw new Error('Invalid address');

      this.closeTransfer();
      this.store.dispatch(upsertNotification({ notification }));

      await this.checkConsenus(item);

      const hash = await this.web3Svc.transferHash(hashId, toAddress);
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

      this.store.dispatch(addCooldown({ cooldown: { [hashId]: Number(receipt.blockNumber) }}));
    } catch (err) {
      console.log(err);
      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
    } finally {
      this.store.dispatch(upsertNotification({ notification }));
      this.clearAll();
    }
  }

  /**
   * Withdraws an item from the escrow contract back to the owner's wallet
   *
   * @throws {Error} If hashId is invalid or transaction cannot be processed
   */
  async withdrawHash(): Promise<void> {
    const item = this.item();
    const hashId = item.hashId;
    if (!hashId) throw new Error('Invalid hashId');

    let notification: Notification = {
      id: this.utilSvc.createIdFromString('withdrawHash' + hashId),
      timestamp: Date.now(),
      slug: item.slug,
      type: 'wallet',
      function: 'withdrawHash',
      hashId,
      tokenId: item.tokenId,
    };

    try {
      this.store.dispatch(upsertNotification({ notification }));

      const hash = await this.web3Svc.withdrawHash(hashId);
      if (!hash) throw new Error('Could not process transaction');
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

      this.store.dispatch(addCooldown({ cooldown: { [hashId]: Number(receipt.blockNumber) }}));
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
   * Bridges an item to another chain using the relay service
   * Generates a nonce, creates a typed data signature, and locks the item on the current chain
   *
   * @throws {Error} If user address is invalid or bridge process fails
   */
  async bridge(): Promise<void> {
    const item = this.item();
    const hashId = item.hashId;

    const config = this.web3Svc.config;
    const chainId = config.getClient().chain.id;

    const address = await this.web3Svc.getCurrentAddress();
    if (!address) throw new Error('Invalid user address');

    let notification: Notification = {
      id: this.utilSvc.createIdFromString('bridgeOut' + hashId),
      timestamp: Date.now(),
      slug: item.slug,
      type: 'wallet',
      function: 'bridgeOut',
      hashId,
      tokenId: item.tokenId,
    };

    try {
      this.store.dispatch(upsertNotification({ notification }));

      const baseUrl = environment.relayUrl;
      const nonceUrl = `${baseUrl}/generate-nonce`;
      const nonceResult = await firstValueFrom(
        this.http.get(nonceUrl, { params: { address }, responseType: 'text' })
      );

      // const signature = await signMessage(config, {
      //   message: `Sign this message to verify ownership of the asset.\n\nAddress: ${address.toLowerCase()}\nEthscription ID: ${item.hashId}\nSHA: ${item.sha}\nNonce: ${nonceResult}\nChain ID: ${chainId}`,
      // });

      const typedData: any = {
        domain: {
          name: 'Mingo Mart 🦩',
          version: '1',
          chainId: BigInt(chainId),
        },
        message: {
          address: address as `0x${string}`,
          hashId: item.hashId,
          sha: item.sha,
          nonce: nonceResult,
          chainId: BigInt(chainId),
        },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
          ],
          Bridge: [
            { name: 'address', type: 'address' },
            { name: 'hashId', type: 'string' },
            { name: 'sha', type: 'string' },
            { name: 'nonce', type: 'string' },
            { name: 'chainId', type: 'uint256' },
          ],
        },
        primaryType: 'Bridge',
      };

      const signature = await signTypedData(config, typedData);

      const relayUrl = `${baseUrl}/bridge-phunk`;
      const relayResponse: any = await firstValueFrom(
        this.http.post(relayUrl, {
          address,
          hashId: item.hashId,
          sha: item.sha,
          signature,
          chainId,
        }, {
          headers: {
            'x-api-key': 'yY.nnrLrRQ_gL.kGWb*QRCYqs3YJNtjVGXfoNLpfwwenH@FL',
          }
        })
      );

      const hexArr = [
        relayResponse.hashId,
        relayResponse.signature.r,
        relayResponse.signature.s,
        relayResponse.signature.v,
      ];

      const hash = await this.web3Svc.lockHash(hexArr);
      if (!hash) throw new Error('Could not process transaction');
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

      // this.store.dispatch(appStateActions.addCooldown({ cooldown: { [hashId]: Number(receipt.blockNumber) }}));
    } catch (err) {
      console.log(err);
      notification = {
        ...notification,
        type: 'error',
        detail: err,
      };
      this.store.dispatch(upsertNotification({ notification }));
    } finally {
      this.closeBridge();
    }
  }

  /**
   * Creates an auction for an item with specified duration and parameters
   * Calculates total duration from days, hours, and minutes input
   *
   * @throws {Error} If hashId is invalid or auction parameters are invalid
   */
  async sendToAuction() {
    const item = this.item();
    const hashId = item.hashId;
    if (!hashId) throw new Error('Invalid hashId');

    const daysToSeconds = (this.auctionDuration.get('days')?.value || 0) * 24 * 60 * 60;
    const hoursToSeconds = (this.auctionDuration.get('hours')?.value || 0) * 60 * 60;
    const minutesToSeconds = (this.auctionDuration.get('minutes')?.value || 0) * 60;

    const duration = daysToSeconds + hoursToSeconds + minutesToSeconds;

    const timeBufferSeconds = (this.auctionTimeBufferMinutes.value || 5) * 60;
    const minBidIncrementPercentage = (this.auctionMinBidIncrementPercentage.value || 5);

    console.log('sendToAuction', {item: item.hashId, duration, minBidIncrementPercentage, timeBufferSeconds});

    if (!duration || !minBidIncrementPercentage) throw new Error('Invalid auction parameters');

    const hash = await this.web3Svc.sendToAuction(
      hashId,
      duration,
      minBidIncrementPercentage,
      timeBufferSeconds,
    );

    console.log('sendToAuction', {hash});
  }

  /**
   * Checks if consensus has been reached for an item before allowing transactions
   *
   * @param item - The item to check consensus for
   * @throws {Error} If consensus is not reached
   */
  async checkConsenus(item: MarketItem): Promise<void> {
    const res = await this.dataSvc.checkConsensus([item]);
    if (!res[0]?.consensus) throw new Error('Consensus not reached. Contact Support @NoMoreLabs');
  }

  /**
   * Initiates the creation of a chat conversation with a specific address
   * Currently hardcoded to a specific address for testing purposes
   */
  async createConversation() {
    this.store.dispatch(setCreateConversationWithAddress({ address: '0xf1Aa941d56041d47a9a18e99609A047707Fe96c7' }));
  }

  /**
   * Remints an item on the Sepolia testnet
   * Only available on Sepolia chain (chainId: 11155111)
   *
   * @throws {Error} If not on Sepolia chain, hashId is invalid, or sha is invalid
   */
  async remintItem() {
    if (environment.chainId !== 11155111) throw new Error('Reminting is only supported on Sepolia');

    const item = this.item();
    const hashId = item.hashId;
    if (!hashId) throw new Error('Invalid hashId');

    const sha = item.sha;
    if (!sha) throw new Error('Invalid sha');

    const hash = await this.web3Svc.remintItem(hashId, sha);
    if (!hash) throw new Error('Could not remint item');
  }
}
