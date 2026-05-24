import { MarketItem } from './db';

export type TxType = 'sendToEscrow' | 'hashNoLongerForSale' | 'offerHashForSale' | 'withdrawBidForHash' | 'acceptBidForHash' | 'buyHash' | 'enterBidForHash' | 'transferHash' | 'withdrawHash';

export type ModalType = 'transaction' | 'complete' | 'sell' | 'bid' | 'transfer' | 'acceptBid' | 'error' | null;

export interface TX {
  type: TxType;
  marketItem: MarketItem;

  value?: number | null;
  toAddress?: string | null;

  parent?: ModalType;
}

export interface ModalState {
  active: boolean;
  type: ModalType;
  hash?: string;
  title?: string;
  message?: string;
  parent?: ModalType;
  children?: ModalState[] | null;
}
