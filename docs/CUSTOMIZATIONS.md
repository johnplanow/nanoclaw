# Fork Customizations Manifest

This fork (`johnplanow/nanoclaw`) carries local customizations on top of upstream
(`qwibitai/nanoclaw`). This manifest inventories every fork-local change so
upstream updates can be taken with full knowledge of what is ours, why it exists,
and what can be dropped if upstream ships an equivalent.

**Fork baseline (since 2026-07-03 v2 migration):** upstream v2 line, rebased onto
`aecad86` (v2.1.24) via the intent-based `/migrate-nanoclaw` flow — NOT a merge.
The fork is now a handful of commits ahead of upstream/main; same-line merges work
again. The full migration record (decisions, dry-run results, cutover steps) lives
in `.nanoclaw-migrations/`. The pre-migration v1 line is preserved at branch
`backup/pre-migrate-53e91f4-20260703-170313` / tag `pre-migrate-53e91f4-20260703-170313`.

---

## 1. Slack channel (installed from `channels` registry branch)

**Category:** channel install per v2's fetch-and-copy model (`/add-slack`) —
`src/channels/slack.ts` + `slack-registration.test.ts` copied from
`upstream/channels`, barrel import in `src/channels/index.ts`,
`@chat-adapter/slack@4.29.0` pinned.

**Fork-only enhancement (re-ported from v1):**
- **Emoji-reaction "thinking" indicator** — Slack's Chat SDK `startTyping` only
  works in assistant threads, so `slack.ts` overrides the bridge's `setTyping` to
  add an 👀 reaction to the triggering message, removed on reply delivery or
  after a 15s staleness timeout. Needs the `reactions:write` scope (already
  granted on the Slack app). Implementation is the fork block at the bottom of
  `src/channels/slack.ts`; porting notes in `.nanoclaw-migrations/01-slack.md`.

**Dropped from v1 (superseded by v2):** the @slack/bolt implementation and the
explicit `msg.files[]` processing — v2's `chat-sdk-bridge` handles inbound
attachments natively (verified live: image analysis works).

**Update note:** when `upstream/channels` changes `src/channels/slack.ts`, do NOT
blindly re-copy — re-apply the 👀 block after. The fork-sync CI opens an issue on
drift (`.github/workflows/fork-sync-skills.yml`).

## 2. Media: two small patches on v2's native attachment stack

The entire v1 media stack (`src/media.ts`, media refs, `get_media`/`send_media`
MCP tools, `<attachment>` XML, `attachments` DB column) was **dropped** —
superseded by v2's session inbox/outbox + native `send_file` tool. Two gaps ported:

- **Inbound attachment size cap** — `src/channels/chat-sdk-bridge.ts`: v2 has no
  inbound size limit at all (eager unbounded downloads). Fork adds
  `MAX_ATTACHMENT_SIZE` from env `MAX_MEDIA_SIZE` (default 50MB), checked
  pre-download (`att.size`) and post-download (`buffer.length`). Oversized
  attachments keep their metadata entry but carry no data. Marked with
  `// Fork:` comments. **Conflict hotspot** — this file is upstream core.
- **poppler-utils** in `container/Dockerfile` (PDF reading via pdftotext) —
  one line in the apt-get list.

## 3. Credential proxy (sidecar-only standalone service)

`src/credential-proxy.ts` + `src/credential-proxy.test.ts` — fork-local files,
started from `src/index.ts` `main()` step 8 on port 3001 (env
`CREDENTIAL_PROXY_PORT`), bound to 127.0.0.1.

**Purpose:** OAuth-impersonation passthrough so third-party Anthropic clients
(the GPT Researcher sidecar's langchain `ChatAnthropic`) ride the Claude
subscription: converts `x-api-key: placeholder` requests to Bearer auth with
claude-code beta flags, CLI user-agent/x-app headers, and the required
"You are Claude Code" system-prompt prefix.

**NOT in the agent-container path:** v2 agent containers get credentials via the
OneCLI Agent Vault (installed 2026-07-03, gateway at `~/.onecli`, ONECLI_URL in
`.env`, Anthropic secret vaulted). Nothing upstream supersedes the third-party
passthrough — upstream's `use-native-credential-proxy` skill is env-threading
only, and OneCLI does header rewriting without the OAuth impersonation.

## 4. GPT Researcher sidecar (tool install)

- `container/gpt-researcher/Dockerfile` (additive dir) — pre-installs
  `langchain-ollama`/`langchain-anthropic`; patches ChatAnthropic construction to
  strip the `temperature` param (rejected by Opus 4.7+); the patch asserts its
  target line so the image build fails loudly if upstream gpt-researcher changes.
- **External state (not in repo):** docker container `gpt-researcher` (systemd
  user unit) with `--network host`; LLM model IDs pinned in the unit (the `opus`
  alias does not work there); a Node.js WebSocket helper (`research.mjs`) lives
  in the per-session container skill dirs (v2: under `data/v2-sessions/…/.claude-shared/`
  after migration — verify location if the research skill misbehaves).
- Depends on §3's proxy at `http://localhost:3001`.

## 5. Agent model ('opus' alias) — now pure config, no code

v2 stores model/effort per agent group in the `container_configs` DB table and
passes them verbatim to the Agent SDK. All five groups are set to `model=opus`
via `ncl groups config update --id <ag> --model opus`. No code patch; nothing to
re-apply on update. (v1 hardcoded this in agent-runner — dropped.)

## 6. Fork-sync CI workflow (fork infrastructure)

`.github/workflows/fork-sync-skills.yml` — fork-only file, re-enabled
(schedule every 6h + workflow_dispatch) after the v2 migration. v2 rework:
pnpm-based build/test gate on upstream merges; the v1 merge-forward loop over
`origin/skill/*` is replaced by a `channels`-branch drift watch that opens an
issue when upstream changes an installed adapter file (currently
`src/channels/slack.ts`). Old `origin/skill/*` branches are frozen v1 history.

## 7. Misc

- `.gitignore` — fork additions: `_bmad/`, `.claude/skills/bmad-*/` (BMAD tooling
  is local-only, intentionally untracked).
- `.claude/skills/x-integration/` — carried from v1 (dropped upstream in v2).
- `.claude/skills/migrate-nanoclaw/` — upstream's own version (ships on v2 main).
- `.nanoclaw-migrations/` — the migration guide; keep, it documents this manifest's
  provenance and is the replay recipe for the next major migration.
- `docs/CUSTOMIZATIONS.md` — this file.

---

## v2 operational notes (post-migration, 2026-07-03)

- **Services:** existing units kept — `nanoclaw.service` (ExecStart
  `node dist/index.js`, matches v2) and `gpt-researcher`. v2's own setup would
  have created a slugged unit (`nanoclaw-v2-61d30892`); not adopted.
- **Agent image:** `nanoclaw-agent-v2-61d30892:latest` (slug of the project
  root). Rebuild: `./container/build.sh` (prune buildkit builder first —
  `--no-cache` alone does not invalidate COPY).
- **OneCLI:** gateway (docker compose `onecli` + `onecli-postgres-1`) on
  `http://172.17.0.1:10254`; CLI at `~/.local/bin/onecli`; Anthropic subscription
  token vaulted as secret "Anthropic". Upgrades: `docs/onecli-upgrades.md`.
- **Owner:** `slack:U0ANEA7PYEM` (global owner in `user_roles`).
- **Data:** v2 state in `data/v2.db` + `data/v2-sessions/`; v1 data
  (`store/messages.db`, `data/sessions/`, groups CLAUDE.md) left in place
  read-only as rollback, plus `~/nanoclaw-backups/pre-v2-20260703/`.
- **Package manager:** pnpm (corepack), Node ≥ 20; container agent-runner is Bun.
- **Updates:** `/update-nanoclaw` for normal same-line updates; the intent-based
  `/migrate-nanoclaw` + `.nanoclaw-migrations/` guide for the next major.
