import { DataState } from '@/models/data.state';
import { Action, ActionReducer, createReducer, on } from '@ngrx/store';

import * as actions from '../data/data-state.actions';

export const initialState: DataState = {
  usd: null,
  events: null,
  hasMoreEvents: false,
  userOpenBids: [],
  txHistory: null,
  leaderboard: null,
  collections: [],
  activeCollection: null
}

export const dataStateReducer: ActionReducer<DataState, Action> = createReducer(
  initialState,
  on(actions.resetDataState, () => initialState),
  on(actions.setUsd, (state, { usd }) => {
    const setUsd = {
      ...state,
      usd,
    };
    return setUsd
  }),
  on(actions.setEvents, (state, { events, hasMoreEvents }) => {
    const setEvents = {
      ...state,
      events,
      hasMoreEvents,
    };
    return setEvents
  }),
  // on(actions.setUserOpenBids, (state, { userOpenBids }) => {
  //   const setUserOpenBids = {
  //     ...state,
  //     userOpenBids
  //   };
  //   return setUserOpenBids
  // }),
  on(actions.setLeaderboard, (state, { leaderboard }) => {
    const setLeaderboard = {
      ...state,
      leaderboard,
    };
    return setLeaderboard
  }),
  on(actions.setCollections, (state, { collections }) => {
    const setCollections = {
      ...state,
      collections,
    };
    return setCollections
  }),
  on(actions.setActiveCollection, (state, { activeCollection }) => {
    const setActiveCollection = {
      ...state,
      activeCollection,
    };
    return setActiveCollection
  }),
);
