import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SUPABASE_CLI_VERSION = '2.84.2';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATTERN = /^(\d{14})_[a-z0-9_]+\.sql$/;

export function orderedMigrationNames(names) {
  const sqlNames = names.filter((name) => name.endsWith('.sql'));
  const parsed = sqlNames.map((name) => {
    const match = MIGRATION_PATTERN.exec(name);
    if (!match) throw new Error(`Invalid migration filename: ${name}`);
    return { name, timestamp: match[1] };
  });
  parsed.sort((left, right) => left.name.localeCompare(right.name));
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index - 1].timestamp === parsed[index].timestamp) {
      throw new Error(`Duplicate migration timestamp: ${parsed[index].timestamp}`);
    }
  }
  if (parsed.length === 0) throw new Error('No SQL migrations found.');
  return parsed.map(({ name }) => name);
}

export function psqlArguments(containerPath, singleTransaction = true) {
  return [
    'exec',
    'PLACEHOLDER_CONTAINER',
    'psql',
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    ...(singleTransaction ? ['-1'] : []),
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-f',
    containerPath,
  ];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture
      ? `\n${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd()
      : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.${details}`);
  }
  return result.stdout?.trim() ?? '';
}

function supabaseInvocation() {
  const globalProbe = spawnSync('supabase', ['--version'], {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  if (
    !globalProbe.error
    && globalProbe.status === 0
    && globalProbe.stdout.trim() === SUPABASE_CLI_VERSION
  ) {
    return { command: 'supabase', prefix: [] };
  }
  if (process.platform === 'win32') {
    const npmEntrypoint = process.env.npm_execpath;
    if (!npmEntrypoint) {
      throw new Error('Run the database gate through npm so the pinned Supabase CLI can be resolved.');
    }
    return {
      command: process.execPath,
      prefix: [path.join(path.dirname(npmEntrypoint), 'npx-cli.js'), '--yes', `supabase@${SUPABASE_CLI_VERSION}`],
    };
  }
  return {
    command: 'npx',
    prefix: ['--yes', `supabase@${SUPABASE_CLI_VERSION}`],
  };
}

async function copyAndApplySql({ sourcePath, containerName, containerPath, singleTransaction }) {
  run('docker', ['cp', sourcePath, `${containerName}:${containerPath}`]);
  const args = psqlArguments(containerPath, singleTransaction);
  args[1] = containerName;
  run('docker', args);
}

export async function runDatabaseRuntimeGate(projectRoot = PROJECT_ROOT) {
  run('docker', ['info'], { capture: true, timeout: 30_000 });

  const migrationDirectory = path.join(projectRoot, 'supabase', 'migrations');
  const migrationNames = orderedMigrationNames(await readdir(migrationDirectory));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'spottr-db-runtime-'));
  const temporarySupabase = path.join(temporaryRoot, 'supabase');
  const projectId = `spottr-runtime-${process.pid}-${Date.now()}`;
  const containerName = `supabase_db_${projectId}`;
  const cli = supabaseInvocation();
  let started = false;

  try {
    await mkdir(path.join(temporarySupabase, 'migrations'), { recursive: true });
    const configSource = path.join(projectRoot, 'supabase', 'config.toml');
    const config = (await readFile(configSource, 'utf8')).replace(
      /^project_id\s*=\s*"[^"]+"/m,
      `project_id = "${projectId}"`,
    );
    await writeFile(path.join(temporarySupabase, 'config.toml'), config, 'utf8');

    process.stdout.write(`Starting pinned Supabase CLI ${SUPABASE_CLI_VERSION} database runtime...\n`);
    started = true;
    run(cli.command, [...cli.prefix, 'db', 'start', `--workdir=${temporaryRoot}`], {
      timeout: 600_000,
    });

    await copyAndApplySql({
      sourcePath: path.join(projectRoot, 'supabase', 'schema.sql'),
      containerName,
      containerPath: '/tmp/spottr-schema.sql',
      singleTransaction: true,
    });
    await copyAndApplySql({
      sourcePath: path.join(projectRoot, 'supabase', 'tests', 'schema_contracts.sql'),
      containerName,
      containerPath: '/tmp/spottr-schema-contracts.sql',
      singleTransaction: false,
    });

    for (const migrationName of migrationNames) {
      if (migrationName === '20260817000000_upgrade_runtime_compatibility.sql') {
        process.stdout.write('Installing representative legacy upgrade fixture\n');
        await copyAndApplySql({
          sourcePath: path.join(
            projectRoot,
            'supabase',
            'tests',
            'upgrade_runtime_compatibility_runtime_setup.sql',
          ),
          containerName,
          containerPath: '/tmp/spottr-legacy-upgrade-fixture.sql',
          singleTransaction: true,
        });
      }
      process.stdout.write(`Applying ${migrationName}\n`);
      await copyAndApplySql({
        sourcePath: path.join(migrationDirectory, migrationName),
        containerName,
        containerPath: `/tmp/${migrationName}`,
        singleTransaction: true,
      });
    }

    await copyAndApplySql({
      sourcePath: path.join(projectRoot, 'supabase', 'tests', 'full_stack_security_runtime_test.sql'),
      containerName,
      containerPath: '/tmp/spottr-full-stack-security-runtime.sql',
      singleTransaction: false,
    });
    process.stdout.write(
      `Fresh Supabase runtime verified: baseline, ${migrationNames.length} migrations, and post-chain security contracts.\n`,
    );
  } finally {
    if (started) {
      try {
        run(cli.command, [...cli.prefix, 'stop', `--workdir=${temporaryRoot}`, '--no-backup'], {
          timeout: 180_000,
        });
      } catch (error) {
        console.error(`Failed to stop temporary Supabase runtime: ${error instanceof Error ? error.message : error}`);
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runDatabaseRuntimeGate().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
