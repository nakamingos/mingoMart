import { EventVenue } from '@/models/global-state';

export const eventVenueLabels: Record<EventVenue, string> = {
  'native-ethscriptions': 'Ethscriptions',
  'etherphunks-market': 'EtherPhunks',
  'etherphunks-auction': 'EtherPhunks Auctions',
  'ethscriptions-market': 'Ethscriptions.com',
  'etch-market': 'Etch',
  'ordex-market': 'Ordex',
  'emblem-vault': 'Emblem Vault',
  opensea: 'OpenSea',
  blur: 'Blur',
};

export function getEventVenueLabel(venue?: EventVenue | null): string | null {
  if (!venue) return null;
  return eventVenueLabels[venue] || null;
}
