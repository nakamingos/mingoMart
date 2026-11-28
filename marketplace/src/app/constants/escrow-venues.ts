import { EventVenue } from '@/models/global-state';
import { environment } from '@environments/environment';

export { etchMarketAbi, etherPhunksMarketAbi, ethscriptionsMarketAbi } from './escrow-venue-abis';

/**
 * Other markets' escrow contracts, and what Mingo Mart lets a depositor do with an item held there.
 *
 * The database keeps the same addresses in escrow_contracts (which decides what shows on a
 * profile and what activity is hidden); this file adds what the UI needs to act on them. Mingo
 * Mart's own market is not listed here: it is environment.marketAddress.
 *
 * Every action is sent from the depositor's own wallet: these contracts key deposits on
 * msg.sender, so nobody else (no router either) can withdraw or delist for them.
 */
export type ExternalEscrowVenue = Extract<
  EventVenue,
  'etherphunks-market' | 'etch-market' | 'ethscriptions-market' | 'ordex-market'
>;

export interface ExternalEscrow {
  venue: ExternalEscrowVenue;
  address: `0x${string}`;
  /** Withdraw one item back to the depositor. */
  canWithdraw: boolean;
  /** Withdraw several items in one transaction. */
  canBatchWithdraw: boolean;
  /** Cancel the venue's listing without withdrawing. */
  canDelist: boolean;
  /** The venue holds sale proceeds that sellers claim themselves. */
  canClaimProceeds: boolean;
  /** Shown when nothing can be done from here. */
  note?: string;
}

const MAINNET_ESCROWS: ExternalEscrow[] = [
  {
    venue: 'etherphunks-market',
    address: '0xd3418772623be1a3cc6b6d45cb46420cedd9154a',
    canWithdraw: true,
    canBatchWithdraw: true,
    canDelist: true,
    canClaimProceeds: true,
  },
  {
    venue: 'etch-market',
    address: '0x57b8792c775d34aa96092400983c3e112fcbc296',
    canWithdraw: true,
    canBatchWithdraw: true,
    canDelist: false,
    canClaimProceeds: false,
  },
  {
    venue: 'ethscriptions-market',
    address: '0xd729a94d6366a4feac4a6869c8b3573cee4701a9',
    canWithdraw: true,
    canBatchWithdraw: false,
    canDelist: false,
    canClaimProceeds: false,
  },
  {
    venue: 'ordex-market',
    address: '0xc33f8610941be56fb0d84e25894c0d928cc97dde',
    canWithdraw: false,
    canBatchWithdraw: false,
    canDelist: false,
    canClaimProceeds: false,
    note: 'Withdrawing from Ordex needs a signature from Ordex\'s own servers, which are offline.',
  },
];

export const externalEscrows: ExternalEscrow[] = environment.chainId === 1 ? MAINNET_ESCROWS : [];

/** The external escrow at `address`, if it is one. */
export function getExternalEscrow(address?: string | null): ExternalEscrow | null {
  if (!address) return null;
  const lower = address.toLowerCase();
  return externalEscrows.find((escrow) => escrow.address === lower) ?? null;
}

/** The external escrow for `venue`, if we know it on this chain. */
export function getExternalEscrowByVenue(venue?: string | null): ExternalEscrow | null {
  if (!venue) return null;
  return externalEscrows.find((escrow) => escrow.venue === venue) ?? null;
}
