#!/usr/bin/env ts-node

/**
 * Hybrid Backfill Collection Script
 *
 * This script onboards an already-inscribed collection without replaying every
 * historical block:
 * 1. Loads collection metadata JSON
 * 2. Validates and normalizes data
 * 3. Populates attributes tables
 * 4. Creates/verifies the collection exists
 * 5. Fetches creation + transfer history from the Ethscriptions API
 * 6. Fetches collection-scoped marketplace, auction, and external wrapper tx hashes from L1 logs
 * 7. Replays the union of those tx blocks through the indexer block path
 *
 * This preserves ownership-sensitive ordering because replay still happens
 * in block order through the existing indexer pipeline.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createHash } from 'crypto';

import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import {
  createPublicClient,
  decodeEventLog,
  hexToString,
  http,
  toHex,
  type Abi,
  type Address,
} from 'viem';
import { mainnet, sepolia } from 'viem/chains';

import { marketL1 } from '../src/abi/market-L1.abi';
import { auctionHouseL1 } from '../src/abi/auction-house-L1.abi';
import {
  EMBLEM_VAULT_METADATA_BASE_URL,
  EMBLEM_VAULT_WRAPPER_ADDRESS_L1,
  ETCH_MARKET_ADDRESS_L1,
  ETCH_MARKET_ORDER_EXECUTED_TOPIC,
  ETHSCRIPTIONS_MARKET_ADDRESS_L1,
  ETHSCRIPTIONS_TRANSFER_PROXY_ADDRESS_L1,
  ETHSCRIPTIONS_TRANSFER_PROXY_INTERNAL_TRANSFER_TOPIC,
  SUPPORTED_ETCH_MARKET_EVENTS,
  SUPPORTED_ETHSCRIPTIONS_MARKET_EVENTS,
  SUPPORTED_ETHSCRIPTIONS_TRANSFER_PROXY_EVENTS,
  etchMarketL1,
  ethscriptionsMarketL1,
  ethscriptionsTransferProxyL1,
} from '../src/modules/external-venues/external-venues.constants';

dotenv.config({ path: '.env.supabase' });

const DEFAULT_LOG_CHUNK_SIZE = 20_000;
const MIN_LOG_CHUNK_SIZE = 250;
const API_BATCH_CONCURRENCY = 50;
const API_MAX_RETRIES = 3;
const EMBLEM_METADATA_BATCH_CONCURRENCY = 25;
const MAX_ERROR_RESPONSE_LENGTH = 500;
const MAX_FAILED_BLOCKS_IN_SUMMARY = 50;
const REINDEX_BLOCK_MAX_ATTEMPTS = 5;
const REINDEX_BLOCK_BASE_DELAY_MS = 10_000;
const DEFAULT_REINDEX_DELAY_MS = 1_000;
const DEFAULT_ETHSCRIPTIONS_API_BASE_URLS = {
  mainnet: 'https://ethscriptions-api.flooredape.io',
  sepolia: 'https://ethscriptions-api-sepolia.flooredape.io',
} as const;
const ERC721_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

const SUPPORTED_MARKET_EVENTS = new Set([
  'PhunkBought',
  'PhunkNoLongerForSale',
  'PhunkOffered',
]);

const SUPPORTED_AUCTION_EVENTS = new Set([
  'AuctionCreated',
  'AuctionBid',
  'AuctionSettled',
]);

interface Attribute {
  trait_type: string;
  value: string;
}

interface CollectionItem {
  id: string;
  index: number;
  sha: string;
  name: string;
  description: string;
  attributes: Attribute[];
}

interface CollectionMetadata {
  name: string;
  slug: string;
  description: string;
  total_supply: number;
  logo_image?: string;
  banner_image?: string;
  website_url?: string;
  twitter_url?: string;
  discord_url?: string;
  background_color?: string;
  collection_items: CollectionItem[];
}

interface EthscriptionTransfer {
  ethscription_transaction_hash: string;
  transaction_hash: string;
  block_number: number;
  transaction_index: number;
  event_log_index: number | null;
  transfer_index: string;
}

interface ShaMismatch {
  id: string;
  index: number;
  name: string;
  metadataSha: string;
  contentSha: string;
}

interface EmblemVaultMetadata {
  values?: Array<{
    coin?: string;
    id?: string;
  }>;
  ownershipInfo?: {
    balances?: Array<{
      coin?: string;
      id?: string;
    }>;
  };
}

interface TransactionToProcess {
  hash: string;
  block_number: number;
  transaction_index: number;
  sources: string[];
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  normalizedItems: CollectionItem[];
  stats: {
    totalItems: number;
    normalizedShas: number;
    duplicateIndexes: Map<number, string[]>;
    duplicateShas: Map<string, number[]>;
    missingNames: number;
    missingEthscriptionNumbers: number;
    indexGaps: number[];
  };
}

interface HybridBackfillOptions {
  metadata?: string;
  indexerUrl: string;
  apiKey?: string;
  network: 'mainnet' | 'sepolia';
  dryRun: boolean;
  strict: boolean;
  force: boolean;
  fromBlock?: number;
  toBlock?: number;
  logChunkSize: number;
  reindexDelayMs: number;
  chainId: number;
  tableSuffix: string;
  apiBaseUrl: string;
}

interface RpcLog {
  address: Address;
  blockHash: `0x${string}` | null;
  blockNumber: `0x${string}` | null;
  data: `0x${string}`;
  logIndex: `0x${string}` | null;
  removed: boolean;
  topics: `0x${string}`[];
  transactionHash: `0x${string}` | null;
  transactionIndex: `0x${string}` | null;
}

const HEX_64 = /^[0-9a-f]{64}$/i;
const HEX_66 = /^0x[0-9a-f]{64}$/i;

function promptForInput(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseArgs(): HybridBackfillOptions {
  const args = process.argv.slice(2);
  let apiBaseUrlOverride: string | undefined;
  const options: HybridBackfillOptions = {
    indexerUrl: 'http://localhost:3069',
    network: 'mainnet',
    dryRun: false,
    strict: true,
    force: false,
    logChunkSize: DEFAULT_LOG_CHUNK_SIZE,
    reindexDelayMs: DEFAULT_REINDEX_DELAY_MS,
    chainId: 1,
    tableSuffix: '',
    apiBaseUrl: DEFAULT_ETHSCRIPTIONS_API_BASE_URLS.mainnet,
  };

  args.forEach((arg, index) => {
    if (arg.startsWith('--metadata=')) {
      options.metadata = arg.split('=')[1];
    } else if (arg === '--metadata' && args[index + 1]) {
      options.metadata = args[index + 1];
    } else if (arg.startsWith('--indexer-url=')) {
      options.indexerUrl = arg.split('=')[1];
    } else if (arg === '--indexer-url' && args[index + 1]) {
      options.indexerUrl = args[index + 1];
    } else if (arg.startsWith('--api-key=')) {
      options.apiKey = arg.split('=')[1];
    } else if (arg === '--api-key' && args[index + 1]) {
      options.apiKey = args[index + 1];
    } else if (arg.startsWith('--api-base-url=')) {
      apiBaseUrlOverride = arg.split('=')[1];
    } else if (arg === '--api-base-url' && args[index + 1]) {
      apiBaseUrlOverride = args[index + 1];
    } else if (arg.startsWith('--ethscriptions-api-base-url=')) {
      apiBaseUrlOverride = arg.split('=')[1];
    } else if (arg === '--ethscriptions-api-base-url' && args[index + 1]) {
      apiBaseUrlOverride = args[index + 1];
    } else if (arg.startsWith('--network=')) {
      const network = arg.split('=')[1].toLowerCase();
      if (network !== 'mainnet' && network !== 'sepolia') {
        console.error('Error: --network must be either "mainnet" or "sepolia"');
        process.exit(1);
      }
      options.network = network;
    } else if (arg === '--network' && args[index + 1]) {
      const network = args[index + 1].toLowerCase();
      if (network !== 'mainnet' && network !== 'sepolia') {
        console.error('Error: --network must be either "mainnet" or "sepolia"');
        process.exit(1);
      }
      options.network = network as 'mainnet' | 'sepolia';
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--no-strict') {
      options.strict = false;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg.startsWith('--from-block=')) {
      options.fromBlock = Number(arg.split('=')[1]);
    } else if (arg === '--from-block' && args[index + 1]) {
      options.fromBlock = Number(args[index + 1]);
    } else if (arg.startsWith('--to-block=')) {
      options.toBlock = Number(arg.split('=')[1]);
    } else if (arg === '--to-block' && args[index + 1]) {
      options.toBlock = Number(args[index + 1]);
    } else if (arg.startsWith('--log-chunk-size=')) {
      options.logChunkSize = Number(arg.split('=')[1]);
    } else if (arg === '--log-chunk-size' && args[index + 1]) {
      options.logChunkSize = Number(args[index + 1]);
    } else if (arg.startsWith('--reindex-delay-ms=')) {
      options.reindexDelayMs = Number(arg.split('=')[1]);
    } else if (arg === '--reindex-delay-ms' && args[index + 1]) {
      options.reindexDelayMs = Number(args[index + 1]);
    }
  });

  // Load network-specific environment first so it can override base defaults.
  dotenv.config({ path: `.env.${options.network}` });
  dotenv.config({ path: '.env' });

  if (!options.apiKey) {
    options.apiKey = process.env.API_PRIVATE_KEY;
    if (!options.apiKey) {
      console.error('Error: API key required. Provide via --api-key or set API_PRIVATE_KEY in .env');
      process.exit(1);
    }
  }

  if (options.fromBlock !== undefined && Number.isNaN(options.fromBlock)) {
    console.error('Error: --from-block must be a number');
    process.exit(1);
  }

  if (options.toBlock !== undefined && Number.isNaN(options.toBlock)) {
    console.error('Error: --to-block must be a number');
    process.exit(1);
  }

  if (!options.logChunkSize || Number.isNaN(options.logChunkSize) || options.logChunkSize < MIN_LOG_CHUNK_SIZE) {
    console.error(`Error: --log-chunk-size must be a number >= ${MIN_LOG_CHUNK_SIZE}`);
    process.exit(1);
  }

  if (Number.isNaN(options.reindexDelayMs) || options.reindexDelayMs < 0) {
    console.error('Error: --reindex-delay-ms must be a number >= 0');
    process.exit(1);
  }

  options.chainId = options.network === 'mainnet' ? 1 : 11155111;
  options.tableSuffix = options.network === 'sepolia' ? '_sepolia' : '';
  options.apiBaseUrl = (
    apiBaseUrlOverride ||
    process.env.ETHSCRIPTIONS_API_BASE_URL ||
    DEFAULT_ETHSCRIPTIONS_API_BASE_URLS[options.network]
  ).replace(/\/$/, '');

  return options;
}

function initSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set in .env.supabase');
    process.exit(1);
  }

  return createClient(supabaseUrl, supabaseKey);
}

function initL1Client(network: 'mainnet' | 'sepolia') {
  const rpcUrl = process.env.RPC_URL_L1;
  if (!rpcUrl) {
    console.error('Error: RPC_URL_L1 must be set in the network env file');
    process.exit(1);
  }

  return createPublicClient({
    chain: network === 'mainnet' ? mainnet : sepolia,
    transport: http(rpcUrl),
  });
}

function getRequiredAddress(name: string): Address {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: ${name} must be set in the network env file`);
    process.exit(1);
  }
  return value.toLowerCase() as Address;
}

function getOptionalAddress(name: string): Address | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  return value.toLowerCase() as Address;
}

async function findContractDeploymentBlock(
  client: ReturnType<typeof initL1Client>,
  address: Address,
  latestBlock: number,
): Promise<number> {
  let low = 0;
  let high = latestBlock;
  let firstCodeBlock = latestBlock;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const code = await client.getCode({
      address,
      blockNumber: BigInt(mid),
    });

    if (code && code !== '0x') {
      firstCodeBlock = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return firstCodeBlock;
}

async function loadMetadata(metadataPath: string): Promise<CollectionMetadata> {
  console.log(`\nLoading metadata from: ${metadataPath}`);

  let metadata: CollectionMetadata;

  if (metadataPath.startsWith('http://') || metadataPath.startsWith('https://')) {
    const response = await fetch(metadataPath);
    if (!response.ok) {
      console.error(`Error: Failed to fetch metadata: ${response.status} ${response.statusText}`);
      process.exit(1);
    }
    metadata = await response.json() as CollectionMetadata;
  } else {
    const resolvedPath = path.resolve(metadataPath);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`Error: Metadata file not found at ${resolvedPath}`);
      process.exit(1);
    }

    metadata = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  }

  console.log(`Loaded metadata for "${metadata.name}" (${metadata.collection_items.length} items)`);
  return metadata;
}

function validateAndNormalizeMetadata(metadata: CollectionMetadata): ValidationResult {
  console.log('\nValidating metadata...');

  const errors: string[] = [];
  const warnings: string[] = [];
  const normalizedItems: CollectionItem[] = [];

  const stats = {
    totalItems: metadata.collection_items.length,
    normalizedShas: 0,
    duplicateIndexes: new Map<number, string[]>(),
    duplicateShas: new Map<string, number[]>(),
    missingNames: 0,
    missingEthscriptionNumbers: 0,
    indexGaps: [] as number[],
  };

  const seenIndexes = new Map<number, string>();
  const seenShas = new Map<string, number>();
  const allIndexes: number[] = [];

  for (let i = 0; i < metadata.collection_items.length; i++) {
    const item = { ...metadata.collection_items[i] };

    if (!item.id) {
      errors.push(`Item ${i}: Missing required field 'id'`);
      continue;
    }
    if (!item.sha) {
      errors.push(`Item ${i}: Missing required field 'sha'`);
      continue;
    }
    if (item.index === undefined || item.index === null) {
      errors.push(`Item ${i}: Missing required field 'index'`);
      continue;
    }

    const normalizedId = item.id.toLowerCase();
    if (!HEX_66.test(normalizedId)) {
      errors.push(`Item ${i} (index ${item.index}): Invalid ID format '${item.id}' - must be 0x + 64 hex chars`);
      continue;
    }
    item.id = normalizedId;

    let normalizedSha = item.sha.toLowerCase();
    if (normalizedSha.startsWith('0x')) {
      normalizedSha = normalizedSha.slice(2);
      stats.normalizedShas++;
    }

    if (!HEX_64.test(normalizedSha)) {
      errors.push(`Item ${i} (index ${item.index}): Invalid SHA format '${item.sha}' - must be 64 char hex`);
      continue;
    }
    item.sha = normalizedSha;

    const indexNum = Number(item.index);
    if (Number.isNaN(indexNum) || !Number.isInteger(indexNum)) {
      errors.push(`Item ${i}: Invalid index '${item.index}' - must be an integer`);
      continue;
    }
    item.index = indexNum;
    allIndexes.push(indexNum);

    if (seenIndexes.has(indexNum)) {
      if (!stats.duplicateIndexes.has(indexNum)) {
        stats.duplicateIndexes.set(indexNum, [seenIndexes.get(indexNum)!]);
      }
      stats.duplicateIndexes.get(indexNum)!.push(item.id);
      warnings.push(`Item ${i}: Duplicate index ${indexNum} (also used by ${seenIndexes.get(indexNum)})`);
    } else {
      seenIndexes.set(indexNum, item.id);
    }

    if (seenShas.has(normalizedSha)) {
      if (!stats.duplicateShas.has(normalizedSha)) {
        stats.duplicateShas.set(normalizedSha, [seenShas.get(normalizedSha)!]);
      }
      stats.duplicateShas.get(normalizedSha)!.push(indexNum);
      warnings.push(`Item ${i}: Duplicate SHA ${normalizedSha.slice(0, 16)}... (also used by index ${seenShas.get(normalizedSha)})`);
    } else {
      seenShas.set(normalizedSha, indexNum);
    }

    if (!item.name || item.name.trim() === '') {
      stats.missingNames++;
      warnings.push(`Item ${i} (index ${indexNum}): Missing 'name' field`);
    }

    if (!(item as Record<string, unknown>).ethscription_number) {
      stats.missingEthscriptionNumbers++;
    }

    normalizedItems.push(item);
  }

  if (allIndexes.length > 0) {
    const sortedIndexes = [...allIndexes].sort((a, b) => a - b);
    const minIndex = sortedIndexes[0];
    const maxIndex = sortedIndexes[sortedIndexes.length - 1];
    const indexSet = new Set(sortedIndexes);

    for (let i = minIndex; i <= maxIndex; i++) {
      if (!indexSet.has(i)) stats.indexGaps.push(i);
    }

    if (stats.indexGaps.length > 0) {
      const gapPreview = stats.indexGaps.slice(0, 5).join(', ');
      const moreCount = stats.indexGaps.length > 5 ? ` and ${stats.indexGaps.length - 5} more` : '';
      warnings.push(`Index gaps detected: ${gapPreview}${moreCount} (total: ${stats.indexGaps.length} gaps in range ${minIndex}-${maxIndex})`);
    }
  }

  console.log(`  Total items: ${stats.totalItems}`);
  console.log(`  Valid items: ${normalizedItems.length}`);
  console.log(`  Normalized SHAs: ${stats.normalizedShas}`);
  if (errors.length) console.log(`  Errors: ${errors.length}`);
  if (warnings.length) console.log(`  Warnings: ${warnings.length}`);

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    normalizedItems,
    stats,
  };
}

async function checkCollectionExists(supabase: any, slug: string, tableSuffix: string): Promise<boolean> {
  const { data, error } = await supabase
    .from(`collections${tableSuffix}`)
    .select('slug')
    .eq('slug', slug)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return !!data;
}

async function checkDuplicateIdsInDatabase(
  supabase: any,
  items: CollectionItem[],
  tableSuffix: string,
): Promise<{ duplicates: Array<{ id: string; index: number; existingSlug: string }> }> {
  const duplicates: Array<{ id: string; index: number; existingSlug: string }> = [];
  const batchSize = 100;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const ids = batch.map((item) => item.id);

    const { data, error } = await supabase
      .from(`ethscriptions${tableSuffix}`)
      .select('hashId, slug')
      .in('hashId', ids);

    if (error) throw error;

    if (data && data.length > 0) {
      data.forEach((existing: any) => {
        const item = batch.find((batchItem) => batchItem.id.toLowerCase() === existing.hashId?.toLowerCase());
        if (item) {
          duplicates.push({
            id: existing.hashId,
            index: item.index,
            existingSlug: existing.slug,
          });
        }
      });
    }
  }

  return { duplicates };
}

const ATTRIBUTE_ORDER = [
  'Type',
  'Featured Artist',
  '1 of 1',
  'Origin',
  'Vest/Armor',
  'Tie',
  'Smoke',
  'Shirt/Jacket',
  'Ninja Outfit',
  'Mouth',
  'Mask',
  'Headphones',
  'Headband',
  'Hat/Helmet',
  'Hair',
  'Glasses',
  'Facial',
  'Chain',
  'Cape',
  'Balloon',
  'Background',
  'Power/Strength',
  'Speed/Agility',
  'Wisdom/Magic',
];

async function populateAttributes(supabase: any, slug: string, items: CollectionItem[]) {
  console.log(`\nPopulating attributes for ${items.length} items...`);

  const attributeRecords = items.map((item) => {
    const unorderedValues = item.attributes?.reduce((acc: Record<string, string | string[]>, attr) => {
      const { trait_type, value } = attr;
      const existing = acc[trait_type];
      if (existing !== undefined) {
        acc[trait_type] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        acc[trait_type] = value;
      }
      return acc;
    }, {});

    const values: Record<string, string | string[]> = {};
    ATTRIBUTE_ORDER.forEach((key) => {
      if (unorderedValues && unorderedValues[key] !== undefined) values[key] = unorderedValues[key];
    });

    if (unorderedValues) {
      Object.keys(unorderedValues).forEach((key) => {
        if (!ATTRIBUTE_ORDER.includes(key)) values[key] = unorderedValues[key];
      });
    }

    if (hasCustomName(item)) values.Name = item.name;
    if (item.description) values.Description = item.description;

    return {
      slug,
      sha: item.sha,
      values,
      tokenId: item.index,
    };
  });

  const { error: errorNew } = await supabase
    .from('attributes_new')
    .upsert(attributeRecords, { onConflict: 'sha' });
  if (errorNew) throw errorNew;

  const { error: errorLegacy } = await supabase
    .from('attributes')
    .upsert(attributeRecords, { onConflict: 'sha' });
  if (errorLegacy) throw errorLegacy;

  console.log(`Populated ${attributeRecords.length} attribute records`);
}

function deriveSingleNameFromSlug(slug: string): string {
  return slug.endsWith('s') ? slug.slice(0, -1) : slug;
}

function hasCustomName(item: CollectionItem): boolean {
  if (!item.name) return false;
  return !new RegExp(`\\s#?${item.index}$`).test(item.name.trim());
}

async function resolveCollectionImage(
  client: ReturnType<typeof initL1Client>,
  logoImage?: string,
): Promise<string | null> {
  if (!logoImage) return null;

  const match = logoImage.match(/^esc:\/\/ethscriptions\/(0x[0-9a-f]{64})\/data$/i);
  if (!match) return logoImage;

  try {
    const tx = await client.getTransaction({ hash: match[1] as `0x${string}` });
    return hexToString(tx.input).replace(/\x00/g, '');
  } catch (error) {
    console.warn(`Could not resolve logo_image ${logoImage}:`, error);
    return logoImage;
  }
}

async function ensureCollection(
  supabase: any,
  client: ReturnType<typeof initL1Client>,
  metadata: CollectionMetadata,
  tableSuffix: string,
) {
  const singleName = deriveSingleNameFromSlug(metadata.slug);
  const image = await resolveCollectionImage(client, metadata.logo_image);
  const desiredValues = {
    name: metadata.name,
    singleName,
    image,
    description: metadata.description,
    supply: metadata.total_supply,
    active: true,
    website: metadata.website_url,
    twitter: metadata.twitter_url?.replace('https://x.com/', ''),
    discord: metadata.discord_url,
    defaultBackground: metadata.background_color,
  };
  const { data: existing, error } = await supabase
    .from(`collections${tableSuffix}`)
    .select('*')
    .eq('slug', metadata.slug)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  if (existing) {
    const updates = Object.fromEntries(
      Object.entries(desiredValues).filter(([key, value]) => existing[key] !== value),
    );

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await supabase
        .from(`collections${tableSuffix}`)
        .update(updates)
        .eq('slug', metadata.slug);

      if (updateError) throw updateError;
      console.log(`Updated collection "${metadata.slug}" fields: ${Object.keys(updates).join(', ')}`);
    }

    console.log(`Collection "${metadata.slug}" already exists`);
    return;
  }

  const { error: createError } = await supabase
    .from(`collections${tableSuffix}`)
    .insert({
      slug: metadata.slug,
      ...desiredValues,
    });

  if (createError) throw createError;
  console.log(`Created collection "${metadata.slug}"`);
}

async function fetchEthscriptionData(
  items: CollectionItem[],
  apiBaseUrl: string,
): Promise<{
  creations: TransactionToProcess[];
  transfers: EthscriptionTransfer[];
  shaMismatches: ShaMismatch[];
  missingCreations: Array<Pick<CollectionItem, 'id' | 'index' | 'name' | 'sha'>>;
}> {
  console.log(`\nFetching Ethscriptions API data for ${items.length} items...`);

  const allCreations: TransactionToProcess[] = [];
  const allTransfers: EthscriptionTransfer[] = [];
  const shaMismatches: ShaMismatch[] = [];
  const missingCreations: Array<Pick<CollectionItem, 'id' | 'index' | 'name' | 'sha'>> = [];

  async function fetchItemData(
    item: CollectionItem,
    index: number,
  ): Promise<{
    creation: TransactionToProcess | null;
    transfers: EthscriptionTransfer[];
    shaMismatch: ShaMismatch | null;
  }> {
    const ethscriptionHash = item.id;
    if (!ethscriptionHash) return { creation: null, transfers: [], shaMismatch: null };

    if (index % 100 === 0) {
      console.log(`  Ethscriptions API progress: ${index}/${items.length}`);
    }

    let retries = 0;
    let success = false;
    let creation: TransactionToProcess | null = null;
    let transfers: EthscriptionTransfer[] = [];
    let shaMismatch: ShaMismatch | null = null;

    while (retries < API_MAX_RETRIES && !success) {
      try {
        const response = await fetch(`${apiBaseUrl}/ethscriptions/${ethscriptionHash}`);
        if (!response.ok) {
          if (retries < API_MAX_RETRIES - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * (retries + 1)));
            retries++;
            continue;
          }
          break;
        }

        const data = await response.json() as any;
        const ethscription = data.result ?? data;

        if (ethscription) {
          creation = {
            hash: ethscription.transaction_hash.toLowerCase(),
            block_number: parseInt(ethscription.block_number, 10),
            transaction_index: parseInt(ethscription.transaction_index, 10),
            sources: ['ethscriptions-api:creation'],
          };

          if (Array.isArray(ethscription.ethscription_transfers)) {
            transfers = ethscription.ethscription_transfers;
          }

          if (typeof ethscription.content_uri === 'string') {
            const contentSha = createHash('sha256').update(ethscription.content_uri).digest('hex');
            if (contentSha !== item.sha.toLowerCase()) {
              shaMismatch = {
                id: item.id.toLowerCase(),
                index: item.index,
                name: item.name,
                metadataSha: item.sha.toLowerCase(),
                contentSha,
              };
            }
          }
        }

        success = true;
      } catch (_error) {
        if (retries < API_MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (retries + 1)));
          retries++;
        } else {
          break;
        }
      }
    }

    return { creation, transfers, shaMismatch };
  }

  for (let i = 0; i < items.length; i += API_BATCH_CONCURRENCY) {
    const batch = items.slice(i, i + API_BATCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((item, batchIndex) => fetchItemData(item, i + batchIndex)),
    );

    batchResults.forEach(({ creation, transfers, shaMismatch }, batchIndex) => {
      if (creation) allCreations.push(creation);
      else {
        const item = batch[batchIndex];
        missingCreations.push({
          id: item.id.toLowerCase(),
          index: item.index,
          name: item.name,
          sha: item.sha.toLowerCase(),
        });
      }
      allTransfers.push(...transfers);
      if (shaMismatch) shaMismatches.push(shaMismatch);
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log(`Fetched ${allCreations.length} creations and ${allTransfers.length} transfers from the Ethscriptions API`);
  return { creations: allCreations, transfers: allTransfers, shaMismatches, missingCreations };
}

function extractCollectionHashId(args: Record<string, unknown>): string | null {
  const raw =
    args.hashId ||
    args.phunkId ||
    args.potentialEthscriptionId ||
    args.id ||
    args.ethscriptionId ||
    args.itemId;

  if (!raw) return null;
  if (typeof raw === 'bigint') return toHex(raw, { size: 32 }).toLowerCase();
  if (typeof raw !== 'string') return null;
  return raw.toLowerCase();
}

function extractEmblemVaultHashId(metadata: EmblemVaultMetadata): string | null {
  const balances = [
    ...(metadata.values || []),
    ...(metadata.ownershipInfo?.balances || []),
  ];

  const ethscription = balances.find((balance) => (
    balance.coin === 'ethscription' &&
    typeof balance.id === 'string' &&
    HEX_66.test(balance.id)
  ));

  return ethscription?.id?.toLowerCase() || null;
}

async function fetchEmblemVaultHashIdForToken(
  tokenId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(tokenId)) return cache.get(tokenId)!;

  let retries = 0;
  while (retries < API_MAX_RETRIES) {
    try {
      const response = await fetch(`${EMBLEM_VAULT_METADATA_BASE_URL}/${tokenId}`);
      if (!response.ok) {
        if (retries < API_MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (retries + 1)));
          retries++;
          continue;
        }

        cache.set(tokenId, null);
        return null;
      }

      const metadata = await response.json() as EmblemVaultMetadata;
      const hashId = extractEmblemVaultHashId(metadata);
      cache.set(tokenId, hashId);
      return hashId;
    } catch (_error) {
      if (retries < API_MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (retries + 1)));
        retries++;
        continue;
      }

      cache.set(tokenId, null);
      return null;
    }
  }

  cache.set(tokenId, null);
  return null;
}

async function fetchEmblemVaultWrapperTransactions(params: {
  client: ReturnType<typeof initL1Client>;
  address: Address;
  fromBlock: number;
  toBlock: number;
  chunkSize: number;
  collectionHashIds: Set<string>;
  metadataCache: Map<string, string | null>;
}): Promise<TransactionToProcess[]> {
  console.log(`\nFetching emblem-vault-wrapper-log logs from block ${params.fromBlock} to ${params.toBlock}...`);

  const transactionsByTokenId = new Map<string, TransactionToProcess[]>();
  let currentChunkSize = params.chunkSize;
  let startBlock = params.fromBlock;
  let scannedLogs = 0;

  while (startBlock <= params.toBlock) {
    const endBlock = Math.min(startBlock + currentChunkSize - 1, params.toBlock);

    try {
      const logs = await params.client.request({
        method: 'eth_getLogs',
        params: [{
          address: params.address,
          fromBlock: toHex(startBlock),
          toBlock: toHex(endBlock),
          topics: [ERC721_TRANSFER_TOPIC],
        }],
      }) as RpcLog[];

      for (const log of logs) {
        if (!log.transactionHash || log.blockNumber === null || log.transactionIndex === null) continue;
        const tokenTopic = log.topics[3];
        if (!tokenTopic) continue;

        scannedLogs++;

        const tokenId = BigInt(tokenTopic).toString();
        const txHash = log.transactionHash.toLowerCase();
        const transactions = transactionsByTokenId.get(tokenId) || [];
        transactions.push({
          hash: txHash,
          block_number: Number(BigInt(log.blockNumber)),
          transaction_index: Number(BigInt(log.transactionIndex)),
          sources: ['emblem-vault-wrapper-log'],
        });
        transactionsByTokenId.set(tokenId, transactions);
      }

      console.log(
        `  emblem-vault-wrapper-log: scanned blocks ${startBlock}-${endBlock}, ` +
        `wrapper logs ${scannedLogs}, unique wrapper tokens ${transactionsByTokenId.size}`,
      );
      startBlock = endBlock + 1;

      if (currentChunkSize < params.chunkSize) {
        currentChunkSize = Math.min(params.chunkSize, currentChunkSize * 2);
      }
    } catch (error) {
      if (currentChunkSize <= MIN_LOG_CHUNK_SIZE) {
        throw error;
      }

      currentChunkSize = Math.max(MIN_LOG_CHUNK_SIZE, Math.floor(currentChunkSize / 2));
      console.warn(`  emblem-vault-wrapper-log: log query failed for ${startBlock}-${endBlock}. Retrying with chunk size ${currentChunkSize}...`);
    }
  }

  const tokenIds = Array.from(transactionsByTokenId.keys());
  const matchingTokenIds: string[] = [];

  console.log(`Resolving ${tokenIds.length} Emblem wrapper token metadata records...`);
  for (let i = 0; i < tokenIds.length; i += EMBLEM_METADATA_BATCH_CONCURRENCY) {
    const batch = tokenIds.slice(i, i + EMBLEM_METADATA_BATCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (tokenId) => ({
        tokenId,
        hashId: await fetchEmblemVaultHashIdForToken(tokenId, params.metadataCache),
      })),
    );

    batchResults.forEach(({ tokenId, hashId }) => {
      if (hashId && params.collectionHashIds.has(hashId)) {
        matchingTokenIds.push(tokenId);
      }
    });

    if (i % (EMBLEM_METADATA_BATCH_CONCURRENCY * 10) === 0) {
      console.log(`  Emblem metadata progress: ${Math.min(i + batch.length, tokenIds.length)}/${tokenIds.length}, matched tokens ${matchingTokenIds.length}`);
    }
  }

  const txs = new Map<string, TransactionToProcess>();
  matchingTokenIds.forEach((tokenId) => {
    const tokenTransactions = transactionsByTokenId.get(tokenId) || [];
    tokenTransactions.forEach((tx) => {
      const existing = txs.get(tx.hash);
      if (existing) {
        tx.sources.forEach((source) => {
          if (!existing.sources.includes(source)) existing.sources.push(source);
        });
        return;
      }

      txs.set(tx.hash, { ...tx, sources: [...tx.sources] });
    });
  });

  console.log(
    `Completed emblem-vault-wrapper-log scan: ${matchingTokenIds.length} matching wrapper tokens, ` +
    `${txs.size} unique txs`,
  );

  return Array.from(txs.values());
}

async function fetchCollectionScopedContractTransactions(params: {
  label: string;
  client: ReturnType<typeof initL1Client>;
  address: Address;
  abi: Abi;
  fromBlock: number;
  toBlock: number;
  chunkSize: number;
  supportedEvents: Set<string>;
  collectionHashIds: Set<string>;
  topic0?: `0x${string}` | `0x${string}`[];
}): Promise<TransactionToProcess[]> {
  console.log(`\nFetching ${params.label} logs from block ${params.fromBlock} to ${params.toBlock}...`);

  const txs = new Map<string, TransactionToProcess>();
  let currentChunkSize = params.chunkSize;
  let startBlock = params.fromBlock;
  let matchedLogs = 0;

  while (startBlock <= params.toBlock) {
    const endBlock = Math.min(startBlock + currentChunkSize - 1, params.toBlock);

    try {
      const logs = await params.client.request({
        method: 'eth_getLogs',
        params: [{
          address: params.address,
          fromBlock: toHex(startBlock),
          toBlock: toHex(endBlock),
          ...(params.topic0 ? { topics: [params.topic0] } : {}),
        }],
      }) as RpcLog[];

      for (const log of logs) {
        let decoded: any;
        try {
          decoded = decodeEventLog({
            abi: params.abi,
            data: log.data,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          });
        } catch (_error) {
          continue;
        }

        if (!params.supportedEvents.has(decoded.eventName)) continue;

        const hashId = extractCollectionHashId(decoded.args as Record<string, unknown>);
        if (!hashId || !params.collectionHashIds.has(hashId)) continue;
        if (!log.transactionHash || log.blockNumber === null || log.transactionIndex === null) continue;

        matchedLogs++;

        const txHash = log.transactionHash.toLowerCase();
        const existing = txs.get(txHash);
        if (existing) {
          if (!existing.sources.includes(params.label)) existing.sources.push(params.label);
          continue;
        }

        txs.set(txHash, {
          hash: txHash,
          block_number: Number(BigInt(log.blockNumber)),
          transaction_index: Number(BigInt(log.transactionIndex)),
          sources: [params.label],
        });
      }

      console.log(`  ${params.label}: scanned blocks ${startBlock}-${endBlock}, matched logs so far ${matchedLogs}, unique txs ${txs.size}`);
      startBlock = endBlock + 1;

      if (currentChunkSize < params.chunkSize) {
        currentChunkSize = Math.min(params.chunkSize, currentChunkSize * 2);
      }
    } catch (error) {
      if (currentChunkSize <= MIN_LOG_CHUNK_SIZE) {
        throw error;
      }

      currentChunkSize = Math.max(MIN_LOG_CHUNK_SIZE, Math.floor(currentChunkSize / 2));
      console.warn(`  ${params.label}: log query failed for ${startBlock}-${endBlock}. Retrying with chunk size ${currentChunkSize}...`);
    }
  }

  console.log(`Completed ${params.label} log scan: ${matchedLogs} matched logs, ${txs.size} unique txs`);
  return Array.from(txs.values());
}

function combineAndSortTransactions(
  txGroups: Array<{ name: string; transactions: TransactionToProcess[] }>,
): TransactionToProcess[] {
  const transactionMap = new Map<string, TransactionToProcess>();

  txGroups.forEach(({ transactions }) => {
    transactions.forEach((tx) => {
      const hash = tx.hash.toLowerCase();
      const existing = transactionMap.get(hash);
      if (existing) {
        tx.sources.forEach((source) => {
          if (!existing.sources.includes(source)) existing.sources.push(source);
        });
        return;
      }

      transactionMap.set(hash, {
        hash,
        block_number: tx.block_number,
        transaction_index: tx.transaction_index,
        sources: [...tx.sources],
      });
    });
  });

  return Array.from(transactionMap.values()).sort((a, b) => {
    if (a.block_number !== b.block_number) return a.block_number - b.block_number;
    if (a.transaction_index !== b.transaction_index) return a.transaction_index - b.transaction_index;
    return a.hash.localeCompare(b.hash);
  });
}

async function collectTransactionsForRange(params: {
  client: ReturnType<typeof initL1Client>;
  network: 'mainnet' | 'sepolia';
  marketAddress: Address;
  auctionHouseAddress?: Address;
  ethscriptionsMarketAddress: Address;
  etchMarketAddress: Address;
  ethscriptionsTransferProxyAddress: Address;
  emblemVaultWrapperAddress: Address;
  fromBlock: number;
  toBlock: number;
  logChunkSize: number;
  collectionHashIds: Set<string>;
  emblemMetadataCache: Map<string, string | null>;
  creations: TransactionToProcess[];
  transferTransactions: TransactionToProcess[];
  marketDeploymentBlock: number;
  auctionDeploymentBlock: number;
  ethscriptionsMarketDeploymentBlock: number;
  etchMarketDeploymentBlock: number;
  ethscriptionsTransferProxyDeploymentBlock: number;
  emblemVaultWrapperDeploymentBlock: number;
}) {
  const creationTransactions = params.creations.filter(
    (tx) => tx.block_number >= params.fromBlock && tx.block_number <= params.toBlock,
  );
  const filteredTransferTransactions = params.transferTransactions.filter(
    (tx) => tx.block_number >= params.fromBlock && tx.block_number <= params.toBlock,
  );

  const marketTransactions = await fetchCollectionScopedContractTransactions({
    label: 'marketplace-log',
    client: params.client,
    address: params.marketAddress,
    abi: marketL1 as Abi,
    fromBlock: Math.max(params.fromBlock, params.marketDeploymentBlock),
    toBlock: params.toBlock,
    chunkSize: params.logChunkSize,
    supportedEvents: SUPPORTED_MARKET_EVENTS,
    collectionHashIds: params.collectionHashIds,
  });

  const auctionTransactions = params.auctionHouseAddress
    ? await fetchCollectionScopedContractTransactions({
      label: 'auction-log',
      client: params.client,
      address: params.auctionHouseAddress,
      abi: auctionHouseL1 as Abi,
      fromBlock: Math.max(params.fromBlock, params.auctionDeploymentBlock),
      toBlock: params.toBlock,
      chunkSize: params.logChunkSize,
      supportedEvents: SUPPORTED_AUCTION_EVENTS,
      collectionHashIds: params.collectionHashIds,
    })
    : [];

  const ethscriptionsMarketTransactions = params.network === 'mainnet'
    ? await fetchCollectionScopedContractTransactions({
      label: 'ethscriptions-market-log',
      client: params.client,
      address: params.ethscriptionsMarketAddress,
      abi: ethscriptionsMarketL1 as Abi,
      fromBlock: Math.max(params.fromBlock, params.ethscriptionsMarketDeploymentBlock),
      toBlock: params.toBlock,
      chunkSize: params.logChunkSize,
      supportedEvents: SUPPORTED_ETHSCRIPTIONS_MARKET_EVENTS,
      collectionHashIds: params.collectionHashIds,
    })
    : [];

  const etchMarketTransactions = params.network === 'mainnet'
    ? await fetchCollectionScopedContractTransactions({
      label: 'etch-market-log',
      client: params.client,
      address: params.etchMarketAddress,
      abi: etchMarketL1 as Abi,
      fromBlock: Math.max(params.fromBlock, params.etchMarketDeploymentBlock),
      toBlock: params.toBlock,
      chunkSize: params.logChunkSize,
      supportedEvents: SUPPORTED_ETCH_MARKET_EVENTS,
      collectionHashIds: params.collectionHashIds,
      topic0: ETCH_MARKET_ORDER_EXECUTED_TOPIC,
    })
    : [];

  const ethscriptionsTransferProxyTransactions = params.network === 'mainnet'
    ? await fetchCollectionScopedContractTransactions({
      label: 'ethscriptions-transfer-proxy-log',
      client: params.client,
      address: params.ethscriptionsTransferProxyAddress,
      abi: ethscriptionsTransferProxyL1 as Abi,
      fromBlock: Math.max(params.fromBlock, params.ethscriptionsTransferProxyDeploymentBlock),
      toBlock: params.toBlock,
      chunkSize: params.logChunkSize,
      supportedEvents: SUPPORTED_ETHSCRIPTIONS_TRANSFER_PROXY_EVENTS,
      collectionHashIds: params.collectionHashIds,
      topic0: ETHSCRIPTIONS_TRANSFER_PROXY_INTERNAL_TRANSFER_TOPIC,
    })
    : [];

  const emblemVaultWrapperTransactions = params.network === 'mainnet'
    ? await fetchEmblemVaultWrapperTransactions({
      client: params.client,
      address: params.emblemVaultWrapperAddress,
      fromBlock: Math.max(params.fromBlock, params.emblemVaultWrapperDeploymentBlock),
      toBlock: params.toBlock,
      chunkSize: params.logChunkSize,
      collectionHashIds: params.collectionHashIds,
      metadataCache: params.emblemMetadataCache,
    })
    : [];

  const transactions = combineAndSortTransactions([
    { name: 'creations', transactions: creationTransactions },
    { name: 'transfers', transactions: filteredTransferTransactions },
    { name: 'market', transactions: marketTransactions },
    { name: 'auction', transactions: auctionTransactions },
    { name: 'ethscriptions-market', transactions: ethscriptionsMarketTransactions },
    { name: 'etch-market', transactions: etchMarketTransactions },
    { name: 'ethscriptions-transfer-proxy', transactions: ethscriptionsTransferProxyTransactions },
    { name: 'emblem-vault-wrapper', transactions: emblemVaultWrapperTransactions },
  ]);

  return {
    transactions,
    creationTransactions,
    filteredTransferTransactions,
    marketTransactions,
    auctionTransactions,
    ethscriptionsMarketTransactions,
    etchMarketTransactions,
    ethscriptionsTransferProxyTransactions,
    emblemVaultWrapperTransactions,
  };
}

function getUniqueSortedBlockNumbers(transactions: TransactionToProcess[]): number[] {
  return Array.from(new Set(transactions.map((tx) => tx.block_number))).sort((a, b) => a - b);
}

function summarizeResponseBody(body: string): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  if (normalized.length <= MAX_ERROR_RESPONSE_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_ERROR_RESPONSE_LENGTH)}...`;
}

function summarizeFailedBlocks(failedBlocks: number[]): string {
  if (!failedBlocks.length) return 'none';

  const preview = failedBlocks.slice(0, MAX_FAILED_BLOCKS_IN_SUMMARY);
  if (preview.length === failedBlocks.length) {
    return preview.join(', ');
  }

  return `${preview.join(', ')} ... (+${failedBlocks.length - preview.length} more)`;
}

function isRetryableReindexStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 504);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processBlocks(
  blockNumbers: number[],
  transactions: TransactionToProcess[],
  indexerUrl: string,
  apiKey: string,
  dryRun: boolean,
  reindexDelayMs: number,
): Promise<{ processed: number; errors: number; failedBlocks: number[] }> {
  console.log(`\nProcessing ${blockNumbers.length} blocks (${transactions.length} discovered transactions) through the indexer...`);

  if (dryRun) {
    const txCountByBlock = new Map<number, number>();
    transactions.forEach((tx) => {
      txCountByBlock.set(tx.block_number, (txCountByBlock.get(tx.block_number) || 0) + 1);
    });
    console.log('Dry run enabled. First 10 blocks:');
    blockNumbers.slice(0, 10).forEach((blockNumber, idx) => {
      console.log(`  ${idx + 1}. block ${blockNumber}, discovered txs=${txCountByBlock.get(blockNumber) || 0}`);
    });
    return { processed: 0, errors: 0, failedBlocks: [] };
  }

  let processed = 0;
  let errors = 0;
  const failedBlocks: number[] = [];

  for (const blockNumber of blockNumbers) {
    let blockProcessed = false;

    for (let attempt = 1; attempt <= REINDEX_BLOCK_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`${indexerUrl}/admin/reindex-block`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({ blockNumber }),
        });

        if (response.ok) {
          processed++;
          if (processed % 10 === 0) {
            console.log(`  Progress: ${processed}/${blockNumbers.length} blocks (${errors} errors)`);
          }
          blockProcessed = true;
          break;
        }

        const responseBody = summarizeResponseBody(await response.text());
        const statusText = response.statusText ? ` ${response.statusText}` : '';
        const responseSuffix = responseBody ? ` - ${responseBody}` : '';
        const failureSummary = `${response.status}${statusText}${responseSuffix}`;
        const shouldRetry = isRetryableReindexStatus(response.status) && attempt < REINDEX_BLOCK_MAX_ATTEMPTS;

        if (shouldRetry) {
          console.warn(
            `Retrying block ${blockNumber} after attempt ${attempt}/${REINDEX_BLOCK_MAX_ATTEMPTS}: ${failureSummary}`,
          );
          await sleep(REINDEX_BLOCK_BASE_DELAY_MS * attempt);
          continue;
        }

        console.error(`Error processing block ${blockNumber}: ${failureSummary}`);
        failedBlocks.push(blockNumber);
        errors++;
        break;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const shouldRetry = attempt < REINDEX_BLOCK_MAX_ATTEMPTS;

        if (shouldRetry) {
          console.warn(
            `Retrying block ${blockNumber} after request error on attempt ${attempt}/${REINDEX_BLOCK_MAX_ATTEMPTS}: ${errorMessage}`,
          );
          await sleep(REINDEX_BLOCK_BASE_DELAY_MS * attempt);
          continue;
        }

        console.error(`Error processing block ${blockNumber}:`, error);
        failedBlocks.push(blockNumber);
        errors++;
        break;
      }
    }

    if (!blockProcessed && !failedBlocks.includes(blockNumber)) {
      failedBlocks.push(blockNumber);
      errors++;
    }

    await sleep(reindexDelayMs);
  }

  if (failedBlocks.length) {
    console.error(`Failed block numbers (${failedBlocks.length}): ${summarizeFailedBlocks(failedBlocks)}`);
  }

  console.log(`Processed ${processed}/${blockNumbers.length} blocks (${errors} errors)`);
  return { processed, errors, failedBlocks };
}

async function updateBlockTracker(supabase: any, chainId: number, latestBlock: number) {
  const { error } = await supabase
    .from('blocks')
    .upsert({
      network: chainId,
      blockNumber: latestBlock,
      createdAt: new Date().toISOString(),
    });

  if (error) throw error;
}

async function main() {
  const options = parseArgs();
  const supabase = initSupabase();
  const client = initL1Client(options.network);
  const marketAddress = getRequiredAddress('MARKET_ADDRESS_L1');
  const auctionHouseAddress = getOptionalAddress('AUCTION_HOUSE_ADDRESS_L1');
  const ethscriptionsMarketAddress = ETHSCRIPTIONS_MARKET_ADDRESS_L1;
  const etchMarketAddress = ETCH_MARKET_ADDRESS_L1;
  const ethscriptionsTransferProxyAddress = ETHSCRIPTIONS_TRANSFER_PROXY_ADDRESS_L1;
  const emblemVaultWrapperAddress = EMBLEM_VAULT_WRAPPER_ADDRESS_L1;
  const emblemMetadataCache = new Map<string, string | null>();

  console.log('\nStarting hybrid collection backfill...');
  console.log(`  Network: ${options.network}`);
  console.log(`  Indexer URL: ${options.indexerUrl}`);
  console.log(`  Dry Run: ${options.dryRun}`);
  console.log(`  Strict Mode: ${options.strict}`);
  console.log(`  Force: ${options.force}`);
  console.log(`  Log Chunk Size: ${options.logChunkSize}`);
  console.log(`  Reindex Delay: ${options.reindexDelayMs}ms`);

  try {
    if (!options.metadata) {
      console.log('\nMetadata location can be a local path or URL.');
      options.metadata = await promptForInput('Enter metadata location: ');
      if (!options.metadata) {
        console.error('Error: Metadata location is required');
        process.exit(1);
      }
    }

    const metadata = await loadMetadata(options.metadata);
    if (!metadata.slug) {
      console.error('Error: Metadata JSON must contain a "slug" field.');
      process.exit(1);
    }

    const validation = validateAndNormalizeMetadata(metadata);
    if (!validation.isValid) {
      console.error(`Validation failed with ${validation.errors.length} error(s)`);
      if (options.strict) process.exit(1);
    }

    if (options.strict && validation.warnings.length > 0) {
      if (validation.stats.duplicateIndexes.size > 0 || validation.stats.duplicateShas.size > 0) {
        console.error('Duplicate indexes or SHAs detected. Cannot proceed in strict mode.');
        process.exit(1);
      }

      if (validation.stats.indexGaps.length > 0) {
        console.error(`Index gaps detected (${validation.stats.indexGaps.length} gaps). Cannot proceed in strict mode.`);
        process.exit(1);
      }
    }

    const itemsToProcess = validation.normalizedItems;
    if (!itemsToProcess.length) {
      console.error('No valid items to process after validation');
      process.exit(1);
    }

    const collectionExists = await checkCollectionExists(supabase, metadata.slug, options.tableSuffix);
    if (collectionExists && !options.force) {
      console.error(`Collection "${metadata.slug}" already exists in the database. Use --force to continue.`);
      process.exit(1);
    }

    const dbCheck = await checkDuplicateIdsInDatabase(supabase, itemsToProcess, options.tableSuffix);
    if (dbCheck.duplicates.length > 0 && !options.force) {
      console.error(`Found ${dbCheck.duplicates.length} ethscription IDs already in the database. Use --force to continue.`);
      process.exit(1);
    }

    const {
      creations,
      transfers,
      shaMismatches,
      missingCreations,
    } = await fetchEthscriptionData(itemsToProcess, options.apiBaseUrl);

    if (shaMismatches.length > 0) {
      console.error(`Detected ${shaMismatches.length} metadata SHA mismatch(es) against on-chain content.`);
      shaMismatches.slice(0, 10).forEach((mismatch) => {
        console.error(
          `  #${mismatch.index} ${mismatch.name} (${mismatch.id}) metadata=${mismatch.metadataSha} onchain=${mismatch.contentSha}`,
        );
      });
      if (shaMismatches.length > 10) {
        console.error(`  ...and ${shaMismatches.length - 10} more`);
      }
      if (options.strict) {
        console.error('Cannot proceed in strict mode with mismatched metadata SHAs.');
        process.exit(1);
      }
    }

    if (missingCreations.length > 0) {
      console.error(`Failed to fetch creation data for ${missingCreations.length} item(s) from the Ethscriptions API.`);
      missingCreations.slice(0, 10).forEach((item) => {
        console.error(`  #${item.index} ${item.name} (${item.id}) sha=${item.sha}`);
      });
      if (missingCreations.length > 10) {
        console.error(`  ...and ${missingCreations.length - 10} more`);
      }
      if (options.strict) {
        console.error('Cannot proceed in strict mode with missing creation data.');
        process.exit(1);
      }
    }

    if (options.dryRun) {
      console.log('\nDry run: skipping attribute and collection upserts');
    } else {
      await populateAttributes(supabase, metadata.slug, itemsToProcess);
      await ensureCollection(supabase, client, metadata, options.tableSuffix);
    }

    const transferTransactions: TransactionToProcess[] = transfers.map((transfer) => ({
      hash: transfer.transaction_hash.toLowerCase(),
      block_number: transfer.block_number,
      transaction_index: transfer.transaction_index,
      sources: ['ethscriptions-api:transfer'],
    }));

    const apiBlockNumbers = [
      ...creations.map((tx) => tx.block_number),
      ...transfers.map((tx) => tx.block_number),
    ];

    if (!apiBlockNumbers.length) {
      console.error('Could not determine a collection block range from the Ethscriptions API data');
      process.exit(1);
    }

    const earliestCollectionBlock = Math.min(...apiBlockNumbers);
    const latestChainBlock = Number(await client.getBlockNumber());
    const fromBlock = options.fromBlock ?? earliestCollectionBlock;
    const toBlock = options.toBlock ?? latestChainBlock;

    if (fromBlock > toBlock) {
      console.error(`Error: fromBlock (${fromBlock}) cannot be greater than toBlock (${toBlock})`);
      process.exit(1);
    }

    const collectionHashIds = new Set(itemsToProcess.map((item) => item.id.toLowerCase()));
    const [
      marketDeploymentBlock,
      auctionDeploymentBlock,
      ethscriptionsMarketDeploymentBlock,
      etchMarketDeploymentBlock,
      ethscriptionsTransferProxyDeploymentBlock,
      emblemVaultWrapperDeploymentBlock,
    ] = await Promise.all([
      findContractDeploymentBlock(client, marketAddress, toBlock),
      auctionHouseAddress
        ? findContractDeploymentBlock(client, auctionHouseAddress, toBlock)
        : Promise.resolve(toBlock),
      options.network === 'mainnet'
        ? findContractDeploymentBlock(client, ethscriptionsMarketAddress, toBlock)
        : Promise.resolve(toBlock),
      options.network === 'mainnet'
        ? findContractDeploymentBlock(client, etchMarketAddress, toBlock)
        : Promise.resolve(toBlock),
      options.network === 'mainnet'
        ? findContractDeploymentBlock(client, ethscriptionsTransferProxyAddress, toBlock)
        : Promise.resolve(toBlock),
      options.network === 'mainnet'
        ? findContractDeploymentBlock(client, emblemVaultWrapperAddress, toBlock)
        : Promise.resolve(toBlock),
    ]);

    const {
      transactions,
      creationTransactions,
      filteredTransferTransactions,
      marketTransactions,
      auctionTransactions,
      ethscriptionsMarketTransactions,
      etchMarketTransactions,
      ethscriptionsTransferProxyTransactions,
      emblemVaultWrapperTransactions,
    } = await collectTransactionsForRange({
      client,
      network: options.network,
      marketAddress,
      auctionHouseAddress,
      ethscriptionsMarketAddress,
      etchMarketAddress,
      ethscriptionsTransferProxyAddress,
      emblemVaultWrapperAddress,
      fromBlock,
      toBlock,
      logChunkSize: options.logChunkSize,
      collectionHashIds,
      emblemMetadataCache,
      creations,
      transferTransactions,
      marketDeploymentBlock,
      auctionDeploymentBlock,
      ethscriptionsMarketDeploymentBlock,
      etchMarketDeploymentBlock,
      ethscriptionsTransferProxyDeploymentBlock,
      emblemVaultWrapperDeploymentBlock,
    });

    console.log('\nTransaction source summary:');
    console.log(`  Ethscriptions creations: ${creationTransactions.length}`);
    console.log(`  Ethscriptions transfers: ${filteredTransferTransactions.length}`);
    console.log(`  Marketplace log txs: ${marketTransactions.length}`);
    console.log(`  Auction log txs: ${auctionTransactions.length}`);
    console.log(`  Ethscriptions market log txs: ${ethscriptionsMarketTransactions.length}`);
    console.log(`  EtchMarket sale log txs: ${etchMarketTransactions.length}`);
    console.log(`  Ethscriptions transfer proxy log txs: ${ethscriptionsTransferProxyTransactions.length}`);
    console.log(`  Emblem/OpenSea/Blur wrapper log txs: ${emblemVaultWrapperTransactions.length}`);
    console.log(`  Total unique txs: ${transactions.length}`);
    console.log(`  Replay block range: ${fromBlock}-${toBlock}`);

    const blockNumbers = getUniqueSortedBlockNumbers(transactions);
    console.log(`  Total unique blocks to replay: ${blockNumbers.length}`);

    const result = await processBlocks(
      blockNumbers,
      transactions,
      options.indexerUrl,
      options.apiKey!,
      options.dryRun,
      options.reindexDelayMs,
    );

    if (!options.dryRun && result.errors > 0) {
      throw new Error(
        `Replay failed for ${result.errors} blocks; block tracker was not advanced. Failed blocks: ${summarizeFailedBlocks(result.failedBlocks)}`
      );
    }

    if (!options.dryRun) {
      let finalBlock = toBlock;
      const latestBlockNow = Number(await client.getBlockNumber());

      if (latestBlockNow > toBlock) {
        const catchUpFromBlock = toBlock + 1;
        console.log(`\nRunning final catch-up pass for blocks ${catchUpFromBlock}-${latestBlockNow}...`);

        const {
          transactions: catchUpTransactions,
          creationTransactions: catchUpCreations,
          filteredTransferTransactions: catchUpTransfers,
          marketTransactions: catchUpMarketTransactions,
          auctionTransactions: catchUpAuctionTransactions,
          ethscriptionsMarketTransactions: catchUpEthscriptionsMarketTransactions,
          etchMarketTransactions: catchUpEtchMarketTransactions,
          ethscriptionsTransferProxyTransactions: catchUpEthscriptionsTransferProxyTransactions,
          emblemVaultWrapperTransactions: catchUpEmblemVaultWrapperTransactions,
        } = await collectTransactionsForRange({
          client,
          network: options.network,
          marketAddress,
          auctionHouseAddress,
          ethscriptionsMarketAddress,
          etchMarketAddress,
          ethscriptionsTransferProxyAddress,
          emblemVaultWrapperAddress,
          fromBlock: catchUpFromBlock,
          toBlock: latestBlockNow,
          logChunkSize: options.logChunkSize,
          collectionHashIds,
          emblemMetadataCache,
          creations,
          transferTransactions,
          marketDeploymentBlock,
          auctionDeploymentBlock,
          ethscriptionsMarketDeploymentBlock,
          etchMarketDeploymentBlock,
          ethscriptionsTransferProxyDeploymentBlock,
          emblemVaultWrapperDeploymentBlock,
        });

        console.log('\nCatch-up source summary:');
        console.log(`  Ethscriptions creations: ${catchUpCreations.length}`);
        console.log(`  Ethscriptions transfers: ${catchUpTransfers.length}`);
        console.log(`  Marketplace log txs: ${catchUpMarketTransactions.length}`);
        console.log(`  Auction log txs: ${catchUpAuctionTransactions.length}`);
        console.log(`  Ethscriptions market log txs: ${catchUpEthscriptionsMarketTransactions.length}`);
        console.log(`  EtchMarket sale log txs: ${catchUpEtchMarketTransactions.length}`);
        console.log(`  Ethscriptions transfer proxy log txs: ${catchUpEthscriptionsTransferProxyTransactions.length}`);
        console.log(`  Emblem/OpenSea/Blur wrapper log txs: ${catchUpEmblemVaultWrapperTransactions.length}`);
        console.log(`  Total unique txs: ${catchUpTransactions.length}`);

        const catchUpBlockNumbers = getUniqueSortedBlockNumbers(catchUpTransactions);
        console.log(`  Total unique blocks to replay: ${catchUpBlockNumbers.length}`);

        const catchUpResult = await processBlocks(
          catchUpBlockNumbers,
          catchUpTransactions,
          options.indexerUrl,
          options.apiKey!,
          options.dryRun,
          options.reindexDelayMs,
        );

        if (catchUpResult.errors > 0) {
          throw new Error(
            `Final catch-up replay failed for ${catchUpResult.errors} blocks; block tracker was not advanced. Failed blocks: ${summarizeFailedBlocks(catchUpResult.failedBlocks)}`
          );
        }

        finalBlock = latestBlockNow;
      }

      await updateBlockTracker(supabase, options.chainId, finalBlock);
      console.log(`Updated block tracker to ${finalBlock}`);
    }

    console.log('\nHybrid backfill complete.');
  } catch (error) {
    console.error('\nHybrid backfill failed:', error);
    process.exit(1);
  }
}

void main();
