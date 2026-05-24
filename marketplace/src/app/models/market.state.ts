import { MarketItem } from './db';
import { TraitFilter } from './global-state';
import { SortOption } from './sorts.model';

export interface MarketState {
  marketType: MarketType | null;
  marketSlug: string;

  marketData: MarketItem[];
  owned: MarketItem[];
  listings: MarketItem[];
  bids: MarketItem[];
  all: MarketItem[];
  auctions: MarketItem[];
  activeMarketRouteData: {
    data: MarketItem[];
    total: number;
  };
  pagination: PaginationState;

  selectedMarketItems: MarketItem[];

  activeSort: SortOption;
  activeTraitFilters: TraitFilter | null;
}

export type MarketType = 'listings' | 'owned' | 'all' | 'activity' | 'auctions';

export interface PaginationState {
  fromIndex: number;
  toIndex: number;
};
