import { Action, ActionReducer, createReducer, on } from '@ngrx/store';

import { MarketState } from '@/models/market.state';
import { MarketItem } from '@/models/db';

import * as actions from '../market/market-state.actions';
import { SortOption } from '@/models/sorts.model';

export const initialState: MarketState = {
  marketType: null,
  marketSlug: 'ethereum-phunks',

  marketData: [],
  owned: [],
  listings: [],
  bids: [],
  all: [],
  auctions: [],
  activeMarketRouteData: {
    data: [],
    total: 0
  },

  selectedMarketItems: [],

  activeSort: SortOption.ID,
  activeTraitFilters: {},

  pagination: {
    fromIndex: 0,
    toIndex: 0,
  },
};

export const marketStateReducer: ActionReducer<MarketState, Action> = createReducer(
  initialState,
  on(actions.resetMarketState, () => initialState),
  // Set the market type
  on(actions.setMarketType, (state, { marketType }) => {
    const setMarketType = {
      ...state,
      marketType
    };
    return setMarketType
  }),
  on(actions.setMarketSlug, (state, { marketSlug }) => {
    if (state.marketSlug === marketSlug) return state;

    const setMarketSlug = {
      ...state,
      marketSlug,
      marketData: initialState.marketData,
      owned: initialState.owned,
      listings: initialState.listings,
      bids: initialState.bids,
      all: initialState.all,
      auctions: initialState.auctions,
      activeMarketRouteData: initialState.activeMarketRouteData,
      selectedMarketItems: initialState.selectedMarketItems,
      pagination: initialState.pagination,
    };
    return setMarketSlug;
  }),
  on(actions.setOwned, (state, { owned }) => {
    const setOwned = {
      ...state,
      owned,
    };
    return setOwned
  }),
  on(actions.setMarketData, (state, { marketData }) => {
    const setMarketData = {
      ...state,
      marketData,
      listings: marketData?.filter((item: MarketItem) => item.listing && item.listing.minValue !== '0'),
      bids: marketData?.filter((item: MarketItem) => item.bid && item.bid.value !== '0'),
    };
    return setMarketData
  }),
  on(actions.setAll, (state, { all }) => {
    const setAll = {
      ...state,
      all,
    };
    return setAll
  }),
  on(actions.setActiveMarketRouteData, (state, { activeMarketRouteData }) => {
    const setActiveMarketRouteData = {
      ...state,
      activeMarketRouteData,
    };
    return setActiveMarketRouteData
  }),
  on(actions.clearActiveMarketRouteData, (state) => {
    const clearActiveMarketRouteData = {
      ...state,
      activeMarketRouteData: initialState.activeMarketRouteData,
    };
    return clearActiveMarketRouteData
  }),
  on(actions.setActiveTraitFilters, (state, { traitFilters }) => {
    const setActiveTraitFilters = {
      ...state,
      activeTraitFilters: traitFilters,
    };
    return setActiveTraitFilters
  }),
  on(actions.setSelectedMarketItems, (state, { selectedMarketItems }) => {
    const setSelectedMarketItems = {
      ...state,
      selectedMarketItems,
    };
    return setSelectedMarketItems
  }),
  on(actions.setActiveSort, (state, { activeSort }) => {
    const setActiveSort = {
      ...state,
      activeSort,
    };
    return setActiveSort
  }),
  // Pagination
  on(actions.setPagination, (state, { pagination }) => {
    const setPagination = {
      ...state,
      pagination,
    };
    return setPagination
  }),
  on(actions.setAuctionData, (state, { auctionData }) => {
    const setAuctionData = {
      ...state,
      auctions: auctionData,
    };
    return setAuctionData
  }),
);
