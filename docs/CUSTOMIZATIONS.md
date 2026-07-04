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

## 3. NO_PROXY exemption for host-local backends (REINSTATED 2026-07-04)

`src/container-runner.ts` (after the OneCLI apply block, `// Fork:`): injects
`NO_PROXY=host.docker.internal,localhost,127.0.0.1` into agent containers.
Agent groups depend on host-side backends — RSSBrew :8001 (ai-news-daily),
Qdrant :6333 (movie-recs), RSSHub :1200, Ollama :11434 — and through the
OneCLI egress proxy those connections time out or arrive with a rewritten
Host header (RSSBrew's Django ALLOWED_HOSTS then 400s). History: added at v2
cutover for the gpt-researcher sidecar; removed 2026-07-03 with the sidecar
retirement on the mistaken belief it was sidecar-only; broke the daily news
brief the next morning; reinstated with a do-not-remove warning comment.
**Conflict hotspot** — upstream core file. Related external fix: RSSBrew's
`DEPLOYMENT_URL` in `~/code/jplanow/news-agg/docker-compose.yml` now includes
`host.docker.internal,172.17.0.1`.

## 4. RETIRED (2026-07-03): gpt-researcher sidecar + credential proxy

The GPT-Researcher sidecar and everything that existed to serve it were
retired the same day as the pipeline v2 overhaul, after an instrumented
engine A/B (eval q6) showed the sidecar contributed **zero verifiable
sources** — full evidence in
`groups/slack_gpt-researcher/evals/results/2026-07-03-pipeline-v2-initial.md`.
The research core is now the native orchestrator-worker pipeline (no extra
infrastructure).

Removed from code (restorable from git history, pre-retirement tree at tag
`pre-migrate-53e91f4-20260703-170313` + commits through `6c7bc47`):
- `src/credential-proxy.ts` + test + `src/index.ts` startup wiring (the OAuth
  passthrough existed solely for the sidecar's LangChain client)
- `container/gpt-researcher/` (Dockerfile with the temperature-strip patch)

External state left in place, inert:
- systemd user unit `gpt-researcher.service` — stopped + disabled, file kept
  on disk for easy resurrection
- docker image `nanoclaw-gpt-researcher:latest` — still tagged locally
- ufw rules for 3001/8000 from 172.17.0.0/16 — now unused; optional cleanup
- Ollama `nomic-embed-text` model — was only used by the sidecar; Ollama
  itself stays (other consumers)

`src/index.ts` is now **pristine upstream**. (The NO_PROXY block was also
removed here at first, then reinstated next morning — see §3; it was never
sidecar-only.)

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

- **Services:** `nanoclaw.service` kept (ExecStart `node dist/index.js`,
  matches v2; v2's own setup would have created a slugged unit — not adopted).
  `gpt-researcher.service` retired 2026-07-03 (stopped + disabled, see §2b–4).
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
