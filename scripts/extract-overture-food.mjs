import { mkdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write(
    'Usage: node scripts/extract-overture-food.mjs --release YYYY-MM-DD.N --output PATH.parquet [--min-confidence 0.65] [--duckdb PATH] [--print-sql]\n'
  );
  process.exit(0);
}

const release = valueAfter(args, '--release');
const outputArgument = valueAfter(args, '--output');
const minimumConfidence = Number(valueAfter(args, '--min-confidence') ?? '0.65');
const duckdb = valueAfter(args, '--duckdb') ?? 'duckdb';

if (!release || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release)) {
  fail('A reviewed Overture release in YYYY-MM-DD.N format is required.');
}
if (!outputArgument || extname(outputArgument).toLocaleLowerCase('en-US') !== '.parquet') {
  fail('A .parquet output path is required.');
}
if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0.2 || minimumConfidence > 1) {
  fail('--min-confidence must be between 0.2 and 1.');
}
if (!/^[A-Za-z0-9_./:\\ -]{1,512}$/.test(duckdb)) {
  fail('The DuckDB executable path is invalid.');
}

const output = resolve(outputArgument);
const duckdbOutput = output.replaceAll('\\', '/');
const releaseUri = `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*`;
const query = `
INSTALL httpfs;
INSTALL spatial;
LOAD httpfs;
LOAD spatial;
SET s3_region='us-west-2';

COPY (
  SELECT
    CAST(id AS VARCHAR) AS overture_id,
    version AS overture_version,
    names.primary AS name,
    basic_category,
    taxonomy.primary AS taxonomy_primary,
    taxonomy.hierarchy AS taxonomy_hierarchy,
    confidence,
    operating_status,
    addresses[1].freeform AS address_line,
    addresses[1].locality AS city,
    addresses[1].region AS region,
    addresses[1].postcode AS postal_code,
    addresses[1].country AS country_code,
    websites[1] AS website_url,
    phones[1] AS phone,
    ST_Y(geometry) AS latitude,
    ST_X(geometry) AS longitude,
    CAST(sources AS JSON) AS source_metadata,
    ${sqlString(release)} AS overture_release
  FROM read_parquet(${sqlString(releaseUri)})
  WHERE list_contains(taxonomy.hierarchy, 'food_and_drink')
    AND confidence >= ${minimumConfidence.toFixed(4)}
    AND names.primary IS NOT NULL
    AND length(trim(names.primary)) BETWEEN 1 AND 160
    AND geometry IS NOT NULL
) TO ${sqlString(duckdbOutput)} (FORMAT PARQUET, COMPRESSION ZSTD);
`.trim();

if (args.includes('--print-sql')) {
  process.stdout.write(`${query}\n`);
  process.exit(0);
}

mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(duckdb, ['-c', query], {
  encoding: 'utf8',
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
if (result.error) fail(`DuckDB could not start: ${result.error.message}`);
if (result.status !== 0) fail(`Overture extraction failed: ${(result.stderr || '').trim()}`);
process.stdout.write(`Wrote reviewed Overture food-and-drink staging data to ${output}\n`);
