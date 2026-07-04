# NanoClaw Migration Guide (v1 → v2)

Generated: 2026-07-03T16:59:30-06:00
Base: d768a0484355414f7ce7481db5ee237e18a8a1d6 (upstream v1 line, ~1.2.21)
HEAD at generation: 0794acc45e8e9dbf767499b4378d9b6a6ba8d476
Upstream: aecad864e6371cb2a77ceaff8a38f9c4a8b71774 (upstream/main, v2.1.24)

> **MIGRATION COMPLETED 2026-07-03.** Cutover done; fork main now sits on the v2
> line (upstream aecad86 + fork commits). v1 line preserved at
> `backup/pre-migrate-53e91f4-20260703-170313`. Current customization inventory:
> `docs/CUSTOMIZATIONS.md`. This guide is kept as the migration record and as the
> replay recipe for the next major.

Tier 3 migration. Sections live in this directory:

| File | Covers |
|------|--------|
| [01-slack.md](01-slack.md) | Slack reinstall from v2 `channels` branch + 👀 indicator re-port |
| [02-credential-proxy.md](02-credential-proxy.md) | OneCLI adoption + fork proxy for GPT Researcher sidecar |
| [03-media-gaps.md](03-media-gaps.md) | Inbound size cap + poppler-utils (rest of media stack dropped) |
| [04-gpt-researcher.md](04-gpt-researcher.md) | Sidecar Dockerfile + external systemd state |
| [05-agent-model.md](05-agent-model.md) | 'opus' alias via v2 container_configs DB (no code patch) |
| [06-data-migration.md](06-data-migration.md) | v1 → v2 data seeding via upstream migrate driver |
| [07-fork-infra.md](07-fork-infra.md) | fork-sync CI, .gitignore, docs, post-migration steps |

## Decisions (user-confirmed 2026-07-03)

1. **Credentials:** adopt OneCLI Agent Vault for agent containers (upstream default);
   keep fork's `src/credential-proxy.ts` as a fork-local standalone service solely
   for the GPT Researcher sidecar (port 3001, unchanged so the sidecar unit keeps working).
2. **Media:** take upstream v2's native attachment stack wholesale (inbox/outbox,
   `send_file`). Port only: inbound size cap (`MAX_MEDIA_SIZE`-style, 50MB default)
   and `poppler-utils` in `container/Dockerfile`. Drop `src/media.ts`,
   `get_media`/`send_media` MCP tools, media-refs design.
3. **Slack:** reinstall from v2 `channels` registry branch (fetch-and-copy per
   `/add-slack`; NOT a merge). Re-port only the 👀 emoji-reaction thinking indicator.
   Do NOT port `msg.files[]` handling — v2's chat-sdk-bridge handles inbound
   attachments generically; verify with a real file during live test.
4. **Agent model:** no code patch; set `model = 'opus'` per group via v2's
   `container_configs` DB (`ncl groups config update`).
5. **Data:** run upstream's `migrate/v1-to-v2` driver from the upgrade worktree,
   pointed at the live v1 root (reads v1 strictly read-only).

## Migration Plan (order, staging, risks)

**Stage 0 — worktree bring-up.** Worktree at upstream/main (aecad864). `pnpm install`,
`pnpm run build`, `pnpm test` — establish a clean upstream baseline BEFORE any changes.
v2 requires Node ≥ 20, uses pnpm (via corepack), container agent-runner runs on Bun.

**Stage 1 — Slack channel install** (01). Fetch-and-copy from `upstream/channels`,
barrel import, `@chat-adapter/slack@4.29.0` (Chat SDK is pinned exactly 4.29.0 on
current main). Run the slack registration test. Validate build.

**Stage 2 — fork customizations** (02, 03, 04). Credential proxy module + wiring,
media gap patches, gpt-researcher dir copy. Validate build + full test suite.

**Stage 3 — 👀 indicator** (01 §re-port). Needs reading the actual worktree
chat-sdk-bridge/adapter code first; implementation adapts to what the bridge exposes.

**Stage 4 — data seeding** (06). Fetch migrate driver from `upstream/migrate/v1-to-v2`,
run against live v1 root (read-only). Stamp `data/upgrade-state.json` (v2.1.0+ boot
requirement).

**Stage 5 — validation** (build, test, lint) then cutover per plan (OneCLI gateway
install is a cutover prerequisite — containers refuse to spawn without it).

**Risk areas:**
- OneCLI gateway is new external infrastructure (`~/.onecli` Docker Compose,
  `@onecli-sh/sdk` 2.2.1 needs a gateway exposing the `/v1` API). Cutover blocker if
  it fails — mitigation: upstream's `use-native-credential-proxy` skill is the fallback.
- The 👀 indicator port depends on undocumented internals of `@chat-adapter/slack`
  (does the bridge surface the inbound message ts?). May need a small custom shim.
- Data seeding maps v1 `registered_groups`/trigger config → v2 entity model
  (agent_groups, messaging_groups, users/owner, engage_mode). Scheduled tasks are NOT
  migrated (deferred to first-contact recreation) — re-create manually after cutover.
- Systemd: v2 uses slugged unit names (`nanoclaw-<slug>.service`); existing units'
  ExecStart must be checked against v2's start command at cutover.
- v1 rollback: tag created in Phase 2 + runtime-state backup at
  `~/nanoclaw-backups/pre-v2-20260703/`.

## Applied Skills

- **Slack channel** — v1-era install from the old `qwibitai/nanoclaw-slack` repo
  (`slack` remote, merge `4adff40`). In v2 this is NOT re-merged: reinstall via the
  v2 `/add-slack` fetch-and-copy procedure (see 01-slack.md).
- No upstream `skill/*` branches were ever merged into this fork.
- `.claude/skills/migrate-nanoclaw/` — copy into worktree (this skill itself).
- `.claude/skills/get-qodo-rules`, `qodo-pr-resolver`, `x-integration` — present at
  v1 merge base; check whether they still exist on v2 main, copy from main tree if not.
- Local-only untracked skills (BMAD etc.) are gitignored; unaffected by migration.

## Skill Interactions

None. Only one channel skill (Slack) is installed, and the fork's other
customizations are core-file changes inventoried in the sections. The one ordering
constraint: the 👀 indicator patch modifies the freshly copied `src/channels/slack.ts`,
so Slack install (Stage 1) must precede it (Stage 3).

## Dropped in v2 (do NOT reapply)

- `src/media.ts`, `src/media.test.ts`, media-refs storage, `MEDIA_DIR` config,
  `/workspace/media` mount — superseded by v2 session inbox/outbox.
- `get_media` / `send_media` MCP tools in `container/agent-runner/src/ipc-mcp-stdio.ts`
  and their `src/ipc.ts` handlers (`media_download`, `media_message`) — superseded by
  v2's native flow (`send_file` tool + `formatAttachments` inline paths).
- `src/router.ts` `<attachment>` XML emission, `src/db.ts` `attachments` column —
  superseded by v2's content-JSON attachment model.
- v1 Slack `src/channels/slack.ts` (@slack/bolt implementation), `@slack/bolt`
  dependency, `processFiles`/`downloadMedia`/`sendMedia` methods — superseded by
  v2 chat-sdk-bridge + `@chat-adapter/slack`.
- Agent-runner `model: 'opus'` hardcode + SDK pin `^0.3.150` — superseded by v2
  container_configs (v2 ships SDK `^0.3.197`).
- `repo-tokens/badge.svg` local regeneration — take upstream's.
