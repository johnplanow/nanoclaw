/**
 * scripts/backup-snapshot.ts — consistent backup staging for the estate backup.
 *
 * Produces an always-consistent snapshot of NanoClaw's mutable state at
 * STAGING (default /home/jplanow/nanoclaw-backups/staging). The estate backup
 * (ops-vm cron -> backup_app.yml -> TrueNAS) copies THAT directory, never the
 * live files: v2.db is WAL-mode and the 162+ session DBs are written
 * continuously, so raw file copies can tear. SQLite files are snapshotted with
 * better-sqlite3's online backup API; groups/ is rsynced.
 *
 * Deliberately EXCLUDED (secrets never land on the backup share in plaintext;
 * see the secrets-DR plan with the ansible-playbooks estate repo):
 *   .env, data/env/, and the OneCLI vault (docker volumes).
 * Also excluded: v1 legacy state (data/nanoclaw.db, data/sessions/,
 * data/media*) — frozen since the v2 cutover, preserved in
 * ~/nanoclaw-backups/pre-v2-20260703/.
 *
 * Build order: snapshot into <staging>.tmp, then atomically swap into place,
 * so a concurrent estate pull sees either the old or the new snapshot.
 *
 * Usage: pnpm exec tsx scripts/backup-snapshot.ts
 * Cron: aliera user crontab 02:45 (estate pull runs after, ~03:15).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const STAGING = process.env.NANOCLAW_BACKUP_STAGING || '/home/jplanow/nanoclaw-backups/staging';
const TMP = `${STAGING}.tmp`;
const OLD = `${STAGING}.old`;

let dbOk = 0;
let dbFail = 0;

async function snapshotDb(src: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(src, { readonly: true });
    await db.backup(dest);
    dbOk++;
  } catch (err) {
    dbFail++;
    console.error(`WARN: snapshot failed for ${src}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    db?.close();
  }
}

async function main(): Promise<void> {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });

  // Central DB (WAL — must use the backup API).
  await snapshotDb(path.join(PROJECT_ROOT, 'data', 'v2.db'), path.join(TMP, 'data', 'v2.db'));

  // Per-session DBs (hold live scheduled tasks + message state).
  const sessionsRoot = path.join(PROJECT_ROOT, 'data', 'v2-sessions');
  if (fs.existsSync(sessionsRoot)) {
    for (const ag of fs.readdirSync(sessionsRoot)) {
      const agDir = path.join(sessionsRoot, ag);
      if (!fs.statSync(agDir).isDirectory()) continue;
      for (const sess of fs.readdirSync(agDir)) {
        const sessDir = path.join(agDir, sess);
        if (!fs.statSync(sessDir).isDirectory()) continue;
        for (const f of fs.readdirSync(sessDir)) {
          if (!f.endsWith('.db')) continue;
          await snapshotDb(path.join(sessDir, f), path.join(TMP, 'data', 'v2-sessions', ag, sess, f));
        }
      }
    }
  }

  // Small state files.
  for (const f of ['upgrade-state.json', 'circuit-breaker.json']) {
    const src = path.join(PROJECT_ROOT, 'data', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP, 'data', f));
  }

  // groups/ — agent memory, per-user profiles, reports, specs. Exclude the
  // nested nanoclaw-agents .git (already on GitHub) and container logs.
  execFileSync('rsync', [
    '-a',
    '--delete',
    '--exclude=.git',
    '--exclude=logs/',
    `${path.join(PROJECT_ROOT, 'groups')}/`,
    path.join(TMP, 'groups/'),
  ]);

  // Manifest for restore-time sanity.
  fs.writeFileSync(
    path.join(TMP, 'MANIFEST.json'),
    JSON.stringify(
      {
        created: new Date().toISOString(),
        host: 'aliera',
        source: PROJECT_ROOT,
        dbSnapshots: dbOk,
        dbFailures: dbFail,
        excluded: ['.env', 'data/env/', 'OneCLI vault volumes', 'v1 legacy (data/nanoclaw.db, data/sessions, data/media*)'],
        restoreNote:
          'DB files were taken with the SQLite online backup API and are consistent. Restore data/ + groups/ into a nanoclaw checkout, restore secrets from the encrypted secrets channel, then run setup/service.',
      },
      null,
      2,
    ),
  );

  // Atomic-ish swap: old staging stays intact until the new one is complete.
  fs.rmSync(OLD, { recursive: true, force: true });
  if (fs.existsSync(STAGING)) fs.renameSync(STAGING, OLD);
  fs.renameSync(TMP, STAGING);
  fs.rmSync(OLD, { recursive: true, force: true });

  console.log(
    `${new Date().toISOString()} snapshot OK: ${dbOk} DBs${dbFail ? ` (${dbFail} FAILED)` : ''} -> ${STAGING}`,
  );
  if (dbFail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${new Date().toISOString()} snapshot FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
