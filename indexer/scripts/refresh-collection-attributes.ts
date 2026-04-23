import { readFile } from 'fs/promises';
import { resolve } from 'path';

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

type AttributeValue = string | number | boolean;

type MetadataAttribute = {
  trait_type: string;
  value: AttributeValue;
};

type CollectionItem = {
  index: number;
  sha: string;
  attributes: MetadataAttribute[];
};

type CollectionMetadata = {
  slug: string;
  collection_items: CollectionItem[];
};

type Options = {
  metadataPath: string;
  dryRun: boolean;
};

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    metadataPath: '',
    dryRun: false,
  };

  args.forEach((arg, index) => {
    if (arg.startsWith('--metadata=')) {
      options.metadataPath = arg.split('=')[1] || '';
    } else if (arg === '--metadata' && args[index + 1]) {
      options.metadataPath = args[index + 1];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  });

  if (!options.metadataPath) {
    console.error('Usage: ts-node scripts/refresh-collection-attributes.ts --metadata ./metadata/<slug>.json [--dry-run]');
    process.exit(1);
  }

  return options;
}

async function loadMetadata(metadataPath: string): Promise<CollectionMetadata> {
  const absolutePath = resolve(metadataPath);
  const raw = await readFile(absolutePath, 'utf8');
  return JSON.parse(raw) as CollectionMetadata;
}

function initSupabase() {
  dotenv.config({ path: '.env.supabase' });

  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !serviceRole) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE in .env.supabase');
  }

  return createClient(url, serviceRole, {
    auth: { persistSession: false },
  });
}

function buildAttributeRows(metadata: CollectionMetadata) {
  return metadata.collection_items.map((item) => {
    const values = item.attributes.reduce((acc, attribute) => {
      const existing = acc[attribute.trait_type];
      if (existing !== undefined) {
        acc[attribute.trait_type] = Array.isArray(existing)
          ? [...existing, attribute.value]
          : [existing, attribute.value];
      } else {
        acc[attribute.trait_type] = attribute.value;
      }
      return acc;
    }, {} as Record<string, AttributeValue | AttributeValue[]>);

    return {
      slug: metadata.slug,
      sha: item.sha,
      values,
      tokenId: item.index,
    };
  });
}

function buildAttributesFile(metadata: CollectionMetadata) {
  const formattedAttributes = metadata.collection_items.reduce((acc, item) => {
    acc[item.sha] = item.attributes.map((attribute) => ({
      k: attribute.trait_type,
      v: attribute.value,
    }));
    return acc;
  }, {} as Record<string, Array<{ k: string; v: AttributeValue }>>);

  return Buffer.from(JSON.stringify(formattedAttributes));
}

async function verifyCollectionExists(supabase: ReturnType<typeof initSupabase>, slug: string) {
  const { data, error } = await supabase
    .from('collections')
    .select('slug')
    .eq('slug', slug)
    .single();

  if (error || !data) {
    throw new Error(`Collection "${slug}" does not exist in collections`);
  }
}

async function verifyExistingShaCoverage(
  supabase: ReturnType<typeof initSupabase>,
  metadata: CollectionMetadata,
) {
  const metadataShas = metadata.collection_items.map((item) => item.sha);
  const existingShas = new Set<string>();
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from('ethscriptions')
      .select('sha')
      .eq('slug', metadata.slug)
      .range(from, to);

    if (error) throw error;
    if (!data || data.length === 0) break;

    data.forEach((row) => existingShas.add(row.sha));

    if (data.length < pageSize) break;
    from += pageSize;
  }

  const missingShas = metadataShas.filter((sha) => !existingShas.has(sha));

  if (missingShas.length > 0) {
    throw new Error(
      `Found ${missingShas.length} metadata SHAs missing from ethscriptions for slug "${metadata.slug}". ` +
      'This script only supports attribute refreshes for already-indexed items.',
    );
  }
}

async function upsertAttributes(
  supabase: ReturnType<typeof initSupabase>,
  rows: ReturnType<typeof buildAttributeRows>,
) {
  const { error: newError } = await supabase
    .from('attributes_new')
    .upsert(rows, { onConflict: 'sha' });
  if (newError) throw newError;

  const { error: legacyError } = await supabase
    .from('attributes')
    .upsert(rows, { onConflict: 'sha' });
  if (legacyError) throw legacyError;
}

async function uploadAttributesFile(
  supabase: ReturnType<typeof initSupabase>,
  slug: string,
  fileBuffer: Buffer,
) {
  const { error } = await supabase
    .storage
    .from('data')
    .upload(`${slug}_attributes.json`, fileBuffer, {
      upsert: true,
      contentType: 'application/json',
    });

  if (error) throw error;
}

async function main() {
  const options = parseArgs();
  const metadata = await loadMetadata(options.metadataPath);
  const supabase = initSupabase();

  console.log(`Refreshing collection attributes for "${metadata.slug}"`);
  console.log(`  Metadata items: ${metadata.collection_items.length}`);
  console.log(`  Dry run: ${options.dryRun}`);

  await verifyCollectionExists(supabase, metadata.slug);
  await verifyExistingShaCoverage(supabase, metadata);

  const attributeRows = buildAttributeRows(metadata);
  const attributesFile = buildAttributesFile(metadata);

  console.log(`  Prepared ${attributeRows.length} attribute rows`);
  console.log(`  Prepared ${attributesFile.length} byte attributes file`);

  if (options.dryRun) {
    console.log('Dry run complete. No changes written.');
    return;
  }

  await upsertAttributes(supabase, attributeRows);
  await uploadAttributesFile(supabase, metadata.slug, attributesFile);

  console.log('Attributes DB tables refreshed');
  console.log(`Uploaded data/${metadata.slug}_attributes.json`);
  console.log('Done');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
