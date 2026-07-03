# 06 — Data migration: seed v2 DB from v1 runtime state

**Why:** v2 does not read v1's `store/messages.db` / `registered_groups`. New model:
central `data/v2.db` (agent_groups, messaging_groups, users, user_roles,
messaging_group_agents, container_configs) + per-session DB pairs under
`data/v2-sessions/<agent_group>/<session>/`.

**Route (updated 2026-07-03 during upgrade):** v2.1.24 main ships the migration
driver in-tree — `migrate-v2.sh` + `setup/migrate-v2/*.ts` (newer than the
`migrate/v1-to-v2` branch this guide originally referenced). The bash wrapper
needs a TTY, but the individual step scripts are headless, idempotent, and
strictly read-only on the v1 tree. Run them directly:

```bash
V1=/home/jplanow/code/jplanow/nanoclaw   # the v1 root
pnpm exec tsx setup/migrate-v2/env.ts      "$V1"   # v1 .env keys → v2 .env (append-only)
pnpm exec tsx setup/migrate-v2/db.ts       "$V1"   # registered_groups → agent/messaging groups + wiring
pnpm exec tsx setup/migrate-v2/groups.ts   "$V1"   # groups/* → CLAUDE.local.md + files (no overwrite)
pnpm exec tsx setup/migrate-v2/sessions.ts "$V1"   # sessions + .claude history + continuation ids
pnpm exec tsx setup/migrate-v2/tasks.ts    "$V1"   # active scheduled_tasks → v2 task messages
pnpm exec tsx setup/migrate-v2/channel-auth.ts "$V1" slack  # slack env keys
```

Order matters: `db.ts` must precede `sessions.ts`/`tasks.ts`. All write into the
CURRENT working directory's `data/`, `groups/`, `.env`.

**Owner/user seeding is NOT done by these scripts** — the `/migrate-from-v1`
skill (on v2 main) handles users/user_roles after cutover. Run it (or seed the
owner via `ncl users create` + `ncl roles grant`) before expecting admin commands
to work.

## Dry-run results (worktree, 2026-07-03)

All steps ran clean against the live v1 root:
- env: 3 keys copied (CLAUDE_CODE_OAUTH_TOKEN, SLACK_APP_TOKEN, SLACK_BOT_TOKEN)
- db: 5/5 registered_groups → 5 agent_groups + 5 messaging_groups, engage_mode
  `pattern` / `.` (faithful to v1 requires_trigger=0 = respond-to-all)
- groups: 7 folders, 6 CLAUDE.md → CLAUDE.local.md, 201 files
- sessions: 5 sessions created, 282 files (incl. Claude Code JSONL continuation ids)
- tasks: 1/1 active task migrated (ai-news-daily cron `45 5 * * *`)
- channel-auth slack: env keys already present; `SLACK_SIGNING_SECRET` flagged
  missing — NOT needed (Socket Mode via SLACK_APP_TOKEN)

## At cutover (authoritative run)

Re-run the same steps in the LIVE tree after the code swap, with `V1=.`
(the live tree holds both the v1 data and the v2 code at that point; every step
is no-overwrite/reuse-existing, verified in the dry run). This picks up any
messages/state that arrived after the dry run. Then:

1. Stamp the upgrade marker (v2.1.0+ boot requirement; the tripwire refuses to
   start otherwise): `pnpm exec tsx scripts/upgrade-state.ts set` (verify exact
   CLI usage in that script first).
2. Run `/migrate-from-v1` for owner/user seeding + CLAUDE.local.md review.
3. Recreate/verify the migrated scheduled task fires (check
   `data/v2-sessions/.../inbound.db` messages_in kind='task').

## Data-safety invariants

- v1 `store/`, `data/sessions/`, `groups/`, `.env` are READ-ONLY inputs
  (verified in script source: no writes to the v1 path anywhere).
- v2 state lands in `data/v2.db`, `data/v2-sessions/`, `groups/<f>/CLAUDE.local.md`.
  v1 files stay in place as rollback.
- Rollback for the data layer: `~/nanoclaw-backups/pre-v2-20260703/`
  (runtime-state.tar.gz + messages.db snapshot + both systemd units).
