import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SUPABASE_CLI_VERSION = '2.84.2';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATTERN = /^(\d{14})_[a-z0-9_]+\.sql$/;
const CLAIM_EVIDENCE_MIGRATION =
  '20261004000000_business_claim_evidence_retention_foundation.sql';
const CLAIM_EVIDENCE_BARRIER_CLASS_ID = 7_742_004;
const CLAIM_EVIDENCE_BARRIER_OBJECT_ID = 1;

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

export function runtimeSupabaseConfig(source, projectId, databasePort) {
  if (!/^[a-z0-9-]+$/.test(projectId)) throw new Error('Invalid temporary Supabase project id.');
  if (!Number.isInteger(databasePort) || databasePort < 1024 || databasePort > 65535) {
    throw new Error('Invalid temporary Supabase database port.');
  }
  const projectPattern = /^project_id\s*=\s*"[^"]+"/m;
  if (!projectPattern.test(source)) throw new Error('Supabase config is missing project_id.');
  let config = source.replace(projectPattern, `project_id = "${projectId}"`);
  const databaseHeader = /^\[db\]\s*$/m.exec(config);
  if (!databaseHeader) {
    return `${config.trimEnd()}\n\n[db]\nport = ${databasePort}\n`;
  }

  const sectionStart = databaseHeader.index + databaseHeader[0].length;
  const sectionTail = config.slice(sectionStart);
  const nextHeaderOffset = sectionTail.search(/^\[[^\]]+\]\s*$/m);
  const sectionEnd = nextHeaderOffset < 0 ? config.length : sectionStart + nextHeaderOffset;
  const section = config.slice(sectionStart, sectionEnd);
  const portPattern = /^\s*port\s*=\s*\d+\s*$/m;
  const updatedSection = portPattern.test(section)
    ? section.replace(portPattern, `\nport = ${databasePort}`)
    : `\nport = ${databasePort}${section}`;
  config = `${config.slice(0, sectionStart)}${updatedSection}${config.slice(sectionEnd)}`;
  return config.endsWith('\n') ? config : `${config}\n`;
}

async function availableLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ exclusive: true, host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a temporary Supabase database port.'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
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

function runExpectingFailure(command, args, expectedPatterns, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status === 0) {
    throw new Error(`${command} ${args.join(' ')} unexpectedly succeeded.`);
  }
  for (const expected of expectedPatterns) {
    if (!expected.test(output)) {
      throw new Error(
        `${command} ${args.join(' ')} failed without the required evidence ${expected}.\n${output}`,
      );
    }
  }
  return output;
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function startCaptured(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let exitError = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  // A holder may exit between the settled check and a release write. Treat an
  // EPIPE as process completion evidence instead of an unhandled stream error.
  child.stdin.on('error', () => undefined);
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
  }, options.timeout ?? 30_000);
  const completion = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timeout);
      settled = true;
      exitError = error;
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      settled = true;
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      exitError = new Error(
        `${command} ${args.join(' ')} failed with exit code ${code ?? 'null'}`
          + `${signal ? ` (${signal})` : ''}.\n${stdout}${stderr}`,
      );
      reject(exitError);
    });
  });
  // The owner awaits completion after coordinating the second session. Attach
  // a handler now so an early child failure cannot become an unhandled rejection.
  void completion.catch(() => undefined);
  return {
    completion,
    failure: () => exitError,
    isSettled: () => settled,
    sendLine: (value) => {
      if (!settled && child.stdin.writable) child.stdin.write(`${value}\n`);
    },
    terminate: () => child.kill('SIGKILL'),
    waitForCompletion: async (timeoutMs) => await withTimeout(
      completion,
      timeoutMs,
      `${command} did not exit within ${timeoutMs}ms.`,
    ),
    waitForOutput: async (expected, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (expected.test(`${stdout}${stderr}`)) return;
        if (settled) {
          throw exitError ?? new Error(`${command} exited before emitting ${expected}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`${command} did not emit ${expected} within ${timeoutMs}ms.`);
    },
  };
}

export function psqlCommandArguments(containerName, sql) {
  return [
    'exec',
    containerName,
    'psql',
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-v',
    'VERBOSITY=verbose',
    '-At',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-c',
    sql,
  ];
}

export function interactivePsqlFileArguments(containerName, containerPath) {
  const args = psqlArguments(containerPath, false);
  args[1] = containerName;
  args.splice(1, 0, '-i');
  return args;
}

function copySqlToContainer(sourcePath, containerName, containerPath) {
  run('docker', ['cp', sourcePath, `${containerName}:${containerPath}`]);
}

function copyAndExpectSqlFailure({
  sourcePath,
  containerName,
  containerPath,
  expectedPatterns,
  singleTransaction,
}) {
  copySqlToContainer(sourcePath, containerName, containerPath);
  const args = psqlArguments(containerPath, singleTransaction);
  args[1] = containerName;
  runExpectingFailure('docker', args, expectedPatterns);
}

async function assertBarrierBlocks({
  projectRoot,
  containerName,
  holderFile,
  readyMarker,
  waiterSql,
  expectedPatterns = [/55P03/, /lock timeout/i],
}) {
  const containerPath = `/tmp/${holderFile}`;
  copySqlToContainer(
    path.join(projectRoot, 'supabase', 'tests', holderFile),
    containerName,
    containerPath,
  );
  const holderArguments = interactivePsqlFileArguments(containerName, containerPath);
  const holder = startCaptured('docker', holderArguments, { timeout: 30_000 });
  let operationError = null;
  try {
    await holder.waitForOutput(new RegExp(readyMarker), 5_000);
    runExpectingFailure(
      'docker',
      psqlCommandArguments(containerName, waiterSql),
      expectedPatterns,
      { timeout: 10_000 },
    );
    holder.sendLine('release');
    await holder.waitForCompletion(5_000);
  } catch (error) {
    operationError = error;
  } finally {
    if (!holder.isSettled()) holder.sendLine('release');
    try {
      await holder.waitForCompletion(3_000);
    } catch (error) {
      if (!holder.isSettled()) holder.terminate();
      try {
        await holder.waitForCompletion(3_000);
      } catch (terminationError) {
        if (!operationError) operationError = terminationError ?? error;
      }
    }
  }
  if (operationError) throw operationError;
}

async function verifyProviderClaimSerializationBarrier(projectRoot, containerName) {
  process.stdout.write('Verifying provider/claim serialization barrier across two sessions\n');
  const holders = [
    ['provider_mutation_shared_barrier_holder.sql', 'SPOTTR_PROVIDER_MUTATION_SHARED_BARRIER_READY'],
    ['provider_source_shared_barrier_holder.sql', 'SPOTTR_PROVIDER_SOURCE_SHARED_BARRIER_READY'],
    ['provider_ingest_shared_barrier_holder.sql', 'SPOTTR_PROVIDER_INGEST_SHARED_BARRIER_READY'],
  ];

  for (const [holderFile, readyMarker] of holders) {
    await assertBarrierBlocks({
      projectRoot,
      containerName,
      holderFile,
      readyMarker,
      waiterSql: [
        'begin;',
        "set local lock_timeout = '500ms';",
        "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('spottr:provider-lifecycle', 0));",
        'rollback;',
      ].join(' '),
    });
  }

  // Notification dispatch must join the same provider lifecycle protocol
  // before it takes business rows. Holding a real provider mutation proves
  // the effective post-migration helper waits at the barrier instead of
  // reaching the historical business -> provider row-lock cycle.
  await assertBarrierBlocks({
    projectRoot,
    containerName,
    holderFile: holders[0][0],
    readyMarker: holders[0][1],
    waiterSql: [
      'begin;',
      "set local lock_timeout = '500ms';",
      "select private.lock_notification_business_eligibility(array['00000000-0000-4000-8000-000000000001'::uuid]);",
      'rollback;',
    ].join(' '),
  });

  // An untrusted AAL2 caller must be rejected before the exclusive approval
  // barrier is attempted. Holding the shared barrier turns incorrect ordering
  // into a lock-timeout SQLSTATE instead of the expected authorization error.
  await assertBarrierBlocks({
    projectRoot,
    containerName,
    holderFile: holders[0][0],
    readyMarker: holders[0][1],
    waiterSql: [
      'begin;',
      "set local role authenticated;",
      "select pg_catalog.set_config('request.jwt.claims', '{\"sub\":\"90000000-0000-4000-8000-000000000009\",\"role\":\"authenticated\",\"aal\":\"aal2\"}', true);",
      "set local lock_timeout = '500ms';",
      "select public.review_business_claim('90000000-0000-4000-8000-000000000099', 'approved', 'runtime authorization ordering');",
      'rollback;',
    ].join(' '),
    expectedPatterns: [/42501/, /Platform administrator role required/],
  });
}

async function verifyBusinessClaimEvidenceStorageBarrier(projectRoot, containerName) {
  process.stdout.write('Verifying business-claim evidence storage barrier across two sessions\n');
  await assertBarrierBlocks({
    projectRoot,
    containerName,
    holderFile: 'business_claim_evidence_shared_barrier_holder.sql',
    readyMarker: 'SPOTTR_CLAIM_EVIDENCE_SHARED_BARRIER_READY',
    waiterSql: [
      'begin;',
      "set local lock_timeout = '500ms';",
      `select pg_catalog.pg_advisory_xact_lock(${CLAIM_EVIDENCE_BARRIER_CLASS_ID}, ${CLAIM_EVIDENCE_BARRIER_OBJECT_ID});`,
      'rollback;',
    ].join(' '),
  });
  await assertBarrierBlocks({
    projectRoot,
    containerName,
    holderFile: 'business_claim_evidence_exclusive_barrier_holder.sql',
    readyMarker: 'SPOTTR_CLAIM_EVIDENCE_EXCLUSIVE_BARRIER_READY',
    waiterSql: [
      'begin;',
      "set local lock_timeout = '500ms';",
      'select public.prepare_media_cleanup_batch();',
      'rollback;',
    ].join(' '),
  });
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
  const databasePort = await availableLoopbackPort();
  const containerName = `supabase_db_${projectId}`;
  const cli = supabaseInvocation();
  let started = false;

  try {
    await mkdir(path.join(temporarySupabase, 'migrations'), { recursive: true });
    const configSource = path.join(projectRoot, 'supabase', 'config.toml');
    const config = runtimeSupabaseConfig(
      await readFile(configSource, 'utf8'),
      projectId,
      databasePort,
    );
    await writeFile(path.join(temporarySupabase, 'config.toml'), config, 'utf8');

    process.stdout.write(
      `Starting pinned Supabase CLI ${SUPABASE_CLI_VERSION} database runtime on ephemeral port ${databasePort}...\n`,
    );
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
      if (migrationName === CLAIM_EVIDENCE_MIGRATION) {
        process.stdout.write('Proving claim-evidence migration conflict rollback\n');
        await copyAndApplySql({
          sourcePath: path.join(
            projectRoot,
            'supabase',
            'tests',
            'business_claim_evidence_migration_conflict_setup.sql',
          ),
          containerName,
          containerPath: '/tmp/spottr-claim-evidence-conflict-setup.sql',
          singleTransaction: true,
        });
        copyAndExpectSqlFailure({
          sourcePath: path.join(migrationDirectory, migrationName),
          containerName,
          containerPath: `/tmp/${migrationName}`,
          expectedPatterns: [/LEGACY_CLAIM_EVIDENCE_ACCOUNT_DELETION_CONFLICT/],
          singleTransaction: true,
        });
        await copyAndApplySql({
          sourcePath: path.join(
            projectRoot,
            'supabase',
            'tests',
            'business_claim_evidence_migration_conflict_assert_and_cleanup.sql',
          ),
          containerName,
          containerPath: '/tmp/spottr-claim-evidence-conflict-assert.sql',
          singleTransaction: true,
        });
        await copyAndApplySql({
          sourcePath: path.join(
            projectRoot,
            'supabase',
            'tests',
            'business_claim_evidence_migration_mutation_rollback_setup.sql',
          ),
          containerName,
          containerPath: '/tmp/spottr-claim-evidence-mutation-rollback-setup.sql',
          singleTransaction: true,
        });
        const forcedRollbackMigrationPath = path.join(
          temporaryRoot,
          'spottr-claim-evidence-forced-rollback.sql',
        );
        const migrationSource = await readFile(
          path.join(migrationDirectory, migrationName),
          'utf8',
        );
        await writeFile(
          forcedRollbackMigrationPath,
          `${migrationSource.trimEnd()}\n\n`
            + 'do $spottr_forced_claim_evidence_rollback$\n'
            + 'begin\n'
            + "  raise exception using errcode = '55000', message = 'CLAIM_EVIDENCE_FORCED_ROLLBACK';\n"
            + 'end;\n'
            + '$spottr_forced_claim_evidence_rollback$;\n',
          'utf8',
        );
        copyAndExpectSqlFailure({
          sourcePath: forcedRollbackMigrationPath,
          containerName,
          containerPath: '/tmp/spottr-claim-evidence-forced-rollback.sql',
          expectedPatterns: [/CLAIM_EVIDENCE_FORCED_ROLLBACK/],
          singleTransaction: true,
        });
        await copyAndApplySql({
          sourcePath: path.join(
            projectRoot,
            'supabase',
            'tests',
            'business_claim_evidence_migration_mutation_rollback_assert_and_cleanup.sql',
          ),
          containerName,
          containerPath: '/tmp/spottr-claim-evidence-mutation-rollback-assert.sql',
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

    await verifyBusinessClaimEvidenceStorageBarrier(projectRoot, containerName);
    await verifyProviderClaimSerializationBarrier(projectRoot, containerName);

    await copyAndApplySql({
      sourcePath: path.join(projectRoot, 'supabase', 'tests', 'full_stack_security_runtime_test.sql'),
      containerName,
      containerPath: '/tmp/spottr-full-stack-security-runtime.sql',
      singleTransaction: false,
    });
    await copyAndApplySql({
      sourcePath: path.join(
        projectRoot,
        'supabase',
        'tests',
        'business_insider_trust_guard_runtime_test.sql',
      ),
      containerName,
      containerPath: '/tmp/spottr-business-insider-trust-guard-runtime.sql',
      singleTransaction: false,
    });
    await copyAndApplySql({
      sourcePath: path.join(
        projectRoot,
        'supabase',
        'tests',
        'provider_location_lifecycle_guard_runtime_test.sql',
      ),
      containerName,
      containerPath: '/tmp/spottr-provider-location-lifecycle-guard-runtime.sql',
      singleTransaction: false,
    });
    await copyAndApplySql({
      sourcePath: path.join(
        projectRoot,
        'supabase',
        'tests',
        'public_link_safety_runtime_test.sql',
      ),
      containerName,
      containerPath: '/tmp/spottr-public-link-safety-runtime.sql',
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
