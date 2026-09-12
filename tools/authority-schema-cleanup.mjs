#!/usr/bin/env node
// Offline conversion of an independently stopped/restored copy. No live activation.
import { createHash } from 'node:crypto';
import { constants, chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { stateLineageDatabaseSlotsV2, validateStateLineageRootManifestV2 } from '@echo-brain/organization-authority-kernel/state-lineage/state-lineage-manifest-v1';
import { verifyStateLineageBeforeOpen } from '@echo-brain/organization-authority-kernel/state-lineage/state-lineage-preopen-guard';
import { verifyAuthorityStateLineage } from '@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestTable = 'echo_state_lineage_manifest';
const roles = [
  { role: 'authority', file: 'authority.sqlite', directory: 'organization-authority-kernel', from: 4, to: 5,
    source: ['authority-baseline-v1.sql', 'authority-meeting-processing-v3.sql', 'authority-approval-delivery-quarantine-v4.sql'], target: 'authority-baseline-v5.sql',
    retired: ['authority_record_write_receipts', 'authority_record_write_inputs', 'authority_provider_human_action_reproofs', 'authority_live_v4_receipts_v2'] },
  { role: 'control-plane', file: 'integrations.sqlite', directory: 'organization-control-plane', from: 2, to: 3,
    source: ['organization-control-plane-baseline-v1.sql', 'organization-control-plane-private-approval-v2.sql'], target: 'organization-control-plane-baseline-v3.sql',
    retired: ['organization_approval_activation_commands', 'organization_approval_activation_resources', 'organization_person_slack_pending_approval_commands', 'organization_person_slack_pending_approvals', 'organization_approval_action_capability_current', 'organization_approval_action_capability_contracts', 'organization_approval_binding_current', 'organization_approval_binding_contracts', 'organization_provider_human_action_evidence'] },
  { role: 'record-log', file: 'record-log.sqlite', directory: 'organization-record', from: 2, to: 3,
    source: ['organization-record-log-baseline-v2.sql'], target: 'organization-record-log-baseline-v3.sql', retired: [] },
  { role: 'record-derived', file: 'record-derived.sqlite', directory: 'organization-record', from: 1,
    source: ['organization-record-derived-baseline-v1.sql'], retired: [] },
];
const sqlFor = (role, target = false) => (target ? [role.target] : role.source)
  .map(name => readFileSync(join(repo, 'packages', role.directory, 'baselines', name), 'utf8')).join('\n');
const refuse = code => { throw new Error(`schema_cleanup_${code}`); };

function privateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) refuse('unsafe_directory');
}

function readPrivateFile(path, consume) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) refuse('unsafe_file');
    const buffer = Buffer.alloc(1024 * 1024);
    for (let size; (size = readSync(fd, buffer, 0, buffer.length, null)) > 0;) consume(buffer.subarray(0, size));
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) refuse('source_changed');
  } finally { closeSync(fd); }
}

function copyPrivateFile(source, target) {
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    readPrivateFile(source, chunk => {
      for (let offset = 0; offset < chunk.length;) offset += writeSync(fd, chunk, offset, chunk.length - offset);
    });
  } finally { closeSync(fd); }
}

/** Files are hashed internally; neither file contents nor private names are returned. */
function inventory(path) {
  privateDirectory(path);
  const entries = [];
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), stat = lstatSync(file);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid()) refuse('unsafe_entry');
      if (stat.isDirectory()) {
        privateDirectory(file);
        entries.push([relative(path, file), 'directory']);
        visit(file);
      } else {
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) refuse('unsafe_file');
        if (/(?:-wal|-shm|-journal)$/.test(name)) refuse('database_not_offline');
        const hash = createHash('sha256');
        readPrivateFile(file, chunk => hash.update(chunk));
        entries.push([relative(path, file), hash.digest('hex')]);
      }
    }
  };
  visit(path);
  return { entries, sha256: digest(JSON.stringify(entries)) };
}

function schema(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name != ? ORDER BY type, name").all(manifestTable);
}

function referenceSchema(sql) {
  const db = new Database(':memory:');
  try { db.exec(sql); return schema(db); } finally { db.close(); }
}

function verifyDatabase(db, expected) {
  if (JSON.stringify(schema(db)) !== JSON.stringify(expected)) refuse('schema_drift');
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length !== 0) refuse('database_integrity');
}

function rowProof(db, tables) {
  return tables.map(table => {
    const hash = createHash('sha256'); let count = 0;
    // Names come only from the exact validated schema; quote defensively.
    const name = '"' + table.replaceAll('"', '""') + '"';
    for (const row of db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).raw().safeIntegers().iterate()) {
      hash.update(JSON.stringify(row.map(value => Buffer.isBuffer(value) ? ['blob', value.toString('hex')] : [typeof value, typeof value === 'bigint' ? value.toString() : value])) + '\n');
      count += 1;
    }
    return { table, rows: count, sha256: hash.digest('hex') };
  });
}

function sourceSchemas() {
  const schemas = Object.fromEntries(roles.map(role => [role.role, { database_schema_version: role.from, schema_sha256: `sha256:${digest(sqlFor(role))}` }]));
  for (const [plane, version] of [['facts', 2], ['lexical', 1], ['content', 1]]) {
    const sql = readFileSync(join(repo, 'packages/organization-retrieval/baselines', `readable-search-${plane}-baseline-v${version}.sql`));
    schemas[`retrieval-${plane}`] = { database_schema_version: version, schema_sha256: `sha256:${digest(sql)}` };
  }
  return schemas;
}

function inspect(source) {
  if (!isAbsolute(source) || resolve(source) !== source) refuse('source_path');
  const before = inventory(source);
  let root;
  try { root = JSON.parse(readFileSync(join(source, 'state-lineage-root.v1.json'), 'utf8')); }
  catch { refuse('unsupported_source'); }
  const lineage = verifyStateLineageBeforeOpen({ state_directory: source, root_manifest_version: 1,
    expected_binding: { authority_id: root.authority_id, organization_id: root.organization_id, state_lineage_id: root.state_lineage_id }, expected_schemas: sourceSchemas() });
  const proofs = {};
  for (const role of roles) {
    const db = new Database(join(source, role.file), { readonly: true, fileMustExist: true });
    try {
      db.pragma('query_only = ON'); db.pragma('trusted_schema = OFF');
      const expected = referenceSchema(sqlFor(role));
      verifyDatabase(db, expected);
      const tables = expected.filter(object => object.type === 'table').map(object => object.name);
      const retired = role.role === 'record-derived' ? tables.filter(table => !['organization_derived_metadata', 'organization_derived_cursor'].includes(table)) : role.retired;
      if (rowProof(db, retired).some(proof => proof.rows !== 0)) refuse('retired_table_not_empty');
      if (role.role === 'record-derived') {
        const metadata = db.prepare('SELECT * FROM organization_derived_metadata').all();
        const cursor = db.prepare('SELECT * FROM organization_derived_cursor').all();
        if (metadata.length > 1 || cursor.length > 1 || metadata.some(row => row.organization_id !== root.organization_id) || cursor.some(row => row.last_position !== 0)) refuse('derived_state_not_empty');
      } else proofs[role.role] = rowProof(db, tables.filter(table => !role.retired.includes(table)));
    } finally { db.close(); }
  }
  if (inventory(source).sha256 !== before.sha256) refuse('source_changed');
  return { root: lineage.root, before, proofs };
}

export function inspectAuthoritySchemaCleanup(source) {
  const checked = inspect(source);
  return Object.freeze({ kind: 'echo-authority-schema-cleanup-inspection-v1', source_inventory_sha256: checked.before.sha256,
    source_root_version: 1, target_root_version: 2, retired_tables_empty: true, retained_rows: checked.proofs });
}

/** Never modifies source, activates output, contacts a provider, or creates a backup. */
export function convertAuthoritySchemaCleanup({ source, output, expectedSourceInventorySha256, artifactSourceSha }) {
  if (!/^[0-9a-f]{64}$/.test(expectedSourceInventorySha256) || !/^[0-9a-f]{40}$/.test(artifactSourceSha)) refuse('identity_required');
  if (!isAbsolute(output) || resolve(output) !== output || source === output || output.startsWith(source + '/') || source.startsWith(output + '/')) refuse('output_path');
  privateDirectory(dirname(output));
  if (existsSync(output)) refuse('output_exists');
  const checked = inspect(source);
  if (checked.before.sha256 !== expectedSourceInventorySha256) refuse('source_changed');
  const staging = mkdtempSync(join(dirname(output), '.schema-cleanup-'));
  chmodSync(staging, 0o700);
  let reserved;
  try {
    for (const [name, identity] of checked.before.entries) {
      const destination = join(staging, name);
      if (identity === 'directory') mkdirSync(destination, { mode: 0o700 });
      else copyPrivateFile(join(source, name), destination);
    }
    if (inventory(staging).sha256 !== checked.before.sha256 || inventory(source).sha256 !== checked.before.sha256) refuse('source_changed');
    for (const role of roles.filter(role => role.target)) {
      const db = new Database(join(staging, role.file), { fileMustExist: true });
      try {
        db.pragma('foreign_keys = ON'); db.pragma('trusted_schema = OFF'); db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL');
        db.exec('BEGIN IMMEDIATE');
        for (const table of role.retired) db.exec(`DROP TABLE ${table}`);
        if (role.role === 'record-log') db.exec('DROP INDEX organization_record_member_readable_person_fact_by_record');
        const old = JSON.parse(db.prepare(`SELECT manifest_json FROM ${manifestTable} WHERE singleton = 1`).get().manifest_json);
        const body = { ...old, database_schema_version: role.to, schema_sha256: `sha256:${digest(sqlFor(role, true))}`, creating_artifact_revision: artifactSourceSha };
        db.prepare(`UPDATE ${manifestTable} SET manifest_json = ?, manifest_sha256 = ? WHERE singleton = 1`).run(canonicalJson(body), canonicalSha256(body));
        db.pragma(`user_version = ${role.to}`);
        verifyDatabase(db, referenceSchema(sqlFor(role, true)));
        if (JSON.stringify(rowProof(db, checked.proofs[role.role].map(proof => proof.table))) !== JSON.stringify(checked.proofs[role.role])) refuse('retained_rows_changed');
        db.exec('COMMIT');
      } finally { db.close(); }
    }
    rmSync(join(staging, 'record-derived.sqlite'));
    rmSync(join(staging, 'state-lineage-root.v1.json'));
    const root = validateStateLineageRootManifestV2({ ...checked.root, schema_version: 2, kind: 'echo-state-lineage-root-manifest-v2', databases: stateLineageDatabaseSlotsV2(), creating_artifact_revision: artifactSourceSha });
    writeFileSync(join(staging, 'state-lineage-root.v2.json'), canonicalJson(root), { mode: 0o600, flag: 'wx' });
    verifyAuthorityStateLineage(staging);
    if (inventory(source).sha256 !== checked.before.sha256) refuse('source_changed');
    const after = inventory(staging);
    const changed = new Set([...roles.map(role => role.file), 'state-lineage-root.v1.json', 'state-lineage-root.v2.json']);
    if (JSON.stringify(checked.before.entries.filter(([name]) => !changed.has(name))) !== JSON.stringify(after.entries.filter(([name]) => !changed.has(name)))) refuse('retained_files_changed');
    const receipt = { kind: 'echo-authority-schema-cleanup-receipt-v1', source_inventory_sha256: checked.before.sha256,
      output_inventory_sha256: after.sha256, artifact_source_sha: artifactSourceSha, source_unchanged: true, retained_rows_unchanged: true, root_manifest_sha256: canonicalSha256(root), retired_tables: 22 };
    // Reserve without replacing an existing destination, then publish by rename.
    mkdirSync(output, { mode: 0o700 }); reserved = lstatSync(output);
    renameSync(staging, output); reserved = undefined;
    return Object.freeze(receipt);
  } catch (error) {
    if (reserved && existsSync(output)) {
      const stat = lstatSync(output);
      if (stat.ino === reserved.ino && stat.dev === reserved.dev && readdirSync(output).length === 0) rmSync(output, { recursive: true });
    }
    throw error;
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
}

function main(argv) {
  const [action, ...flags] = argv, options = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!flags[i]?.startsWith('--') || !flags[i + 1] || options[flags[i]]) refuse('arguments');
    options[flags[i]] = flags[i + 1];
  }
  const expected = action === 'inspect' ? ['--offline-source'] : action === 'convert' ? ['--offline-source', '--output', '--source-inventory-sha256', '--artifact-source-sha'] : [];
  if (!expected.length || JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(expected.sort())) refuse('arguments');
  return action === 'inspect' ? inspectAuthoritySchemaCleanup(options['--offline-source']) : convertAuthoritySchemaCleanup({ source: options['--offline-source'], output: options['--output'], expectedSourceInventorySha256: options['--source-inventory-sha256'], artifactSourceSha: options['--artifact-source-sha'] });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n'); }
  catch { process.stderr.write('schema_cleanup_refused\n'); process.exitCode = 1; }
}
