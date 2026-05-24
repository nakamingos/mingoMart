import { Component, ElementRef, EventEmitter, Input, OnChanges, Output, QueryList, signal, SimpleChanges, ViewChildren } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

import { Store } from '@ngrx/store';
import { NgxPaginationModule } from 'ngx-pagination';
import { LazyLoadImageModule } from 'ng-lazyload-image';
import { WaIntersectionObserver } from '@ng-web-apis/intersection-observer';

import { GlobalState, TraitFilter } from '@/models/global-state';
import { MarketType } from '@/models/market.state';
import { ViewType } from '@/models/view-types';
import { MarketItem } from '@/models/db';

import { DataService } from '@/services/data.service';
import { normalizeDefaultBackground } from '@/constants/background-color';

import { WeiToEthPipe } from '@/pipes/wei-to-eth.pipe';
import { FormatCashPipe } from '@/pipes/format-cash.pipe';
import { SortPipe } from '@/pipes/sort.pipe';
import { AttributeFilterPipe } from '@/pipes/attribute-filter';
import { ImageUrlPipe } from '@/pipes/image-url.pipe';
import { RankPipe } from '@/pipes/rank.pipe';
import { SortOption } from '@/models/sorts.model';

import { environment } from '@environments/environment';

import * as dataStateSelectors from '@/state/data/data-state.selectors';
import * as marketStateActions from '@/state/market/market-state.actions';

@Component({
  selector: 'app-market-item-grid',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    LazyLoadImageModule,
    NgxPaginationModule,
    WaIntersectionObserver,

    WeiToEthPipe,
    FormatCashPipe,
    SortPipe,
    AttributeFilterPipe,
    ImageUrlPipe,
    RankPipe,
  ],
  host:  {
    '[class.selectable]': 'selectable',
    '[class]': 'viewType',
    '[class.narrow]': 'narrow',
  },
  templateUrl: './market-item-grid.component.html',
  styleUrls: ['./market-item-grid.component.scss']
})

export class MarketItemGridComponent implements OnChanges {

  @ViewChildren('marketItemCheck') marketItemCheck!: QueryList<ElementRef<HTMLInputElement>>;

  escrowAddress = environment.marketAddress;

  @Input() marketType!: MarketType;
  @Input() activeSort!: SortOption;
  @Input() narrow: boolean = false;

  @Input() viewType: ViewType = 'market';
  @Input() slug!: string;
  @Input() marketItemData!: MarketItem[] | null;
  @Input() total: number = 0;
  @Input() limit: number = 0;
  @Input() defaultBackground?: string | null;

  @Input() showLabels: boolean = true;
  @Input() traitFilters!: TraitFilter | null;
  @Input() observe: boolean = false;

  @Input() selectable: boolean = false;
  @Input() selectAll: boolean = false;

  @Input() walletAddress!: string | null | undefined;

  @Output() selectedChange = new EventEmitter<{ [string: MarketItem['hashId']]: MarketItem }>();
  @Input() selected: { [string: MarketItem['hashId']]: MarketItem } = {};

  limitArr: number[] = [];

  usd$ = this.store.select(dataStateSelectors.selectUsd);
  collections$ = this.store.select(dataStateSelectors.selectCollections);

  showLoadMore: boolean = false;
  ranksActive = signal(false);

  constructor(
    private store: Store<GlobalState>,
    private el: ElementRef,
    public dataSvc: DataService,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.limit) {
      this.limitArr = Array.from({length: this.limit}, (_, i) => i);
    }

    if (changes.selected && !changes.selected.firstChange) {
      this.marketItemCheck?.forEach((checkbox) => {
        const hashId = checkbox.nativeElement.dataset.hashId;
        if (!hashId) return;
        checkbox.nativeElement.checked = !!this.selected[hashId];
      });
    }

    if (changes.selectAll) {
      this.marketItemCheck?.forEach((checkbox) => {
        if (!this.marketItemData) return;
        checkbox.nativeElement.checked = this.selectAll;

        const hashId = checkbox.nativeElement.dataset.hashId;
        if (!hashId) return;

        const marketItem = this.marketItemData.find((marketItem) => marketItem.hashId === hashId);
        if (!marketItem) return;
        this.selectMarketItem(marketItem, true, !this.selectAll);
      });
    }

    if (changes.traitFilters && !changes.traitFilters.firstChange) {
      this.limit = 250;
    }

    if (changes.total && this.childrenLength() === this.total) {
      this.showLoadMore = false;
    }
  }

  selectMarketItem(
    marketItem: MarketItem,
    upsert: boolean = false,
    remove: boolean = false
  ) {
    if (remove) {
      const selected = { ...this.selected };
      delete selected[marketItem.hashId];
      this.selected = selected;
      this.selectedChange.emit(this.selected);
      return;
    }

    if (upsert) {
      if (!this.selected[marketItem.hashId]) this.selected[marketItem.hashId] = marketItem;
    } else {
      if (this.selected[marketItem.hashId]) {
        const selected = { ...this.selected };
        delete selected[marketItem.hashId];
        this.selected = selected;
      } else {
        this.selected[marketItem.hashId] = marketItem;
      }
    }

    this.selectedChange.emit(this.selected);
  }

  onIntersection($event: IntersectionObserverEntry[]): void {
    if (!this.observe || !this.marketItemData) return;

    $event.forEach((entry) => {
      if (entry.isIntersecting) {

        const target = entry.target as HTMLElement;
        const index = Number(target.dataset.index) + 1;
        const limit = this.limit;

        // console.log({
        //   children: this.childrenLength(),
        //   index,
        //   limit,
        //   total: this.total,
        // });

        if (index >= (this.childrenLength() - 50)) {
          this.limit = this.limit >= this.total ? this.total : this.childrenLength() + 250;
        }

        this.showLoadMore = this.childrenLength() < this.limit || this.childrenLength() !== this.total;
      }
    });
  }

  loadMore() {
    if (this.marketType === 'all') {
      this.store.dispatch(
        marketStateActions.setPagination({
          pagination: {
            fromIndex: this.childrenLength() || 0,
            toIndex: this.limit >= this.total ? this.total : this.limit,
          }
        })
      );
    }
  }

  childrenLength() {
    return [...this.el.nativeElement.children].filter((child: HTMLElement) => !child.classList.contains('more')).length;
  }

  private getDefaultBackground(marketItem?: MarketItem): string | null | undefined {
    return marketItem?.collection && 'defaultBackground' in marketItem.collection
      ? marketItem.collection.defaultBackground
      : this.defaultBackground;
  }

  baseImageBackgroundColor(marketItem?: MarketItem): string | null {
    return normalizeDefaultBackground(this.getDefaultBackground(marketItem));
  }

  hasTransparentBackground(marketItem?: MarketItem): boolean {
    return this.getDefaultBackground(marketItem) === null;
  }
}
