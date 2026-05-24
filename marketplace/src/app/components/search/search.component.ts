import { Component, ElementRef, HostListener, ViewChild } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { Store } from '@ngrx/store';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';

import { NgSelectModule } from '@ng-select/ng-select';
import { firstValueFrom, tap, withLatestFrom } from 'rxjs';

import { Web3Service } from '@/services/web3.service';
import { DataService } from '@/services/data.service';

import { GlobalState, HistoryItem } from '@/models/global-state';

import * as appStateSelectors from '@/state/app/app-state.selectors';
import * as appStateActions from '@/state/app/app-state.actions';
import { selectMarketSlug } from '@/state/market/market-state.selectors';
import { setMarketSlug } from '@/state/market/market-state.actions';

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    NgSelectModule
  ],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss'
})

export class SearchComponent {

  @ViewChild('searchInput') searchInput!: ElementRef;

  searchBoxLoading: boolean = false;
  searchBoxError: boolean = false;

  theme$ = this.store.select(appStateSelectors.selectTheme);
  searchBox: FormGroup = new FormGroup({
    addressInput: new FormControl()
  });

  searchHistory$ = this.store.select(appStateSelectors.selectSearchHistory);
  historyActive$ = this.store.select(appStateSelectors.selectSearchHistoryActive);

  constructor(
    private store: Store<GlobalState>,
    private router: Router,
    private web3Svc: Web3Service,
    private dataSvc: DataService
  ) {
    router.events.pipe(
      withLatestFrom(this.store.select(appStateSelectors.selectIsSearchResult)),
      tap(([$event, isSearchResult]) => {
        if ($event instanceof NavigationEnd) {
          // console.log('NavigationEnd', {$event, isSearchResult});
          if (isSearchResult) {
            this.store.dispatch(appStateActions.setIsSearchResult({ isSearchResult: false }));
            this.searchBox.reset();
          }
        }
      })
    ).subscribe();
  }

  @HostListener('document:keydown.escape', ['$event'])
  keydownHandler($event: KeyboardEvent) {
    // console.log('keydownHandler', $event);
    this.unfocusInput();
  }

  async onSubmit($event: any): Promise<void> {
    this.searchBoxError = false;
    this.searchBoxLoading = true;

    try {
      const addressInput  = this.searchBox?.value?.addressInput?.toLowerCase();

      const is0x = addressInput?.startsWith('0x');
      const isEns = addressInput?.includes('.eth');
      const isAddress = is0x && this.web3Svc.verifyAddress(addressInput);
      const possibleHashId = is0x && addressInput.length === 66;
      const isNumber = !isNaN(Number(addressInput));

      if (!isEns && !isAddress && !possibleHashId && !isNumber) throw new Error('Invalid Search Parameters');

      const activeSlug = await firstValueFrom(this.store.select(selectMarketSlug));
      let address = addressInput;
      if (isEns) address = await this.web3Svc.getEnsOwner(addressInput);
      else address = this.web3Svc.verifyAddress(addressInput);

      if (address) await this.router.navigate(['/', activeSlug, 'market', 'owned'], { queryParams: { address }});
      else if (possibleHashId) await this.router.navigate(['/', 'details', addressInput]);
      else if (isNumber) {
        const hashId = await this.dataSvc.getHashIdFromTokenId(activeSlug, addressInput);
        if (hashId) await this.router.navigate(['/', 'details', hashId]);
        else throw new Error('Invalid Search Parameters');
      }
      else throw new Error('Invalid Search Parameters');

      // console.log({ isEns, isAddress, isTokenId, possibleHashId });
      let type = isEns ? 'ens' : isAddress ? 'address' : possibleHashId ? 'hashId' : 'unknown';

      this.store.dispatch(appStateActions.addSearchHistory({ item: { type, value: addressInput } }));
      this.store.dispatch(appStateActions.setSearchHistoryActive({ searchHistoryActive: false }));

      setTimeout(() => {
        this.store.dispatch(appStateActions.setIsSearchResult({ isSearchResult: true }));
      }, 200);
    } catch (error) {
      console.log(error);

      this.searchBoxError = true;
      this.searchBox.reset();
      setTimeout(() => this.searchBoxError = false, 5000);
    } finally {
      this.searchBoxLoading = false;
      this.unfocusInput();
    }
  }

  async onFocus($event: any): Promise<void> {
    // console.log('onFocus', $event);
    const searchHistory = await firstValueFrom(this.searchHistory$);
    if (!searchHistory.length) return;
    this.store.dispatch(appStateActions.setSearchHistoryActive({ searchHistoryActive: true }));
  }

  onBlur($event: any): void {
    // this.unfocusInput();
  }

  selectHistoryItem(item: any): void {
    // console.log('selectHistoryItem', item);
    this.searchBox.setValue({ addressInput: item });
    this.onSubmit(null);
  }

  removeHistoryItem(items: HistoryItem[], item: HistoryItem): void {
    // console.log('removeHistoryItem', item);
    this.store.dispatch(appStateActions.removeSearchHistory({ index: items.indexOf(item) }));
  }

  clearSearchHistory(): void {
    // console.log('removeAllHistory');
    this.store.dispatch(appStateActions.clearSearchHistory());
  }

  clearInput(): void {
    // console.log('clearInput');
    this.searchBox.reset();
    this.searchInput.nativeElement.focus();
  }

  unfocusInput(): void {
    this.searchInput.nativeElement.blur();
    this.store.dispatch(appStateActions.setSearchHistoryActive({ searchHistoryActive: false }));
  }
}
