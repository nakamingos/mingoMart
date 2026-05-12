#!/usr/bin/env ts-node

import { createHash } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { extname, join, resolve } from 'path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { createPublicClient, hexToString, http } from 'viem';
import { mainnet, sepolia } from 'viem/chains';

type AttributeValue = string | number | boolean | Array<string | number | boolean>;

type MetadataAttribute = {
  trait_type: string;
  value: AttributeValue;
};

type CollectionItem = {
  id: string;
  index: number;
  sha: string;
  name?: string;
  description?: string;
  attributes: MetadataAttribute[];
};

type CollectionMetadata = {
  name: string;
  logo_image?: string;
  banner_image?: string;
  total_supply: number;
  slug: string;
  description: string;
  website_url?: string;
  twitter_url?: string;
  discord_url?: string;
  background_color?: string;
  collection_items: CollectionItem[];
};

type MintCollectionItem = {
  name: string;
  image: string;
  attributes: MetadataAttribute[];
  collectionName: string;
  tokenId: number;
  sha: string;
};

type MintCollection = {
  name: string;
  logo_image_uri: string;
  banner_image_uri: string;
  total_supply: number;
  slug: string;
  description: string;
  website_link: string;
  twitter_link: string;
  discord_link: string;
  background_color: string;
  collection_items: MintCollectionItem[];
};

type Options = {
  metadataPath: string;
  transparentDir?: string;
  network: 'mainnet' | 'sepolia';
  concurrency: number;
  dryRun: boolean;
  skipImages: boolean;
  skipAttributes: boolean;
  skipMintData: boolean;
};

type TransparentUploadEntry = {
  item: CollectionItem;
  fileName: string;
  filePath: string;
  contentType: string;
  normalizedSha: string;
};

type TransparentSourceFile = {
  fileName: string;
  filePath: string;
  displayPath: string;
};

type ResolvedTransparentUploads = {
  entries: TransparentUploadEntry[];
  allowedMissingItems: CollectionItem[];
};

const DEFAULT_CONCURRENCY = 12;
const SUPPORTED_TRANSPARENT_FILE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    metadataPath: '',
    network: 'mainnet',
    concurrency: DEFAULT_CONCURRENCY,
    dryRun: false,
    skipImages: false,
    skipAttributes: false,
    skipMintData: false,
  };

  args.forEach((arg, index) => {
    if (arg.startsWith('--metadata=')) {
      options.metadataPath = arg.split('=')[1] || '';
    } else if (arg === '--metadata' && args[index + 1]) {
      options.metadataPath = args[index + 1];
    } else if (arg.startsWith('--transparent-dir=')) {
      options.transparentDir = arg.split('=')[1] || '';
    } else if (arg === '--transparent-dir' && args[index + 1]) {
      options.transparentDir = args[index + 1];
    } else if (arg.startsWith('--network=')) {
      const value = arg.split('=')[1]?.toLowerCase();
      if (value === 'mainnet' || value === 'sepolia') options.network = value;
    } else if (arg === '--network' && args[index + 1]) {
      const value = args[index + 1].toLowerCase();
      if (value === 'mainnet' || value === 'sepolia') options.network = value;
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = Number(arg.split('=')[1]);
    } else if (arg === '--concurrency' && args[index + 1]) {
      options.concurrency = Number(args[index + 1]);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--skip-images') {
      options.skipImages = true;
    } else if (arg === '--skip-attributes') {
      options.skipAttributes = true;
    } else if (arg === '--skip-mint-data') {
      options.skipMintData = true;
    }
  });

  if (!options.metadataPath) {
    console.error(
      'Usage: ts-node scripts/upload-collection-storage-assets.ts --metadata ./metadata/<slug>.json ' +
      '[--transparent-dir ./.tmp/transparents/<slug>] [--network mainnet|sepolia] [--concurrency 12] ' +
      '[--dry-run] [--skip-images] [--skip-attributes] [--skip-mint-data]'
    );
    process.exit(1);
  }

  if (Number.isNaN(options.concurrency) || options.concurrency < 1) {
    console.error('Error: --concurrency must be a number >= 1');
    process.exit(1);
  }

  return options;
}

function normalizeSha(sha: string): string {
  return sha.replace(/^0x/i, '').toLowerCase();
}

function getItemDisplayName(metadata: CollectionMetadata, item: CollectionItem): string {
  return item.name?.trim() || `${metadata.name} #${item.index}`;
}

function normalizeTransparentName(name: string): string {
  return name
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s*#\s*/g, '#')
    .replace(/\s+/g, ' ');
}

function itemHasAttributeValue(
  item: CollectionItem,
  traitType: string,
  expectedValue: string,
): boolean {
  return item.attributes.some((attribute) => {
    if (attribute.trait_type !== traitType) return false;

    if (Array.isArray(attribute.value)) {
      return attribute.value.includes(expectedValue);
    }

    return attribute.value === expectedValue;
  });
}

function isAllowedMissingTransparentItem(
  metadata: CollectionMetadata,
  item: CollectionItem,
): boolean {
  if (metadata.slug !== 'call-data-comrades') {
    return false;
  }

  return itemHasAttributeValue(item, 'Classification', 'Ambassadors');
}

async function collectTransparentSourceFiles(
  directoryPath: string,
  prefix = '',
): Promise<TransparentSourceFile[]> {
  const dirents = await readdir(directoryPath, { withFileTypes: true });
  const files: TransparentSourceFile[] = [];

  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (dirent.name.startsWith('.')) continue;

    const filePath = join(directoryPath, dirent.name);
    const displayPath = prefix ? `${prefix}/${dirent.name}` : dirent.name;

    if (dirent.isDirectory()) {
      files.push(...await collectTransparentSourceFiles(filePath, displayPath));
      continue;
    }

    if (!dirent.isFile()) continue;

    files.push({
      fileName: dirent.name,
      filePath,
      displayPath,
    });
  }

  return files;
}

function loadEnv(network: 'mainnet' | 'sepolia') {
  dotenv.config({ path: '.env.supabase' });
  dotenv.config({ path: `.env.${network}` });
  dotenv.config({ path: '.env' });
}

async function loadMetadata(metadataPath: string): Promise<CollectionMetadata> {
  const absolutePath = resolve(metadataPath);
  const raw = await readFile(absolutePath, 'utf8');
  return JSON.parse(raw) as CollectionMetadata;
}

function initSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !serviceRole) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE in .env.supabase');
  }

  return createClient(url, serviceRole, {
    auth: { persistSession: false },
  });
}

function initL1Client(network: 'mainnet' | 'sepolia') {
  const rpcUrl = process.env.RPC_URL_L1;
  if (!rpcUrl) {
    throw new Error('Missing RPC_URL_L1 in the network env file');
  }

  return createPublicClient({
    chain: network === 'mainnet' ? mainnet : sepolia,
    transport: http(rpcUrl),
  });
}

function hasCustomName(item: CollectionItem): boolean {
  if (!item.name) return false;
  return !new RegExp(`\\s#?${item.index}$`).test(item.name.trim());
}

function buildAttributesFile(metadata: CollectionMetadata) {
  const formattedAttributes = metadata.collection_items.reduce((acc, item) => {
    acc[normalizeSha(item.sha)] = [
      ...(hasCustomName(item) ? [{ k: 'Name', v: item.name as AttributeValue }] : []),
      ...(item.description ? [{ k: 'Description', v: item.description as AttributeValue }] : []),
      ...item.attributes.map((attribute) => ({
        k: attribute.trait_type,
        v: attribute.value,
      })),
    ];
    return acc;
  }, {} as Record<string, Array<{ k: string; v: AttributeValue }>>);

  return Buffer.from(JSON.stringify(formattedAttributes));
}

async function resolveEscData(
  client: ReturnType<typeof initL1Client>,
  value?: string,
): Promise<string> {
  if (!value) return '';

  const match = value.match(/^esc:\/\/ethscriptions\/(0x[0-9a-f]{64})\/data$/i);
  if (!match) return value;

  const tx = await client.getTransaction({ hash: match[1] as `0x${string}` });
  return hexToString(tx.input).replace(/\x00/g, '');
}

function parseDataUri(dataUri: string): { buffer: Buffer; contentType: string } {
  if (!dataUri.startsWith('data:')) {
    throw new Error('Expected a data URI');
  }

  const commaIndex = dataUri.indexOf(',');
  if (commaIndex === -1) {
    throw new Error('Invalid data URI');
  }

  const header = dataUri.slice(5, commaIndex);
  const payload = dataUri.slice(commaIndex + 1);
  const headerParts = header.split(';');
  const contentType = headerParts[0] || 'application/octet-stream';
  const isBase64 = headerParts.includes('base64');

  return {
    buffer: isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8'),
    contentType,
  };
}

async function ensureBucket(
  supabase: SupabaseClient,
  bucketName: string,
  isPublic: boolean,
  dryRun: boolean,
) {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;

  const existing = buckets?.find((bucket) => bucket.id === bucketName || bucket.name === bucketName);
  if (existing) return;

  if (dryRun) {
    console.log(`[dry-run] Would create bucket ${bucketName} (public=${isPublic})`);
    return;
  }

  const { error: createError } = await supabase.storage.createBucket(bucketName, { public: isPublic });
  if (createError) throw createError;
  console.log(`Created bucket ${bucketName}`);
}

async function uploadObject(params: {
  supabase: SupabaseClient;
  bucket: string;
  path: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  dryRun: boolean;
}) {
  if (params.dryRun) {
    console.log(`[dry-run] Would upload ${params.bucket}/${params.path}`);
    return false;
  }

  const { error } = await params.supabase.storage
    .from(params.bucket)
    .upload(params.path, params.body, {
      upsert: true,
      contentType: params.contentType,
      cacheControl: params.cacheControl,
      metadata: params.metadata,
    });

  if (error) throw error;
  return true;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = cursor;
      cursor += 1;

      if (current >= items.length) return;
      await worker(items[current], current);
    }
  });

  await Promise.all(runners);
}

function buildMintData(
  metadata: CollectionMetadata,
  supabaseUrl: string,
  logoImageUri: string,
  bannerImageUri: string,
): MintCollection {
  return {
    name: metadata.name,
    logo_image_uri: logoImageUri,
    banner_image_uri: bannerImageUri,
    total_supply: metadata.total_supply,
    slug: metadata.slug,
    description: metadata.description,
    website_link: metadata.website_url || '',
    twitter_link: metadata.twitter_url || '',
    discord_link: metadata.discord_url || '',
    background_color: metadata.background_color || '',
    collection_items: metadata.collection_items.map((item) => {
      const normalizedSha = normalizeSha(item.sha);

      return {
      name: item.name || `${metadata.name} #${item.index}`,
      image: `${supabaseUrl}/storage/v1/object/public/static/images/${normalizedSha}`,
      attributes: item.attributes,
      collectionName: metadata.name,
      tokenId: item.index,
      sha: normalizedSha,
      };
    }),
  };
}

async function resolveTransparentUploads(
  metadata: CollectionMetadata,
  transparentDir: string,
): Promise<ResolvedTransparentUploads> {
  const absoluteDir = resolve(transparentDir);
  const sourceFiles = await collectTransparentSourceFiles(absoluteDir);

  const metadataKeyToItem = new Map<string, CollectionItem>();
  const metadataIndexToItem = new Map<number, CollectionItem>();
  const duplicateMetadataKeys: string[] = [];

  for (const item of metadata.collection_items) {
    const displayName = getItemDisplayName(metadata, item);
    const key = normalizeTransparentName(displayName);

    if (metadataKeyToItem.has(key)) {
      duplicateMetadataKeys.push(displayName);
      continue;
    }

    metadataKeyToItem.set(key, item);
    metadataIndexToItem.set(item.index, item);

    if (hasCustomName(item)) {
      const indexedCustomKey = normalizeTransparentName(`${displayName}#${item.index}`);
      metadataKeyToItem.set(indexedCustomKey, item);
    }
  }

  if (duplicateMetadataKeys.length) {
    throw new Error(
      `Transparent file mapping is ambiguous for ${duplicateMetadataKeys.length} metadata item(s): ` +
      duplicateMetadataKeys.slice(0, 10).join(', ')
    );
  }

  const matchedKeys = new Set<string>();
  const matchedItemIndices = new Set<number>();
  const duplicateFiles: string[] = [];
  const unmatchedFiles: string[] = [];
  const unsupportedFiles: string[] = [];
  const entries: TransparentUploadEntry[] = [];

  for (const sourceFile of sourceFiles) {
    const extension = extname(sourceFile.fileName).toLowerCase();
    const contentType = SUPPORTED_TRANSPARENT_FILE_TYPES[extension];
    if (!contentType) {
      unsupportedFiles.push(sourceFile.displayPath);
      continue;
    }

    const baseName = sourceFile.fileName.slice(0, -extension.length);
    const key = normalizeTransparentName(baseName);
    const indexMatch = baseName.match(/#(\d+)$/);
    const numericBaseName = /^\d+$/.test(baseName) ? Number(baseName) : undefined;
    const item = metadataKeyToItem.get(key)
      ?? (indexMatch ? metadataIndexToItem.get(Number(indexMatch[1])) : undefined)
      ?? (numericBaseName !== undefined ? metadataIndexToItem.get(numericBaseName) : undefined);

    if (!item) {
      unmatchedFiles.push(sourceFile.displayPath);
      continue;
    }

    if (matchedItemIndices.has(item.index)) {
      duplicateFiles.push(sourceFile.displayPath);
      continue;
    }

    matchedItemIndices.add(item.index);
    matchedKeys.add(normalizeTransparentName(getItemDisplayName(metadata, item)));
    entries.push({
      item,
      fileName: sourceFile.displayPath,
      filePath: sourceFile.filePath,
      contentType,
      normalizedSha: normalizeSha(item.sha),
    });
  }

  if (unsupportedFiles.length) {
    throw new Error(
      `Unsupported transparent file type for ${unsupportedFiles.length} file(s): ` +
      unsupportedFiles.slice(0, 10).join(', ')
    );
  }

  if (unmatchedFiles.length) {
    throw new Error(
      `Could not match ${unmatchedFiles.length} transparent file(s) to metadata item names: ` +
      unmatchedFiles.slice(0, 10).join(', ')
    );
  }

  if (duplicateFiles.length) {
    throw new Error(
      `Duplicate transparent files matched the same metadata item for ${duplicateFiles.length} file(s): ` +
      duplicateFiles.slice(0, 10).join(', ')
    );
  }

  const missingItems = metadata.collection_items.filter((item) => {
    const key = normalizeTransparentName(getItemDisplayName(metadata, item));
    return !matchedKeys.has(key);
  });

  const allowedMissingItems = missingItems.filter((item) =>
    isAllowedMissingTransparentItem(metadata, item)
  );
  const disallowedMissingItems = missingItems.filter((item) =>
    !isAllowedMissingTransparentItem(metadata, item)
  );

  if (disallowedMissingItems.length) {
    throw new Error(
      `Missing transparent files for ${disallowedMissingItems.length} metadata item(s): ` +
      disallowedMissingItems.slice(0, 10).map((item) => getItemDisplayName(metadata, item)).join(', ')
    );
  }

  return {
    entries: entries.sort((a, b) => a.item.index - b.item.index),
    allowedMissingItems,
  };
}

async function uploadImages(
  metadata: CollectionMetadata,
  client: ReturnType<typeof initL1Client>,
  supabase: SupabaseClient,
  options: Options,
) {
  console.log(`Uploading ${metadata.collection_items.length} collection images...`);

  let completed = 0;

  await runWithConcurrency(metadata.collection_items, options.concurrency, async (item) => {
    const tx = await client.getTransaction({ hash: item.id as `0x${string}` });
    const dataUri = hexToString(tx.input).replace(/\x00/g, '');
    const computedSha = createHash('sha256').update(dataUri).digest('hex');
    const normalizedSha = normalizeSha(item.sha);

    if (computedSha !== normalizedSha) {
      throw new Error(
        `SHA mismatch for token ${item.index}: metadata=${item.sha} computed=${computedSha} tx=${item.id}`
      );
    }

    const { buffer, contentType } = parseDataUri(dataUri);
    await uploadObject({
      supabase,
      bucket: 'static',
      path: `images/${normalizedSha}`,
      body: buffer,
      contentType,
      cacheControl: '31536000',
      metadata: {
        slug: metadata.slug,
        tokenId: String(item.index),
      },
      dryRun: options.dryRun,
    });

    completed += 1;
    if (completed % 100 === 0 || completed === metadata.collection_items.length) {
      console.log(`  Uploaded ${completed}/${metadata.collection_items.length}`);
    }
  });
}

async function uploadTransparentImages(
  metadata: CollectionMetadata,
  supabase: SupabaseClient,
  options: Options,
) {
  if (!options.transparentDir) return;

  const { entries, allowedMissingItems } = await resolveTransparentUploads(metadata, options.transparentDir);
  console.log(`Uploading ${entries.length} transparent collection images from ${resolve(options.transparentDir)}...`);

  if (allowedMissingItems.length) {
    console.log(
      `Allowing ${allowedMissingItems.length} missing transparent item(s): ` +
      `${allowedMissingItems.slice(0, 10).map((item) => getItemDisplayName(metadata, item)).join(', ')}`
    );
  }

  if (options.dryRun) {
    entries.slice(0, 5).forEach((entry, index) => {
      console.log(
        `  [dry-run] ${index + 1}. ${entry.fileName} -> static/images/${entry.normalizedSha}_transparent`
      );
    });

    if (entries.length > 5) {
      console.log(`  [dry-run] ...and ${entries.length - 5} more transparent files`);
    }

    return;
  }

  let completed = 0;

  await runWithConcurrency(entries, options.concurrency, async (entry) => {
    const body = await readFile(entry.filePath);
    await uploadObject({
      supabase,
      bucket: 'static',
      path: `images/${entry.normalizedSha}_transparent`,
      body,
      contentType: entry.contentType,
      cacheControl: '31536000',
      metadata: {
        slug: metadata.slug,
        tokenId: String(entry.item.index),
        transparent: 'true',
      },
      dryRun: false,
    });

    completed += 1;
    if (completed % 100 === 0 || completed === entries.length) {
      console.log(`  Uploaded ${completed}/${entries.length} transparents`);
    }
  });
}

async function main() {
  const options = parseArgs();
  loadEnv(options.network);

  const metadata = await loadMetadata(options.metadataPath);
  const supabase = initSupabase();
  const client = initL1Client(options.network);
  const supabaseUrl = process.env.SUPABASE_URL;

  if (!supabaseUrl) {
    throw new Error('Missing SUPABASE_URL in .env.supabase');
  }

  console.log(`Uploading storage assets for ${metadata.slug}`);
  console.log(`  Images: ${!options.skipImages}`);
  console.log(`  Transparent Images: ${Boolean(options.transparentDir)}`);
  console.log(`  Attributes JSON: ${!options.skipAttributes}`);
  console.log(`  Mint data JSON: ${!options.skipMintData}`);
  console.log(`  Dry run: ${options.dryRun}`);

  await ensureBucket(supabase, 'static', true, options.dryRun);
  await ensureBucket(supabase, 'data', true, options.dryRun);
  if (!options.skipMintData) {
    await ensureBucket(supabase, 'mint-data', false, options.dryRun);
  }

  if (!options.skipImages) {
    await uploadImages(metadata, client, supabase, options);
  }

  if (options.transparentDir) {
    await uploadTransparentImages(metadata, supabase, options);
  }

  if (!options.skipAttributes) {
    const attributesFile = buildAttributesFile(metadata);
    const uploaded = await uploadObject({
      supabase,
      bucket: 'data',
      path: `${metadata.slug}_attributes.json`,
      body: attributesFile,
      contentType: 'application/json',
      cacheControl: '31536000',
      dryRun: options.dryRun,
    });
    console.log(`${uploaded ? 'Uploaded' : '[dry-run] Prepared'} data/${metadata.slug}_attributes.json`);
  }

  if (!options.skipMintData) {
    const [logoImageUri, bannerImageUri] = await Promise.all([
      resolveEscData(client, metadata.logo_image),
      resolveEscData(client, metadata.banner_image),
    ]);
    const mintData = buildMintData(metadata, supabaseUrl, logoImageUri, bannerImageUri);
    const uploaded = await uploadObject({
      supabase,
      bucket: 'mint-data',
      path: `${metadata.slug}.json`,
      body: Buffer.from(JSON.stringify(mintData)),
      contentType: 'application/json',
      cacheControl: '31536000',
      dryRun: options.dryRun,
    });
    console.log(`${uploaded ? 'Uploaded' : '[dry-run] Prepared'} mint-data/${metadata.slug}.json`);
  }

  console.log('Done');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});