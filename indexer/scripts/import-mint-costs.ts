#!/usr/bin/env ts-node
/**
 * Import per-item mint costs ("mintCost" / "mintKind" on ethscriptions) for collections that were
 * minted through a paid contract and inscribed to the buyer by a backend service. Sale
 * notifications use these to show P&L when the seller is the original minter.
 *
 * Each supported collection has an adapter that reads its mint contract's events (which record
 * the recipient and token ids of every mint) plus the paying transactions, all via Etherscan.
 *
 *   mintKind 'paid'    - bought from the contract; mintCost = ETH sent / items in that mint
 *   mintKind 'free'    - promo mints, team shares, free claims (mintCost 0)
 *   mintKind 'airdrop' - unrecorded free replacements, e.g. Nakamingos "Art Drop" (mintCost 0)
 *
 * A cost is only recorded when the item was actually inscribed to the contract mint's recipient.
 *
 * Usage:
 *   ts-node scripts/import-mint-costs.ts --collections comrades-of-the-dead,nakamingos,darknezz,nml-death-certificates,moonbirds [--dry-run]
 *
 * Writes to the Supabase project in .env.supabase (SUPABASE_URL / SUPABASE_SERVICE_ROLE).
 * Reads ETHERSCAN_API_KEY from .env.mainnet.
 */
import * as dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { keccak256, toBytes } from 'viem';

dotenv.config({ path: '.env.supabase' });
dotenv.config({ path: '.env.mainnet' });

const ETHERSCAN_API_URL = 'https://api.etherscan.io/v2/api';
const ETHERSCAN_MIN_INTERVAL_MS = 350;
const PAGE = 1000;

type MintKind = 'paid' | 'free' | 'airdrop';
type MintCost = { hashId: string; cost: bigint; kind: MintKind };

interface EtherscanLog {
  transactionHash: string;
  blockNumber: string;
  logIndex: string;
  topics: string[];
  data: string;
}

interface EtherscanTx {
  hash: string;
  blockNumber: string;
  from: string;
  value: string;
  isError: string;
  functionName?: string;
}

interface Item {
  hashId: string;
  tokenId: number;
  sha: string;
  slug: string;
  createdTo: string;
  createdFrom: string;
  createdBlock: number;
}

/** A contract mint that produced a run of token ids for one recipient. */
interface ContractMint {
  txHash: string;
  block: number;
  recipient: string;
  firstTokenId: number;
  amount: number;
  cost: bigint; // per item
  kind: MintKind;
}

// ----------------------------------------------------------------------------- Etherscan

let lastCall = 0;

async function etherscan<T>(params: Record<string, string | number>): Promise<T[]> {
  const apiKey = process.env.ETHERSCAN_API_KEY?.trim();
  if (!apiKey) throw new Error('ETHERSCAN_API_KEY is not set');
  const query = new URLSearchParams({ chainid: '1', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), apikey: apiKey });

  for (let attempt = 1; attempt <= 6; attempt++) {
    const wait = lastCall + ETHERSCAN_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    try {
      const response = await fetch(`${ETHERSCAN_API_URL}?${query}`);
      const body = await response.json() as { status: string; message: string; result: unknown };
      if (body.status === '1' && Array.isArray(body.result)) return body.result as T[];
      if (/no (records|transactions) found/i.test(body.message)) return [];
      throw new Error(`${body.message}: ${String(body.result).slice(0, 200)}`);
    } catch (error) {
      if (attempt === 6) throw error;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return [];
}

/** All logs for one event on a contract, splitting block ranges that hit the 1,000-result cap. */
async function getLogs(address: string, eventSignature: string, fromBlock: number, toBlock: number): Promise<EtherscanLog[]> {
  const topic0 = keccak256(toBytes(eventSignature));
  const page = await etherscan<EtherscanLog>({ module: 'logs', action: 'getLogs', address, topic0, fromBlock, toBlock, page: 1, offset: PAGE });
  if (page.length < PAGE) return page;
  const mid = Math.floor((fromBlock + toBlock) / 2);
  return [...await getLogs(address, eventSignature, fromBlock, mid), ...await getLogs(address, eventSignature, mid + 1, toBlock)];
}

/** All successful transactions sent to a contract. */
async function getTransactions(address: string, fromBlock: number, toBlock: number): Promise<EtherscanTx[]> {
  const page = await etherscan<EtherscanTx>({ module: 'account', action: 'txlist', address, startblock: fromBlock, endblock: toBlock, page: 1, offset: PAGE, sort: 'asc' });
  if (page.length >= PAGE) {
    const mid = Math.floor((fromBlock + toBlock) / 2);
    return [...await getTransactions(address, fromBlock, mid), ...await getTransactions(address, mid + 1, toBlock)];
  }
  return page.filter((tx) => tx.isError === '0');
}

/**
 * Mints made through another contract (smart accounts, ERC-4337, batch helpers) aren't in the mint
 * contract's own transaction list; their payment arrives as an internal transfer. Adds those
 * transactions to `txs` with the ETH that reached the mint contract as their value.
 */
async function addInternalMintTransactions(contract: string, logs: EtherscanLog[], txs: Map<string, EtherscanTx>) {
  const missing = [...new Set(logs.map((log) => log.transactionHash))].filter((hash) => !txs.has(hash));
  for (const hash of missing) {
    const internal = await etherscan<{ to: string; value: string; isError: string }>({ module: 'account', action: 'txlistinternal', txhash: hash });
    const value = internal
      .filter((call) => call.isError !== '1' && call.to?.toLowerCase() === contract)
      .reduce((sum, call) => sum + BigInt(call.value), BigInt(0));
    txs.set(hash, { hash, blockNumber: '0', from: '', value: value.toString(), isError: '0', functionName: '' });
  }
  if (missing.length) console.log(`  ${missing.length} mint transaction(s) made through other contracts; priced from internal transfers`);
}

const hex = (value: string) => (value && value !== '0x' ? parseInt(value, 16) : 0);
const topicAddress = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

/**
 * Turns "Ethscribe(minter, mintTo indexed, firstTokenId indexed, amount indexed)"-style logs into
 * priced mints. Within a transaction the first event is the purchase; later events are team shares
 * (free). Transactions calling one of `freeFunctions` (or sending no ETH) are free.
 */
function priceRangeMints(logs: EtherscanLog[], txs: Map<string, EtherscanTx>, freeFunctions: string[]): ContractMint[] {
  const byTx = new Map<string, EtherscanLog[]>();
  for (const log of logs) byTx.set(log.transactionHash, [...(byTx.get(log.transactionHash) || []), log]);

  const mints: ContractMint[] = [];
  for (const [txHash, txLogs] of byTx) {
    const tx = txs.get(txHash);
    if (!tx) throw new Error(`Mint transaction ${txHash} not found in the contract's transaction list`);
    const fn = (tx.functionName || '').split('(')[0];
    const value = BigInt(tx.value);

    txLogs.sort((a, b) => hex(a.logIndex) - hex(b.logIndex));
    txLogs.forEach((log, index) => {
      const amount = hex(log.topics[3]);
      if (!amount) return;
      const purchase = index === 0 && !freeFunctions.includes(fn) && value > BigInt(0);
      mints.push({
        txHash,
        block: hex(log.blockNumber),
        recipient: topicAddress(log.topics[1]),
        firstTokenId: hex(log.topics[2]),
        amount,
        cost: purchase ? value / BigInt(amount) : BigInt(0),
        kind: purchase ? 'paid' : 'free',
      });
    });
  }
  return mints;
}

// ----------------------------------------------------------------------------- database

async function loadItems(supabase: SupabaseClient, slug: string): Promise<Item[]> {
  const items: Item[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('events')
      .select('hashId, from, to, blockNumber, ethscriptions!inner(tokenId, sha, slug)')
      .eq('type', 'created')
      .eq('ethscriptions.slug', slug)
      // Paging needs a unique order, or rows sharing a block can be skipped or repeated.
      .order('blockNumber', { ascending: true })
      .order('txId', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data as any[]) {
      items.push({
        hashId: row.hashId,
        tokenId: Number(row.ethscriptions.tokenId),
        sha: row.ethscriptions.sha,
        slug,
        createdTo: row.to.toLowerCase(),
        createdFrom: row.from.toLowerCase(),
        createdBlock: Number(row.blockNumber),
      });
    }
    if (data.length < PAGE) break;
  }
  return items;
}

async function loadOrigins(supabase: SupabaseClient, slug: string): Promise<Map<string, string>> {
  const origins = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('attributes')
      .select('sha, values->>Origin')
      .eq('slug', slug)
      .order('sha', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data as any[]) if (row.Origin) origins.set(row.sha, row.Origin);
    if (data.length < PAGE) break;
  }
  return origins;
}

async function writeMintCosts(supabase: SupabaseClient, slug: string, costs: MintCost[], dryRun: boolean) {
  const groups = new Map<string, string[]>();
  for (const { hashId, cost, kind } of costs) {
    const key = `${kind}:${cost}`;
    groups.set(key, [...(groups.get(key) || []), hashId]);
  }

  console.log(`  ${slug}: ${costs.length} items with mint costs`);
  for (const [key, hashIds] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const [kind, cost] = key.split(':');
    console.log(`    ${kind.padEnd(7)} ${(Number(cost) / 1e18).toString().padEnd(10)} ETH x ${hashIds.length}`);
  }
  if (dryRun) return;

  // Clear previous values for the collection, then write each (kind, cost) group.
  const { error: clearError } = await supabase.from('ethscriptions').update({ mintCost: null, mintKind: null }).eq('slug', slug);
  if (clearError) throw clearError;

  for (const [key, hashIds] of groups) {
    const [kind, cost] = key.split(':');
    for (let i = 0; i < hashIds.length; i += 100) {
      const { error } = await supabase
        .from('ethscriptions')
        .update({ mintCost: cost, mintKind: kind })
        .in('hashId', hashIds.slice(i, i + 100)); // keep the request URL short
      if (error) throw error;
    }
  }
}

/** Keep a mint's cost only for items that were inscribed to that mint's recipient. */
function costsForMatchingRecipients(items: Item[], mints: ContractMint[]): Map<number, { mint: ContractMint; item: Item }> {
  const byToken = new Map<number, ContractMint>();
  for (const mint of mints) for (let t = mint.firstTokenId; t < mint.firstTokenId + mint.amount; t++) byToken.set(t, mint);

  const matched = new Map<number, { mint: ContractMint; item: Item }>();
  for (const item of items) {
    const mint = byToken.get(item.tokenId);
    if (mint && mint.recipient === item.createdTo) matched.set(item.tokenId, { mint, item });
  }
  return matched;
}

// ----------------------------------------------------------------------------- adapters

/** Comrades of the Dead: ComradesOTD mint contract, inscribed by deployer.nomorelabs.eth. */
async function comradesOfTheDead(supabase: SupabaseClient): Promise<Record<string, MintCost[]>> {
  const CONTRACT = '0x6c36c50dfb356af4308d6540e5d263ac15b91fc5';
  const [logs, txList, items] = await Promise.all([
    getLogs(CONTRACT, 'EthscribeCOTD(address,address,uint256,uint256)', 23_600_000, 23_900_000),
    getTransactions(CONTRACT, 23_600_000, 23_900_000),
    loadItems(supabase, 'comrades-of-the-dead'),
  ]);
  const txs = new Map(txList.map((tx) => [tx.hash, tx]));
  await addInternalMintTransactions(CONTRACT, logs, txs);
  const mints = priceRangeMints(logs, txs, ['promoMint']);
  console.log(`  comrades-of-the-dead: ${logs.length} mint events, ${mints.reduce((n, m) => n + m.amount, 0)} items`);

  const matched = costsForMatchingRecipients(items, mints);
  return {
    'comrades-of-the-dead': [...matched.values()].map(({ mint, item }) => ({ hashId: item.hashId, cost: mint.cost, kind: mint.kind })),
  };
}

/**
 * Nakamingos (and Misprint Mingos): Nakamingos mint contract, inscribed by nakamingos.eth.
 * - Regular mints, pink list and team shares come from EthscribeMingo; clones from EthscribeClone
 *   (paid via mintClone, free via the presale/free-claim clone functions).
 * - Misprinted inscriptions moved to Misprint Mingos and were replaced by free "Art Drop" items
 *   under the original token ids, so Art Drops are airdrops and each misprint carries the cost of
 *   the contract mint it came from (the nearest earlier mint to the same recipient whose token was
 *   later replaced).
 */
async function nakamingos(supabase: SupabaseClient): Promise<Record<string, MintCost[]>> {
  const CONTRACT = '0xac24b75caed30df505b74750b434f516cdff22b0';
  const DEPLOYER = '0xf4249a4a9a105d604778c3d2181a90facb9c7783';
  const FROM = 18_900_000;
  const TO = 24_100_000;

  const [mingoLogs, cloneLogs, txList, items, misprints, origins] = await Promise.all([
    getLogs(CONTRACT, 'EthscribeMingo(address,address,uint256,uint256)', FROM, TO),
    getLogs(CONTRACT, 'EthscribeClone(address,address,uint256,uint256)', FROM, TO),
    getTransactions(CONTRACT, FROM, TO),
    loadItems(supabase, 'nakamingos'),
    loadItems(supabase, 'misprint-mingos'),
    loadOrigins(supabase, 'nakamingos'),
  ]);
  const txs = new Map(txList.map((tx) => [tx.hash, tx]));
  await addInternalMintTransactions(CONTRACT, [...mingoLogs, ...cloneLogs], txs);

  const mints = priceRangeMints(mingoLogs, txs, ['promoMint']);
  for (const log of cloneLogs) {
    const tx = txs.get(log.transactionHash);
    if (!tx) throw new Error(`Clone transaction ${log.transactionHash} not found`);
    const value = BigInt(tx.value);
    mints.push({
      txHash: log.transactionHash,
      block: hex(log.blockNumber),
      recipient: topicAddress(log.topics[1]),
      firstTokenId: hex(log.topics[2]),
      amount: 1,
      cost: value,
      kind: value > BigInt(0) ? 'paid' : 'free',
    });
  }
  console.log(`  nakamingos: ${mingoLogs.length} mint + ${cloneLogs.length} clone events, ${mints.reduce((n, m) => n + m.amount, 0)} items`);

  const isArtDrop = (item: Item) => origins.get(item.sha) === 'Art Drop';
  const matched = costsForMatchingRecipients(items.filter((item) => !isArtDrop(item)), mints);

  const nakamingosCosts: MintCost[] = [
    ...[...matched.values()].map(({ mint, item }) => ({ hashId: item.hashId, cost: mint.cost, kind: mint.kind })),
    ...items.filter(isArtDrop).map((item) => ({ hashId: item.hashId, cost: BigInt(0), kind: 'airdrop' as MintKind })),
  ];

  // Misprints: pair with the mint of a token that was later replaced by an Art Drop.
  const byToken = new Map<number, ContractMint>();
  for (const mint of mints) for (let t = mint.firstTokenId; t < mint.firstTokenId + mint.amount; t++) byToken.set(t, mint);
  const replacedMintsByRecipient = new Map<string, ContractMint[]>();
  for (const item of items.filter(isArtDrop)) {
    const mint = byToken.get(item.tokenId);
    if (!mint) continue;
    replacedMintsByRecipient.set(mint.recipient, [...(replacedMintsByRecipient.get(mint.recipient) || []), mint]);
  }

  const misprintCosts: MintCost[] = [];
  for (const item of misprints) {
    if (item.createdFrom !== DEPLOYER) continue;
    const candidates = (replacedMintsByRecipient.get(item.createdTo) || []).filter((mint) => mint.block <= item.createdBlock);
    if (!candidates.length) continue;
    const nearestBlock = Math.max(...candidates.map((mint) => mint.block));
    const nearest = candidates.filter((mint) => mint.block === nearestBlock);
    const prices = new Set(nearest.map((mint) => `${mint.kind}:${mint.cost}`));
    if (prices.size !== 1) continue; // ambiguous: leave unknown
    misprintCosts.push({ hashId: item.hashId, cost: nearest[0].cost, kind: nearest[0].kind });
  }

  return { nakamingos: nakamingosCosts, 'misprint-mingos': misprintCosts };
}

/**
 * Darknezz: Darknezz mint contract (whitelist 0.0055 / public 0.011, exact payment required).
 * Mint(minter indexed, amount indexed, startID) - the payer is the recipient, and startID is
 * 0-based while the collection's token ids start at 1.
 */
async function darknezz(supabase: SupabaseClient): Promise<Record<string, MintCost[]>> {
  const CONTRACT = '0xfbeff61e5fc75ec1089adb4410930d0d8310b9ae';
  const [logs, txList, items] = await Promise.all([
    getLogs(CONTRACT, 'Mint(address,uint256,uint256)', 18_800_000, 19_100_000),
    getTransactions(CONTRACT, 18_800_000, 19_100_000),
    loadItems(supabase, 'darknezz'),
  ]);
  const txs = new Map(txList.map((tx) => [tx.hash, tx]));
  await addInternalMintTransactions(CONTRACT, logs, txs);

  const mints: ContractMint[] = logs.map((log) => {
    const tx = txs.get(log.transactionHash);
    if (!tx) throw new Error(`Mint transaction ${log.transactionHash} not found`);
    const amount = hex(log.topics[2]);
    const cost = amount ? BigInt(tx.value) / BigInt(amount) : BigInt(0);
    return {
      txHash: log.transactionHash,
      block: hex(log.blockNumber),
      recipient: topicAddress(log.topics[1]),
      firstTokenId: hex(log.data) + 1,
      amount,
      cost,
      kind: cost > BigInt(0) ? 'paid' : 'free',
    };
  });
  console.log(`  darknezz: ${logs.length} mint events, ${mints.reduce((n, m) => n + m.amount, 0)} items`);

  const matched = costsForMatchingRecipients(items, mints);
  return { darknezz: [...matched.values()].map(({ mint, item }) => ({ hashId: item.hashId, cost: mint.cost, kind: mint.kind })) };
}

/**
 * Collections airdropped for free: anything the airdrop wallet inscribed to a different wallet is
 * an airdrop. Items it inscribed to itself (or that others self-inscribed) keep gas-based P&L.
 */
function airdropInscriber(slug: string, inscriber: string) {
  return async (supabase: SupabaseClient): Promise<Record<string, MintCost[]>> => {
    const items = await loadItems(supabase, slug);
    const airdrops = items.filter((item) => item.createdFrom === inscriber && item.createdTo !== inscriber);
    console.log(`  ${slug}: ${airdrops.length} of ${items.length} items airdropped by ${inscriber}`);
    return { [slug]: airdrops.map((item) => ({ hashId: item.hashId, cost: BigInt(0), kind: 'airdrop' as MintKind })) };
  };
}

const ADAPTERS: Record<string, (supabase: SupabaseClient) => Promise<Record<string, MintCost[]>>> = {
  'comrades-of-the-dead': comradesOfTheDead,
  nakamingos,
  darknezz,
  // 0xdead.nomorelabs.eth
  'nml-death-certificates': airdropInscriber('nml-death-certificates', '0x0d918e3f3099a77ccbb9ba9d6d27c999e47a821f'),
  // based.snepsid.eth
  moonbirds: airdropInscriber('moonbirds', '0x9426f76973c0c66c2ecbfd9dcdfaf82de3213ef9'),
};

// ----------------------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const collectionsArg = args.find((arg) => arg.startsWith('--collections='))?.split('=')[1]
    ?? args[args.indexOf('--collections') + 1];
  const collections = (collectionsArg || '').split(',').map((c) => c.trim()).filter(Boolean);
  if (!collections.length || collections.some((c) => !ADAPTERS[c])) {
    console.error(`Usage: ts-node scripts/import-mint-costs.ts --collections ${Object.keys(ADAPTERS).join(',')} [--dry-run]`);
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set in .env.supabase');
  const supabase = createClient(url, key);
  console.log(`Importing mint costs into ${url}${dryRun ? ' (dry run)' : ''}`);

  for (const collection of collections) {
    const results = await ADAPTERS[collection](supabase);
    for (const [slug, costs] of Object.entries(results)) await writeMintCosts(supabase, slug, costs, dryRun);
  }
  console.log('Done');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
