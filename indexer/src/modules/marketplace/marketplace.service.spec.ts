jest.mock('fs/promises', () => ({ mkdir: jest.fn(), writeFile: jest.fn() }));
// The real modules pull in Supabase/config at import time; the service only needs their shapes.
jest.mock('@/modules/storage/storage.service', () => ({ StorageService: class {} }));
jest.mock('@/config/config.service', () => ({ AppConfigService: class {} }));

import { MarketplaceService } from './marketplace.service';

const MARKET = '0x00000000000000000000000000000000000000aa';
const HASH = '0x' + '11'.repeat(32);
const SELLER = '0x000000000000000000000000000000000000000b';
const ATTACKER = '0x000000000000000000000000000000000000000c';
const BUYER = '0x000000000000000000000000000000000000000d';
const RELAYER = '0x000000000000000000000000000000000000000e';

type Item = { hashId: string; owner: string; prevOwner: string | null };
type Listing = { hashId: string; listedBy: string; minValue: string; toAddress: string };

/** In-memory stand-in for the bits of StorageService the market handler uses. */
class FakeStorage {
  items = new Map<string, Item>();
  /** Mingo Mart listings, by hashId. */
  listings = new Map<string, Listing>();
  /** Other venues' listings, by `${venue}:${hashId}`. */
  otherVenueListings = new Map<string, Listing>();

  private map(venue: string) {
    return venue === 'mingomart-market' ? this.listings : this.otherVenueListings;
  }

  private key(hashId: string, venue: string) {
    return venue === 'mingomart-market' ? hashId : `${venue}:${hashId}`;
  }

  async checkEthscriptionExistsByHashId(hashId: string) {
    return this.items.get(hashId) ?? null;
  }

  async getListing(hashId: string, venue: string) {
    return this.map(venue).get(this.key(hashId, venue)) ?? null;
  }

  async removeListing(hashId: string, venue: string) {
    return this.map(venue).delete(this.key(hashId, venue));
  }

  async createListing(
    txn: any, _createdAt: Date, hashId: string, toAddress: string, minValue: bigint,
    venue: string, _l2 = false, listedBy: string = txn.from,
  ) {
    this.map(venue).set(this.key(hashId, venue), {
      hashId, listedBy: listedBy.toLowerCase(), minValue: minValue.toString(), toAddress: toAddress.toLowerCase(),
    });
  }
}

function setup() {
  const storage = new FakeStorage();
  const config = { contracts: { market: { l1: MARKET } } };
  const service = new MarketplaceService(config as any, storage as any);
  let logIndex = 0;

  const emit = (eventName: string, args: Record<string, unknown>, from = String(args.seller ?? args.fromAddress ?? RELAYER)) =>
    service.processMingoMartMarketplaceEvent(
      { hash: '0xtx', from, blockHash: '0xblock', transactionIndex: 0, blockNumber: BigInt(1) } as any,
      new Date(0),
      { eventName, args: { hashId: HASH, ...args } } as any,
      { logIndex: logIndex++ } as any,
    );

  return { storage, emit };
}

/** The real seller has escrowed the item and listed it for 1 ETH. */
async function withGenuineListing() {
  const ctx = setup();
  ctx.storage.items.set(HASH, { hashId: HASH, owner: MARKET, prevOwner: SELLER });
  const event = await ctx.emit('HashOffered', { seller: SELLER, minValue: BigInt(1e18), toAddress: '0x' + '0'.repeat(40) });
  expect(event?.type).toBe('HashOffered');
  expect(ctx.storage.listings.get(HASH)?.listedBy).toBe(SELLER);
  return ctx;
}

describe('MarketplaceService listing removal', () => {
  describe('griefing by someone who does not own the item', () => {
    it('ignores a fake HashOffered and keeps the real listing', async () => {
      const { storage, emit } = await withGenuineListing();

      const event = await emit('HashOffered', { seller: ATTACKER, minValue: BigInt(1), toAddress: '0x' + '0'.repeat(40) });

      expect(event).toBeUndefined();
      expect(storage.listings.get(HASH)).toMatchObject({ listedBy: SELLER, minValue: String(BigInt(1e18)) });
    });

    it('ignores a fake HashNoLongerForSale and keeps the real listing', async () => {
      const { storage, emit } = await withGenuineListing();

      const event = await emit('HashNoLongerForSale', { seller: ATTACKER });

      expect(event).toBeUndefined();
      expect(storage.listings.get(HASH)?.listedBy).toBe(SELLER);
    });

    it('ignores a fake HashBought from the attacker\'s own slot and keeps the real listing', async () => {
      const { storage, emit } = await withGenuineListing();

      const event = await emit('HashBought', { fromAddress: ATTACKER, toAddress: BUYER, value: BigInt(1) }, BUYER);

      expect(event).toBeUndefined();
      expect(storage.listings.get(HASH)?.listedBy).toBe(SELLER);
    });

    it('does not create a listing when the market does not hold the item', async () => {
      const { storage, emit } = setup();
      storage.items.set(HASH, { hashId: HASH, owner: SELLER, prevOwner: ATTACKER });

      const event = await emit('HashOffered', { seller: ATTACKER, minValue: BigInt(1), toAddress: '0x' + '0'.repeat(40) });

      expect(event).toBeUndefined();
      expect(storage.listings.size).toBe(0);
    });

    it('does not create a listing when the previous owner is unknown', async () => {
      const { storage, emit } = setup();
      storage.items.set(HASH, { hashId: HASH, owner: MARKET, prevOwner: null });

      const event = await emit('HashOffered', { seller: ATTACKER, minValue: BigInt(1), toAddress: '0x' + '0'.repeat(40) });

      expect(event).toBeUndefined();
      expect(storage.listings.size).toBe(0);
    });
  });

  describe('the real seller', () => {
    it('can relist at a new price', async () => {
      const { storage, emit } = await withGenuineListing();

      await emit('HashOffered', { seller: SELLER, minValue: BigInt(2e18), toAddress: '0x' + '0'.repeat(40) });

      expect(storage.listings.get(HASH)?.minValue).toBe(String(BigInt(2e18)));
    });

    it('can delist, and the delisting is recorded', async () => {
      const { storage, emit } = await withGenuineListing();

      const event = await emit('HashNoLongerForSale', { seller: SELLER });

      expect(event).toMatchObject({ type: 'HashNoLongerForSale', from: SELLER, venue: 'mingomart-market' });
      expect(storage.listings.has(HASH)).toBe(false);
    });

    it('records the delisting when withdrawing a listed item (item already left escrow)', async () => {
      const { storage, emit } = await withGenuineListing();
      // withdrawHash transfers the item back before emitting HashNoLongerForSale.
      storage.items.set(HASH, { hashId: HASH, owner: SELLER, prevOwner: MARKET });

      const event = await emit('HashNoLongerForSale', { seller: SELLER });

      expect(event).toMatchObject({ type: 'HashNoLongerForSale', from: SELLER });
      expect(storage.listings.has(HASH)).toBe(false);
    });

    it('sells, and the sale is recorded with its price', async () => {
      const { storage, emit } = await withGenuineListing();
      // The ESIP-2 transfer to the buyer is processed before the market event.
      storage.items.set(HASH, { hashId: HASH, owner: BUYER, prevOwner: MARKET });

      const event = await emit('HashBought', { fromAddress: SELLER, toAddress: BUYER, value: BigInt(1e18) }, BUYER);

      expect(event).toMatchObject({ type: 'HashBought', from: SELLER, to: BUYER, value: String(BigInt(1e18)) });
      expect(storage.listings.has(HASH)).toBe(false);
    });

    it('lists from a smart-contract wallet: the event seller is stored, not the transaction sender', async () => {
      const { storage, emit } = setup();
      storage.items.set(HASH, { hashId: HASH, owner: MARKET, prevOwner: SELLER });

      await emit('HashOffered', { seller: SELLER, minValue: BigInt(1e18), toAddress: '0x' + '0'.repeat(40) }, RELAYER);
      expect(storage.listings.get(HASH)?.listedBy).toBe(SELLER);

      const event = await emit('HashNoLongerForSale', { seller: SELLER }, RELAYER);
      expect(event?.type).toBe('HashNoLongerForSale');
      expect(storage.listings.has(HASH)).toBe(false);
    });

    it('never touches another venue\'s listing for the same item', async () => {
      const { storage, emit } = await withGenuineListing();
      const etherPhunksListing = { hashId: HASH, listedBy: SELLER, minValue: '5', toAddress: '0x' + '0'.repeat(40) };
      storage.otherVenueListings.set(`etherphunks-market:${HASH}`, etherPhunksListing);

      await emit('HashOffered', { seller: SELLER, minValue: BigInt(2e18), toAddress: '0x' + '0'.repeat(40) });
      await emit('HashNoLongerForSale', { seller: SELLER });

      expect(storage.listings.has(HASH)).toBe(false);
      expect(storage.otherVenueListings.get(`etherphunks-market:${HASH}`)).toEqual(etherPhunksListing);
    });

    it('matches addresses case-insensitively (checksummed event args)', async () => {
      const { storage, emit } = await withGenuineListing();
      const checksummed = '0x000000000000000000000000000000000000000B';

      const event = await emit('HashNoLongerForSale', { seller: checksummed });

      expect(event?.type).toBe('HashNoLongerForSale');
      expect(storage.listings.has(HASH)).toBe(false);
    });
  });
});
