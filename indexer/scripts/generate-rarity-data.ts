import { writeFile } from 'fs/promises';
import { resolve } from 'path';

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

type AttributeValues = Record<string, string | number | boolean | Array<string | number | boolean> | null>;

type AttributeRow = {
  sha: string;
  slug: string | null;
  values: AttributeValues | null;
};

type CollectionRow = {
  id: number;
  slug: string;
  ignoredTraitFilters: string[] | null;
  ignoredTraitFiltersForCounts: string[] | null;
};

type CollectionConfig = {
  id: number;
  ignoredTraits: Set<string>;
};

type Options = {
  remote: boolean;
  dryRun: boolean;
  outputPath: string;
  ignoredTraits: Set<string>;
};

const PAGE_SIZE = 1000;
const DEFAULT_OUTPUT_PATH = 'src/modules/notifs/constants/rarity.ts';
const DEFAULT_IGNORED_TRAITS = ['Name', 'Description'];

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    remote: false,
    dryRun: false,
    outputPath: DEFAULT_OUTPUT_PATH,
    ignoredTraits: new Set(DEFAULT_IGNORED_TRAITS),
  };

  args.forEach((arg, index) => {
    if (arg === '--remote') {
      options.remote = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--output=')) {
      options.outputPath = arg.split('=')[1] || DEFAULT_OUTPUT_PATH;
    } else if (arg === '--output' && args[index + 1]) {
      options.outputPath = args[index + 1];
    } else if (arg.startsWith('--ignore-trait=')) {
      options.ignoredTraits.add(arg.split('=')[1]);
    } else if (arg === '--ignore-trait' && args[index + 1]) {
      options.ignoredTraits.add(args[index + 1]);
    }
  });

  return options;
}

function loadEnv() {
  dotenv.config({ path: '.env.supabase' });
  dotenv.config({ path: '.env.mainnet' });
  dotenv.config({ path: '.env' });
}

function initSupabase(options: Options) {
  loadEnv();

  const url = options.remote
    ? process.env.SUPABASE_URL_PROD || process.env.SUPABASE_URL
    : process.env.SUPABASE_URL;
  const serviceRole = options.remote
    ? process.env.SUPABASE_SERVICE_ROLE_PROD || process.env.SUPABASE_SERVICE_ROLE
    : process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !serviceRole) {
    throw new Error(
      options.remote
        ? 'Missing SUPABASE_URL_PROD/SUPABASE_SERVICE_ROLE_PROD or SUPABASE_URL/SUPABASE_SERVICE_ROLE'
        : 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE',
    );
  }

  return createClient(url, serviceRole, {
    auth: { persistSession: false },
  });
}

async function fetchAllCollections(supabase: ReturnType<typeof initSupabase>) {
  const collections = new Map<string, CollectionConfig>();
  let from = 0;

  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('collections')
      .select('id, slug, ignoredTraitFilters, ignoredTraitFiltersForCounts')
      .order('id', { ascending: true })
      .range(from, to);

    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const collection of data as CollectionRow[]) {
      const ignoredTraits = new Set<string>();

      for (const trait of collection.ignoredTraitFilters || []) ignoredTraits.add(trait);
      for (const trait of collection.ignoredTraitFiltersForCounts || []) ignoredTraits.add(trait);

      collections.set(collection.slug, {
        id: collection.id,
        ignoredTraits,
      });
    }

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return collections;
}

async function fetchAllAttributeRows(supabase: ReturnType<typeof initSupabase>) {
  const rows: AttributeRow[] = [];
  let from = 0;

  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('attributes_new')
      .select('sha, slug, values')
      .order('slug', { ascending: true })
      .order('sha', { ascending: true })
      .range(from, to);

    if (error) throw error;
    if (!data || data.length === 0) break;

    rows.push(...(data as AttributeRow[]));

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

function normalizeValue(value: string | number | boolean): string {
  return String(value);
}

function addCount(target: Record<string, number>, value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) return;

  const key = normalizeValue(value);
  target[key] = (target[key] || 0) + 1;
}

function buildRarityData(
  rows: AttributeRow[],
  collections: Map<string, CollectionConfig>,
  globallyIgnoredTraits: Set<string>,
) {
  const rarityData: Record<string, Record<string, number>> = {};

  for (const row of rows) {
    if (!row.slug || !row.values) continue;

    const ignoredTraits = collections.get(row.slug)?.ignoredTraits || new Set<string>();
    const collectionCounts = rarityData[row.slug] ||= {};

    for (const [trait, rawValue] of Object.entries(row.values)) {
      if (globallyIgnoredTraits.has(trait) || ignoredTraits.has(trait)) continue;

      if (Array.isArray(rawValue)) {
        rawValue.forEach((value) => addCount(collectionCounts, value));
      } else {
        addCount(collectionCounts, rawValue);
      }
    }
  }

  return rarityData;
}

function sortRarityData(
  rarityData: Record<string, Record<string, number>>,
  collections: Map<string, CollectionConfig>,
) {
  const sorted: Record<string, Record<string, number>> = {};

  const orderedSlugs = Object.keys(rarityData).sort((slugA, slugB) => {
    const idA = collections.get(slugA)?.id ?? Number.MAX_SAFE_INTEGER;
    const idB = collections.get(slugB)?.id ?? Number.MAX_SAFE_INTEGER;
    if (idA !== idB) return idA - idB;
    return slugA.localeCompare(slugB);
  });

  for (const slug of orderedSlugs) {
    const values = rarityData[slug];
    sorted[slug] = Object.fromEntries(
      Object.entries(values).sort(([valueA, countA], [valueB, countB]) => {
        if (countA !== countB) return countA - countB;
        return valueA.localeCompare(valueB);
      }),
    );
  }

  return sorted;
}

function formatObjectKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? key
    : `'${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function formatRarityDataFile(rarityData: Record<string, Record<string, number>>) {
  const lines = [
    '// Generated by scripts/generate-rarity-data.ts. Do not edit by hand.',
    '',
    'export const rarityData: any = {',
  ];

  const slugs = Object.keys(rarityData);
  slugs.forEach((slug, slugIndex) => {
    lines.push(`  ${formatObjectKey(slug)}: {`);

    const values = Object.entries(rarityData[slug]);
    values.forEach(([value, count], valueIndex) => {
      const comma = valueIndex === values.length - 1 ? '' : ',';
      lines.push(`    ${formatObjectKey(value)}: ${count}${comma}`);
    });

    const comma = slugIndex === slugs.length - 1 ? '' : ',';
    lines.push(`  }${comma}`);
  });

  lines.push('};', '');

  return [
    ...lines,
  ].join('\n');
}

function summarize(rarityData: Record<string, Record<string, number>>) {
  const collections = Object.keys(rarityData);
  const valueCount = collections.reduce((total, slug) => total + Object.keys(rarityData[slug]).length, 0);

  console.log(`Collections: ${collections.length}`);
  console.log(`Trait values: ${valueCount}`);

  for (const slug of collections) {
    const values = Object.entries(rarityData[slug]);
    const preview = values
      .slice(0, 5)
      .map(([value, count]) => `${value}=${count}`)
      .join(', ');

    console.log(`  ${slug}: ${values.length} values${preview ? ` (${preview})` : ''}`);
  }
}

async function main() {
  const options = parseArgs();
  const supabase = initSupabase(options);

  const [collections, rows] = await Promise.all([
    fetchAllCollections(supabase),
    fetchAllAttributeRows(supabase),
  ]);

  const rarityData = sortRarityData(
    buildRarityData(rows, collections, options.ignoredTraits),
    collections,
  );
  summarize(rarityData);

  if (options.dryRun) {
    console.log('Dry run complete. No files written.');
    return;
  }

  const outputPath = resolve(options.outputPath);
  await writeFile(outputPath, formatRarityDataFile(rarityData));
  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
