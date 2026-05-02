#!/usr/bin/env ts-node

/**
 * Rebuilds local mainnet chain-derived indexer state from the blocks that
 * already appear in the current events table. This intentionally preserves
 * curated metadata, attributes, comments, users, and storage assets.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

type EventRow = {
  txHash: string;
  blockNumber: number | null;
  txIndex: number | null;
  type: string | null;
  venue: string | null;
};

type ManifestTx = {
  txHash: string;
  blockNumber: number;
  txIndex: number;
};

type RebuildManifest = {
  createdAt: string;
  sourceTable: 'events';
  eventCount: number;
  txCount: number;
  blockCount: number;
  firstBlock: number | null;
  lastBlock: number | null;
  typeCounts: Record<string, number>;
  venueCounts: Record<string, number>;
  transactions: ManifestTx[];
  blocks: number[];
};

type Options = {
  indexerUrl: string;
  apiKey?: string;
  dryRun: boolean;
  confirmReset: boolean;
  manifestPath?: string;
  manifestOnly: boolean;
  replayOnly: boolean;
};

const DERIVED_TABLES = [
  { name: 'events', column: 'txId' },
  { name: 'listings', column: 'hashId' },
  { name: 'bids', column: 'hashId' },
  { name: 'auctionBids', column: 'id' },
  { name: 'auctions', column: 'hashId' },
  { name: 'ethscriptions', column: 'hashId' },
] as const;
const DELETE_BATCH_SIZE = 100;

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    indexerUrl: 'http://localhost:3069',
    dryRun: true,
    confirmReset: false,
    manifestOnly: false,
    replayOnly: false,
  };

  args.forEach((arg, index) => {
    if (arg.startsWith('--indexer-url=')) {
      options.indexerUrl = arg.split('=')[1];
    } else if (arg === '--indexer-url' && args[index + 1]) {
      options.indexerUrl = args[index + 1];
    } else if (arg.startsWith('--api-key=')) {
      options.apiKey = arg.split('=')[1];
    } else if (arg === '--api-key' && args[index + 1]) {
      options.apiKey = args[index + 1];
    } else if (arg.startsWith('--manifest=')) {
      options.manifestPath = arg.split('=')[1];
    } else if (arg === '--manifest' && args[index + 1]) {
      options.manifestPath = args[index + 1];
    } else if (arg === '--confirm-reset') {
      options.confirmReset = true;
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--manifest-only') {
      options.manifestOnly = true;
    } else if (arg === '--replay-only') {
      options.replayOnly = true;
    }
  });

  dotenv.config({ path: '.env.mainnet' });
  dotenv.config({ path: '.env' });
  dotenv.config({ path: '.env.supabase' });

  if (!options.apiKey) options.apiKey = process.env.API_PRIVATE_KEY;
  if (!options.apiKey && !options.manifestOnly && !options.dryRun) {
    throw new Error('API key required. Provide --api-key or set API_PRIVATE_KEY.');
  }

  if (process.env.CHAIN_ID_L1 && Number(process.env.CHAIN_ID_L1) !== 1) {
    throw new Error('This rebuild script is mainnet-only. Refusing to run with CHAIN_ID_L1 != 1.');
  }

  if (options.manifestOnly && options.replayOnly) {
    throw new Error('--manifest-only and --replay-only cannot be used together.');
  }
  if (options.replayOnly && !options.manifestPath) {
    throw new Error('--replay-only requires --manifest <path>.');
  }

  return options;
}

function initSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set.');
  }

  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });
}

function incrementCount(counts: Record<string, number>, key?: string | null) {
  const normalized = key || '(null)';
  counts[normalized] = (counts[normalized] || 0) + 1;
}

async function fetchAllEvents(supabase: ReturnType<typeof initSupabase>): Promise<EventRow[]> {
  const pageSize = 1000;
  const events: EventRow[] = [];
  let page = 0;

  while (true) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from('events')
      .select('txHash, blockNumber, txIndex, type, venue')
      .order('blockNumber', { ascending: true })
      .order('txIndex', { ascending: true })
      .range(from, to);

    if (error) throw error;
    if (!data?.length) break;

    events.push(...data as EventRow[]);
    if (data.length < pageSize) break;
    page++;
  }

  return events;
}

function buildManifest(events: EventRow[]): RebuildManifest {
  const typeCounts: Record<string, number> = {};
  const venueCounts: Record<string, number> = {};
  const transactionMap = new Map<string, ManifestTx>();

  events.forEach((event) => {
    incrementCount(typeCounts, event.type);
    incrementCount(venueCounts, event.venue);

    if (!event.txHash || event.blockNumber === null || event.txIndex === null) return;
    const txHash = event.txHash.toLowerCase();
    if (!transactionMap.has(txHash)) {
      transactionMap.set(txHash, {
        txHash,
        blockNumber: Number(event.blockNumber),
        txIndex: Number(event.txIndex),
      });
    }
  });

  const transactions = Array.from(transactionMap.values()).sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex;
    return a.txHash.localeCompare(b.txHash);
  });
  const blocks = Array.from(new Set(transactions.map((tx) => tx.blockNumber))).sort((a, b) => a - b);

  return {
    createdAt: new Date().toISOString(),
    sourceTable: 'events',
    eventCount: events.length,
    txCount: transactions.length,
    blockCount: blocks.length,
    firstBlock: blocks[0] || null,
    lastBlock: blocks[blocks.length - 1] || null,
    typeCounts,
    venueCounts,
    transactions,
    blocks,
  };
}

function defaultManifestPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve('temp', `event-rebuild-manifest-${timestamp}.json`);
}

function writeManifest(manifest: RebuildManifest, manifestPath: string) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function readManifest(manifestPath: string): RebuildManifest {
  return JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8')) as RebuildManifest;
}

function printManifestSummary(manifest: RebuildManifest) {
  console.log('\nManifest summary:');
  console.log(`  Events: ${manifest.eventCount}`);
  console.log(`  Unique txs: ${manifest.txCount}`);
  console.log(`  Unique blocks: ${manifest.blockCount}`);
  console.log(`  Block range: ${manifest.firstBlock}-${manifest.lastBlock}`);
  console.log('  Type counts:', manifest.typeCounts);
  console.log('  Venue counts:', manifest.venueCounts);
}

async function resetDerivedTables(supabase: ReturnType<typeof initSupabase>) {
  console.log('\nResetting chain-derived mainnet tables...');

  for (const table of DERIVED_TABLES) {
    let deleted = 0;

    while (true) {
      const { data, error: selectError } = await supabase
        .from(table.name)
        .select(table.column)
        .not(table.column, 'is', null)
        .limit(DELETE_BATCH_SIZE);

      if (selectError) throw selectError;
      if (!data?.length) break;

      const rows = data as Record<string, string | number | null | undefined>[];
      const ids = rows
        .map((row) => row[table.column])
        .filter((id): id is string | number => id !== null && id !== undefined);

      if (!ids.length) break;

      const { error: deleteError } = await supabase
        .from(table.name)
        .delete()
        .in(table.column, ids);

      if (deleteError) throw deleteError;

      deleted += ids.length;
      if (deleted % 1000 === 0) console.log(`  Cleared ${deleted} ${table.name} rows...`);
    }

    console.log(`  Cleared ${deleted} ${table.name} rows`);
  }
}

async function replayBlocks(manifest: RebuildManifest, options: Options) {
  console.log(`\nReplaying ${manifest.blocks.length} blocks through ${options.indexerUrl}/admin/reindex-block...`);

  let processed = 0;
  let errors = 0;

  for (const blockNumber of manifest.blocks) {
    try {
      const response = await fetch(`${options.indexerUrl}/admin/reindex-block`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': options.apiKey!,
        },
        body: JSON.stringify({ blockNumber }),
      });

      if (!response.ok) {
        errors++;
        console.error(`  Error processing block ${blockNumber}: ${response.status}`);
      } else {
        processed++;
        if (processed % 10 === 0) console.log(`  Progress: ${processed}/${manifest.blocks.length} blocks (${errors} errors)`);
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      errors++;
      console.error(`  Error processing block ${blockNumber}:`, error);
    }
  }

  if (errors > 0) throw new Error(`Replay failed for ${errors} blocks`);
  console.log(`Replayed ${processed}/${manifest.blocks.length} blocks`);
}

async function main() {
  const options = parseArgs();
  const supabase = initSupabase();

  const manifestPath = path.resolve(options.manifestPath || defaultManifestPath());
  let manifest: RebuildManifest;

  if (options.replayOnly) {
    manifest = readManifest(manifestPath);
    console.log(`Loaded manifest from ${manifestPath}`);
  } else {
    const events = await fetchAllEvents(supabase);
    manifest = buildManifest(events);
    writeManifest(manifest, manifestPath);
    console.log(`Wrote manifest to ${manifestPath}`);
  }

  printManifestSummary(manifest);

  if (options.manifestOnly || options.dryRun) {
    console.log('\nDry run complete. No tables were reset and no blocks were replayed.');
    console.log('Run again with --confirm-reset to reset derived tables and replay blocks.');
    return;
  }

  if (!options.confirmReset) {
    throw new Error('Refusing destructive rebuild without --confirm-reset.');
  }

  await resetDerivedTables(supabase);
  await replayBlocks(manifest, options);

  console.log('\nIndexed state rebuild complete.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
