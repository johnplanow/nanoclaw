# 06 — Data migration: seed v2 DB from v1 runtime state

**Why:** v2 does not read v1's `store/messages.db` / `registered_groups`. New model:
central `data/v2.db` (agent_groups, messaging_groups, users, user_roles,
messaging_group_agents, container_configs) + per-session DB pairs under
`data/v2-sessions/<agent_group>/<session>/` (inbound.db host-written, outbound.db
container-written). v2.1.0+ also refuses to boot without `data/upgrade-state.json`.

**Decision (user-confirmed):** run upstream's migrate driver from the upgrade
worktree pointed at the live v1 root — NOT the sibling-clone bash flow. The driver
reads the v1 tree strictly read-only.

## Procedure (in the worktree, Stage 4)

1. Fetch the driver from the `migrate/v1-to-v2` branch (fetch-and-copy, same spirit
   as registry branches — do not merge the branch):

```bash
git fetch upstream migrate/v1-to-v2
for f in setup/migrate.ts setup/migrate/detect-v1.ts setup/migrate/extract-v1.ts \
         setup/migrate/guide-compose.ts setup/migrate/jid.ts \
         setup/migrate/owner-propose.ts setup/migrate/seed-v2.ts; do
  git show upstream/migrate/v1-to-v2:$f > $f
done
# plus the package.json script entry "migrate:v1-to-v2" (add manually, one line)
```

   Note: the branch's merge base with main is older (d2f5304) — if the driver files
   assume APIs that moved by 2.1.24, reconcile minimally and flag anything unclear.

2. Run it (worktree = v2 root, live tree = v1 root):

```bash
cd "$WORKTREE" && pnpm run migrate:v1-to-v2 -- --v1-root /home/jplanow/code/jplanow/nanoclaw
```

   What it does: extracts `store/messages.db`, non-secret `.env` keys, and
   `~/.config/nanoclaw/*` into `.nanoclaw-migrations/v1-data/*.json`; seeds v2 DB —
   `registered_groups.folder` → `agent_groups` (deduped), `jid` → `messaging_groups`,
   `trigger_pattern`/`requires_trigger` → `engage_mode`/`engage_pattern`; infers or
   prompts for an owner → `users`/`user_roles(owner)`; copies `CLAUDE.md` →
   `CLAUDE.local.md` per group. **Scheduled tasks are NOT migrated** — list them
   from v1 before cutover (`sqlite3 store/messages.db 'select * from scheduled_tasks'`)
   and recreate after.

3. Interactive prompts (owner inference) — surface to the user, don't guess.

4. Stamp the upgrade marker so v2 boots:
```bash
cd "$WORKTREE" && pnpm exec tsx scripts/upgrade-state.ts set   # check exact usage on v2 main
```

## Data-safety invariants

- v1 `store/`, `data/`, `groups/`, `.env` are READ-ONLY inputs throughout.
- The seeded v2 data lands under the WORKTREE's `data/` while validating. At cutover
  (worktree → main swap), the seeded `data/v2.db`, `data/v2-sessions/`, and
  `data/upgrade-state.json` must be carried into the live tree's `data/` (additive —
  v1 files in `data/` stay as rollback).
  ⚠️ The swap step (`git reset --hard` + worktree remove) only moves git-tracked
  code — copy the seeded data explicitly before removing the worktree.
- Rollback for the data layer: `~/nanoclaw-backups/pre-v2-20260703/`
  (runtime-state.tar.gz + messages.db snapshot + both systemd units).

## Groups inventory at migration time

Enumerate v1 groups just before seeding (`sqlite3 store/messages.db
'select jid, folder, trigger_pattern, requires_trigger from registered_groups'`)
and diff against seeded v2 `messaging_groups`/`agent_groups` afterwards — every v1
group must be accounted for (including `slack_gpt-researcher`).
