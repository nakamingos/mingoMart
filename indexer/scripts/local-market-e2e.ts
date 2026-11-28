#!/usr/bin/env ts-node

/**
 * End-to-end test of the fixed-price market on a local Anvil chain, against the real indexer.
 *
 * Drives MingoMartMarket with Anvil's test accounts and, after each step, checks what the indexer
 * wrote to local Supabase:
 *   1. seller inscribes two items (a seeded "local-e2e" test collection)
 *   2. seller escrows item A and lists it for 1 ETH
 *   3. an attacker who never owned A "deposits", lists, delists and relists it, and an accomplice
 *      buys the fake listing. The contract can't tell (deposits are self-asserted), so all of it
 *      succeeds on-chain; the indexer must ignore every step.
 *   4. a buyer buys A from the real seller
 *   5. the seller withdraws the sale proceeds
 *   6. seller deposits-and-lists item B in one transaction, then withdraws it (delists)
 *
 * Prerequisites (see indexer/.env.localhost):
 *   anvil --chain-id 1337
 *   (cd contracts && npx hardhat run scripts/deploy-mingomart-market.ts --network localhost)
 *   supabase start, Redis, and `yarn start:localhost` in indexer/
 *
 * Usage:
 *   npx ts-node scripts/local-market-e2e.ts            run the test (repeatable on the same chain)
 *   npx ts-node scripts/local-market-e2e.ts --cleanup  remove all local-chain test data from Supabase.
 *       Stop the indexer first. Needed after restarting Anvil (a fresh chain), because the indexer's
 *       saved block for chain 1337 would be ahead of the new chain.
 *
 * Only ever touches a local chain (chain ID 1337) and a local Supabase.
 */

import { createHash } from 'crypto';
import * as path from 'path';

import * as dotenv from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  parseEther,
  stringToHex,
  toHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { localhost } from 'viem/chains';

// Same precedence as the indexer: .env wins over .env.localhost.
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env.localhost') });

const LOCAL_CHAIN_ID = 1337;
const SLUG = 'local-e2e';
const RPC_URL = process.env.RPC_URL_L1 || 'http://127.0.0.1:8545';
const MARKET = (process.env.MARKET_ADDRESS_L1 || '').toLowerCase() as Hex;
const POINTS = (process.env.POINTS_ADDRESS_L1 || '').toLowerCase();
const WAIT_MS = 60_000;

// Anvil's default test accounts (public keys, local chain only).
const KEYS = {
  seller: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  buyer: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  attacker: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  accomplice: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const;
const ANVIL_ADDRESSES = [
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc', '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65', '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
  '0x976ea74026e726554db657fa54763abd0c3a0aa9', '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f', '0xa0ee7a142d267c1f36714e4a8f75612f20a79720',
];

const marketAbi = parseAbi([
  'function offerHashForSale(bytes32 hashId, uint256 minSalePriceInWei)',
  'function hashNoLongerForSale(bytes32 hashId)',
  'function batchBuyHash(address[] previousOwners, bytes32[] hashIds, uint256[] minSalePricesInWei) payable',
  'function withdraw()',
  'function withdrawHash(bytes32 hashId)',
  'function pendingWithdrawals(address) view returns (uint256)',
  'function hashesOfferedForSale(address, bytes32) view returns (bool isForSale, bytes32 hashId, address seller, uint256 minValue, address onlySellTo)',
]);

const COOLDOWN_BLOCKS = 5;
const DEPOSIT_AND_LIST_SIGNATURE = keccak256(stringToHex('DEPOSIT_AND_LIST_SIGNATURE'));

// ------------------------------------------------------------------------------------------------

let failures = 0;
function check(condition: boolean, message: string, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures++;
    console.log(`  ✗ ${message}`);
    if (detail !== undefined) console.log('      got:', JSON.stringify(detail));
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `checkChain` is skipped for --cleanup, which only touches the local database. */
async function assertLocalOnly(checkChain: boolean) {
  const host = (() => {
    try { return new URL(process.env.SUPABASE_URL || '').hostname; } catch { return ''; }
  })();
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    throw new Error(`Refusing to run: SUPABASE_URL must be local (got host "${host}")`);
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run with NODE_ENV=production');
  if (!checkChain) return;
  const chainId = await createPublicClient({ transport: http(RPC_URL) }).getChainId();
  if (chainId !== LOCAL_CHAIN_ID) throw new Error(`Refusing to run: chain ${chainId} is not the local chain`);
}

function supabaseClient(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!, {
    auth: { persistSession: false },
  });
}

async function q<T = any>(promise: PromiseLike<{ data: T | null; error: any }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message ?? String(error));
  return data as T;
}

// ------------------------------------------------------------------------------------------------

async function cleanup(db: SupabaseClient) {
  console.log(`Removing local-chain test data (${SLUG} collection, chain ${LOCAL_CHAIN_ID})...`);
  const items = await q<{ hashId: string }[]>(db.from('ethscriptions_sepolia').select('hashId').eq('slug', SLUG));
  const hashIds = items.map((i) => i.hashId);
  for (let i = 0; i < hashIds.length; i += 100) {
    const batch = hashIds.slice(i, i + 100);
    await q(db.from('events_sepolia').delete().in('hashId', batch));
    await q(db.from('listings_sepolia').delete().in('hashId', batch));
  }
  await q(db.from('ethscriptions_sepolia').delete().eq('slug', SLUG));
  await q(db.from('attributes').delete().eq('slug', SLUG));
  await q(db.from('collections_sepolia').delete().eq('slug', SLUG));
  if (MARKET) await q(db.from('escrow_contracts_sepolia').delete().eq('address', MARKET));
  const localAddresses = [...ANVIL_ADDRESSES, MARKET, POINTS].filter(Boolean);
  await q(db.from('users').delete().in('address', localAddresses));
  await q(db.from('blocks').delete().eq('network', LOCAL_CHAIN_ID));
  console.log(`  removed ${hashIds.length} items, the test collection, the local market's escrow entry, Anvil test users and the chain ${LOCAL_CHAIN_ID} block marker`);
}

async function main() {
  const cleanupOnly = process.argv.includes('--cleanup');
  await assertLocalOnly(!cleanupOnly);
  const db = supabaseClient();

  if (cleanupOnly) {
    await cleanup(db);
    return;
  }

  if (!MARKET) throw new Error('MARKET_ADDRESS_L1 is not set (see .env.localhost)');

  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain: localhost, transport });
  const testClient = createTestClient({ chain: localhost, mode: 'anvil', transport });
  const code = await publicClient.getCode({ address: MARKET });
  if (!code || code === '0x') throw new Error(`No contract at ${MARKET}: run the deploy script first`);

  // viem's generics are too deep for this script's dynamic calls, so the client is untyped.
  type Wallet = { account: PrivateKeyAccount; address: Hex; client: any };
  const wallet = (key: Hex): Wallet => {
    const account = privateKeyToAccount(key);
    const client = createWalletClient({ account, chain: localhost, transport }) as any;
    return { account, address: account.address.toLowerCase() as Hex, client };
  };
  const seller = wallet(KEYS.seller);
  const buyer = wallet(KEYS.buyer);
  const attacker = wallet(KEYS.attacker);
  const accomplice = wallet(KEYS.accomplice);

  /** Sends a transaction, waits for it to be mined successfully, returns the receipt. */
  async function send(wallet: Wallet, tx: { to: Hex; data?: Hex; value?: bigint }) {
    const hash: Hex = await wallet.client.sendTransaction({ account: wallet.account, chain: localhost, ...tx });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
    return receipt;
  }
  async function call(wallet: Wallet, functionName: string, args: unknown[], value?: bigint) {
    const hash: Hex = await wallet.client.writeContract({
      account: wallet.account, chain: localhost, address: MARKET, abi: marketAbi, functionName, args, value,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
    return receipt;
  }

  /** Waits until the indexer has processed `blockNumber`. */
  async function indexed(blockNumber: bigint) {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      const rows = await q<{ blockNumber: number }[]>(db.from('blocks').select('blockNumber').eq('network', LOCAL_CHAIN_ID));
      if (rows[0] && rows[0].blockNumber >= Number(blockNumber)) return;
      await delay(500);
    }
    throw new Error(`Indexer did not reach block ${blockNumber} within ${WAIT_MS / 1000}s. Is it running (yarn start:localhost)?`);
  }
  const item = async (hashId: string) =>
    (await q<any[]>(db.from('ethscriptions_sepolia').select('*').eq('hashId', hashId)))[0] ?? null;
  const listing = async (hashId: string, venue = 'mingomart-market') =>
    (await q<any[]>(db.from('listings_sepolia').select('*').eq('hashId', hashId).eq('venue', venue)))[0] ?? null;
  /** The seller's items as the profile page sees them. */
  const owned = async (address: string) =>
    (await q<any[]>(db.rpc('fetch_ethscriptions_owned_with_listings_and_bids_sepolia', { address, collection_slug: SLUG })))
      .map((row) => row.ethscription);
  /** The collection's activity feed. */
  const feed = async () =>
    q<any[]>(db.rpc('fetch_events_sepolia', { p_limit: 100, p_type: null, p_collection_slug: SLUG, p_offset: 0 }));
  const events = async (hashId: string) =>
    q<any[]>(db.from('events_sepolia').select('*').eq('hashId', hashId).order('blockNumber').order('txIndex'));

  const runId = `${Date.now()}`;
  console.log(`Run ${runId} — market ${MARKET}\n`);

  // 0. Seed the test collection and the two items' content hashes ---------------------------------
  const content = (label: string) =>
    `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text y="5">${SLUG} ${runId} ${label}</text></svg>`;
  const contentA = content('A');
  const contentB = content('B');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  await q(db.from('collections_sepolia').upsert({ slug: SLUG, name: 'Local E2E', singleName: 'Local E2E item', active: true }, { onConflict: 'slug' }));
  // On mainnet this row is added when the market is deployed.
  await q(db.from('escrow_contracts_sepolia').upsert({ address: MARKET, venue: 'mingomart-market' }, { onConflict: 'address' }));
  await q(db.from('attributes').insert([
    { sha: sha(contentA), slug: SLUG, tokenId: 1, values: { run: runId, item: 'A' } },
    { sha: sha(contentB), slug: SLUG, tokenId: 2, values: { run: runId, item: 'B' } },
  ]));

  // 1. Inscribe --------------------------------------------------------------------------------------
  console.log('1. Seller inscribes items A and B');
  const inscribeA = await send(seller, { to: seller.address, data: toHex(contentA) });
  const inscribeB = await send(seller, { to: seller.address, data: toHex(contentB) });
  const hashA = inscribeA.transactionHash.toLowerCase() as Hex;
  const hashB = inscribeB.transactionHash.toLowerCase() as Hex;
  await indexed(inscribeB.blockNumber);
  let a = await item(hashA);
  const b0 = await item(hashB);
  check(a?.owner === seller.address && a?.creator === seller.address, 'item A indexed, owned by the seller', a);
  check(b0?.owner === seller.address, 'item B indexed, owned by the seller', b0);

  // 2. Escrow + list A ----------------------------------------------------------------------------------
  console.log('2. Seller escrows A, then lists it for 1 ETH');
  await send(seller, { to: MARKET, data: hashA });
  const listA = await call(seller, 'offerHashForSale', [hashA, parseEther('1')]);
  await indexed(listA.blockNumber);
  a = await item(hashA);
  let l = await listing(hashA);
  check(a?.owner === MARKET && a?.prevOwner === seller.address, 'A is held by the market, previous owner = seller', a);
  check(l?.listedBy === seller.address && l?.minValue === parseEther('1').toString(), 'listing: seller, 1 ETH', l);
  const ownedA = (await owned(seller.address)).find((o) => o.ethscription.hashId === hashA);
  check(
    ownedA?.escrow?.venue === 'mingomart-market' && ownedA?.listing?.[0]?.minValue === parseEther('1').toString(),
    'profile: A shows as escrowed at Mingo Mart, listed for 1 ETH', ownedA
  );
  check(
    !(await feed()).some((e) => e.hashId === hashA && e.type === 'transfer' && e.to === MARKET),
    'activity: the deposit into the market is hidden'
  );

  // 3. Attacker -------------------------------------------------------------------------------------------
  console.log('3. Attacker fakes a deposit, lists/delists/relists A, accomplice buys the fake listing');
  await send(attacker, { to: MARKET, data: hashA });                       // self-asserted "deposit"
  await call(attacker, 'offerHashForSale', [hashA, BigInt(1)]);
  await call(attacker, 'hashNoLongerForSale', [hashA]);
  await call(attacker, 'offerHashForSale', [hashA, BigInt(1)]);
  await testClient.mine({ blocks: COOLDOWN_BLOCKS });
  const fakeBuy = await call(accomplice, 'batchBuyHash', [[attacker.address], [hashA], [BigInt(1)]], BigInt(1));
  check(true, 'all attacker transactions succeeded on-chain (the contract cannot verify ownership)');
  await indexed(fakeBuy.blockNumber);
  a = await item(hashA);
  l = await listing(hashA);
  const attackerEvents = (await events(hashA)).filter((e) =>
    [attacker.address, accomplice.address].includes(e.from) || [attacker.address, accomplice.address].includes(e.to)
  );
  check(a?.owner === MARKET && a?.prevOwner === seller.address, 'A still held by the market for the seller (fake sale transfer ignored)', a);
  check(l?.listedBy === seller.address && l?.minValue === parseEther('1').toString(), 'real listing untouched: seller, 1 ETH', l);
  check(attackerEvents.length === 0, 'no activity recorded for the attacker or accomplice', attackerEvents);

  // 4. Buy ------------------------------------------------------------------------------------------------
  console.log('4. Buyer buys A from the seller for 1 ETH');
  const buy = await call(buyer, 'batchBuyHash', [[seller.address], [hashA], [parseEther('1')]], parseEther('1'));
  await indexed(buy.blockNumber);
  a = await item(hashA);
  l = await listing(hashA);
  const sale = (await events(hashA)).find((e) => e.type === 'HashBought');
  check(a?.owner === buyer.address && a?.prevOwner === MARKET, 'A now owned by the buyer', a);
  check(l === null, 'listing removed', l);
  check(
    sale?.from === seller.address && sale?.to === buyer.address && sale?.value === parseEther('1').toString(),
    'sale recorded: seller → buyer, 1 ETH', sale
  );
  const feedA = (await feed()).filter((e) => e.hashId === hashA);
  check(
    feedA.some((e) => e.type === 'HashBought') && feedA.some((e) => e.type === 'transfer' && e.from === MARKET && e.to === buyer.address),
    'activity: the sale and the transfer out to the buyer are shown', feedA
  );
  check(
    !(await owned(seller.address)).some((o) => o.ethscription.hashId === hashA)
      && (await owned(buyer.address)).some((o) => o.ethscription.hashId === hashA && !o.escrow),
    'profiles: A left the seller and is held directly by the buyer'
  );

  // 5. Withdraw payment ------------------------------------------------------------------------------------
  console.log('5. Seller withdraws the sale proceeds');
  const pending = await publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: 'pendingWithdrawals', args: [seller.address] });
  check(pending === parseEther('1'), 'seller has 1 ETH pending (0% fee)', pending.toString());
  const balanceBefore = await publicClient.getBalance({ address: seller.address });
  const withdrawal = await call(seller, 'withdraw', []);
  const balanceAfter = await publicClient.getBalance({ address: seller.address });
  const gas = withdrawal.gasUsed * withdrawal.effectiveGasPrice;
  check(balanceAfter - balanceBefore + gas === parseEther('1'), 'seller received exactly 1 ETH (after gas)');
  const pendingAfter = await publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: 'pendingWithdrawals', args: [seller.address] });
  check(pendingAfter === BigInt(0), 'nothing left pending');

  // 6. Deposit-and-list B in one transaction, then withdraw it ------------------------------------------------
  console.log('6. Seller deposits-and-lists B for 0.5 ETH in one transaction, then withdraws it');
  const depositAndList = (hashB +
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [DEPOSIT_AND_LIST_SIGNATURE, parseEther('0.5'), '0x0000000000000000000000000000000000000000']
    ).slice(2)) as Hex;
  const listB = await send(seller, { to: MARKET, data: depositAndList });
  await indexed(listB.blockNumber);
  let b = await item(hashB);
  l = await listing(hashB);
  check(b?.owner === MARKET && b?.prevOwner === seller.address, 'B is held by the market, previous owner = seller', b);
  check(l?.listedBy === seller.address && l?.minValue === parseEther('0.5').toString(), 'listing: seller, 0.5 ETH', l);

  // Another venue's listing for the same item lives in its own row and must survive Mingo Mart events.
  const otherVenue = { hashId: hashB, venue: 'etherphunks-market', createdAt: new Date().toISOString(), listed: true,
    minValue: '123', listedBy: seller.address, toAddress: '0x0000000000000000000000000000000000000000', txHash: hashB, l2: false };
  await q(db.from('listings_sepolia').insert(otherVenue));

  await testClient.mine({ blocks: COOLDOWN_BLOCKS });
  const withdrawB = await call(seller, 'withdrawHash', [hashB]);
  await indexed(withdrawB.blockNumber);
  b = await item(hashB);
  l = await listing(hashB);
  const delist = (await events(hashB)).find((e) => e.type === 'HashNoLongerForSale');
  check(b?.owner === seller.address, 'B returned to the seller', b);
  check(l === null, 'listing removed', l);
  check(delist?.from === seller.address, 'delisting recorded for the seller', delist);
  const otherAfter = await listing(hashB, 'etherphunks-market');
  check(otherAfter?.minValue === '123', 'the other venue\'s listing for B was left alone', otherAfter);

  // Summary ------------------------------------------------------------------------------------------------
  console.log('\nActivity recorded for A:');
  for (const e of await events(hashA)) console.log(`  ${e.blockNumber}  ${e.type.padEnd(20)} ${e.from} → ${e.to}  ${e.value ?? ''}`);
  console.log('Activity recorded for B:');
  for (const e of await events(hashB)) console.log(`  ${e.blockNumber}  ${e.type.padEnd(20)} ${e.from} → ${e.to}  ${e.value ?? ''}`);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
