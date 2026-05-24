import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { Component, signal } from '@angular/core';

import { Store } from '@ngrx/store';
import { LazyLoadImageModule } from 'ng-lazyload-image';
import { combineLatest, distinctUntilChanged, filter, fromEvent, map, shareReplay, switchMap, tap } from 'rxjs';

import { MarketItemBillboardComponent } from '@/components/market-item-billboard/market-item-billboard.component';
import { TxHistoryComponent } from '@/components/tx-history/tx-history.component';
import { BreadcrumbsComponent } from '@/routes/item-view/components/breadcrumbs/breadcrumbs.component';
import { AuctionComponent } from '@/components/auctions/auction/auction.component';
import { CommentsComponent } from '@/components/comments/comments.component';

import { ItemStatusComponent } from './components/item-status/item-status.component';
import { ItemActionsComponent } from './components/item-actions/item-actions.component';
import { ItemAttributesComponent } from './components/item-attributes/item-attributes.component';

import { WalletAddressDirective } from '@/directives/wallet-address.directive';

import { QueryParamsPipe } from '@/pipes/query-params.pipe';

import { DataService } from '@/services/data.service';
import { AttributesService } from '@/services/attributes.service';

import { GlobalState } from '@/models/global-state';
import { MarketItem } from '@/models/db';
import { Collection } from '@/models/data.state';
import { Attribute } from '@/models/attributes';

import * as appStateSelectors from '@/state/app/app-state.selectors';

import { environment } from '@environments/environment';
import { setMarketSlug } from '@/state/market/market-state.actions';
import { selectCollections } from '@/state/data/data-state.selectors';

interface FeaturedTrait {
  attribute: Attribute;
  value: string;
  rarity: string;
  filterable: boolean;
}

@Component({
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    RouterModule,

    LazyLoadImageModule,

    MarketItemBillboardComponent,
    TxHistoryComponent,
    WalletAddressDirective,
    BreadcrumbsComponent,
    CommentsComponent,
    AuctionComponent,
    ItemStatusComponent,
    ItemActionsComponent,
    ItemAttributesComponent,

    QueryParamsPipe,
  ],
  selector: 'app-market-item-view',
  templateUrl: './item-view.component.html',
  styleUrls: ['./item-view.component.scss']
})
export class ItemViewComponent {

  explorerUrl = environment.explorerUrl;

  singleMarketItem$ = this.route.params.pipe(
    filter((params: any) => !!params.hashId),
    distinctUntilChanged((prev, curr) => prev.hashId === curr.hashId),
    switchMap((params: any) => this.dataSvc.fetchSingleMarketItem(params.hashId)),
    tap((marketItem: MarketItem) => this.store.dispatch(setMarketSlug({ marketSlug: marketItem.slug }))),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  collection$ = this.singleMarketItem$.pipe(
    switchMap((marketItem: MarketItem) => this.store.select(selectCollections).pipe(
      map((collections: Collection[]) => collections.find((collection: Collection) => collection.slug === marketItem.slug)),
      filter((collection: Collection | undefined): collection is Collection => !!collection),
    )),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  featuredTrait$ = combineLatest([this.singleMarketItem$, this.collection$]).pipe(
    switchMap(([marketItem, collection]: [MarketItem, Collection]) => this.getFeaturedTrait(marketItem, collection)),
  );

  name$ = this.singleMarketItem$.pipe(
    map((marketItem: MarketItem) => marketItem.attributes?.filter(item => item.k === 'Name')[0]?.v),
  );

  description$ = this.singleMarketItem$.pipe(
    map((marketItem: MarketItem) => marketItem.attributes?.filter(item => item.k === 'Description')[0]?.v),
  );

  scrollY$ = fromEvent(document, 'scroll').pipe(
    map(() => (window.scrollY / 2) * -1),
  );

  config$ = this.store.select(appStateSelectors.selectConfig);
  isMobile$ = this.store.select(appStateSelectors.selectIsMobile);
  indexerIsBehind$ = this.store.select(appStateSelectors.selectIndexerIsBehind);

  billboardExpanded = signal(false);
  descriptionExpanded = signal(false);

  constructor(
    private store: Store<GlobalState>,
    public route: ActivatedRoute,
    public dataSvc: DataService,
    private attributesSvc: AttributesService,
  ) {}

  private async getFeaturedTrait(marketItem: MarketItem, collection: Collection): Promise<FeaturedTrait | null> {
    const attributes = marketItem.attributes || [];
    if (!attributes.length) return null;

    const configuredMainTraits = collection?.mainTraits?.filter(Boolean) || [];
    const mainTraits = configuredMainTraits.length ? configuredMainTraits : ['Name'];
    const priorityAttribute = mainTraits
      .map((trait: string) => this.findAttribute(attributes, trait))
      .find((attribute: Attribute | undefined) => !!attribute);

    const attribute = priorityAttribute || attributes.find((item: Attribute) => (
      !collection?.ignoredTraitFilters?.includes(item.k) && this.hasAttributeValue(item)
    ));

    if (!attribute) return null;

    const value = String(attribute.v);
    const rarityData = await this.attributesSvc.getRarityData(marketItem.slug);
    const rarity = attribute.k === 'Name' ? '1' : rarityData?.[value]?.toString() || '';

    return {
      attribute,
      value,
      rarity,
      filterable: !collection?.ignoredTraitFilters?.includes(attribute.k),
    };
  }

  private findAttribute(attributes: Attribute[], trait: string): Attribute | undefined {
    return attributes.find((attribute: Attribute) => (
      attribute.k === trait && this.hasAttributeValue(attribute)
    ));
  }

  private hasAttributeValue(attribute: Attribute): boolean {
    return attribute.v !== null && attribute.v !== undefined && attribute.v !== '';
  }

  expandBillboard(): void {
    this.billboardExpanded.update((expanded) => !expanded);
  }

  toggleDescription(): void {
    this.descriptionExpanded.update((expanded) => !expanded);
  }
}
