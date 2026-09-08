# Fork Customizations Manifest

This fork (`johnplanow/nanoclaw`) carries local customizations on top of upstream
(`qwibitai/nanoclaw`). This manifest inventories every fork-local change so
upstream updates can be taken with full knowledge of what is ours, why it exists,
and what can be dropped if upstream ships an equivalent.

**Fork baseline (since 2026-09-08 v2.3.0 upgrade):** upstream `v2.3.0` tag
(`54d9d9a5`) with the fork customizations reapplied on top via the intent-based
`/migrate-nanoclaw` flow — NOT a merge. The full record (reapply order,
breaking-change matrix, runtime steps) lives in
[.nanoclaw-migrations/10-v2.3-upgrade.md](../.nanoclaw-migrations/10-v2.3-upgrade.md);
the previous round (v2.2.0, 2026-08-16) is `08-v2.2-upgrade.md`. Pre-upgrade
v2.2.0 line preserved at branch/tag `pre-migrate-87450cfc-20260908-134332`
(aliera) and tag `pre-migrate-206-3d1a11f5-20260908-134340` (VM 206); full data
snapshot on 206 at `~/nanoclaw-backups/pre-v2.3-20260908-134343/`.
(Earlier: v2.1.24 line at `pre-migrate-bbd91967-20260816-120631`; v1 line at
`backup/pre-migrate-53e91f4-20260703-170313`.)

**Live host is VM 206 (`nanoclaw-vm`)**, not aliera — see §11.

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
  granted on the Slack app). Implementation is the fork block inside
  `createSlackBridge()` in `src/channels/slack.ts` (before the final
  `return Object.assign(bridge, …)`), applied per instance; porting notes in
  `.nanoclaw-migrations/01-slack.md`.

**v2.3.0 note:** the adapter is fetched from `upstream/channels` at commit
`c3f900f4` (2026-08-29), the last commit before the channels branch started
requiring the post-2.3.0 `extractRawText` bridge hook (`slack-raw-text.ts`,
f62ffeb2). When the fork moves past v2.3.0, re-fetch from channels HEAD and
drop this pin. The add-slack apply now brings 10 files (slack-lib,
slack-a2a-guard, provisioning/slack-app, their tests) plus a second barrel
import `./slack-a2a-guard.js`. The v2.3.0 "new Slack experience" (per-agent
provisioned apps) was declined: we stay on classic single-bot Slack
(`/migrate-slack-agents` → stay on classic).

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

**Location since v2.3.0:** `src/gateway-providers/onecli.ts` — the OneCLI
gateway provider's `contribute()` adds `NO_PROXY`/`no_proxy` to its typed
`GatewayContribution.env` (flows into `ContainerSpec.contributedEnv`; passes
spec admission because the value is not credential-shaped). Pre-2.3.0 it sat in
`src/container-runner.ts` after the OneCLI apply block. Value:
`host.docker.internal,localhost,127.0.0.1,192.168.1.205,192.168.1.110`
(.205 = Qdrant/RSSBrew on VM 205, .110 = Ollama on aliera; Phase 2 backends).
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

## 7. Agent-runner: reply enforcement on user-message turns

`container/agent-runner/src/poll-loop.ts` (+ `poll-loop.test.ts`), commit
`ffa20a6` (2026-07-19). Fixes a live incident: an agent repeatedly consumed
user chat messages then ended the turn with an `<internal>`-only result
("nothing further to send"), so the user got silence — happened 4× in one
evening on `slack_book-recs`, each needing a manual `on_wake` nudge. The
existing wrapping-nudge misses this because `stripInternalTags` leaves an empty
scratchpad (`hasUnwrapped` is false).

The patch adds a `batchHasUserChat()` helper (true when a batch has a `chat`/
`chat-sdk` message whose id is not `restart-*`) and threads a `pendingUserReply`
flag through `processQuery`: once a user-chat message enters the turn, the turn
owes a sent `<message>` block. On an `<internal>`-only / zero-sent result it
fires one corrective `<system>` re-prompt (`replyNudged`); a second silent
refusal logs `ERROR`. The exchange-complete `status` is marked `undelivered`
while a reply is still owed, and `archivePrompts` is kept queued across the
nudge so the retry archives against the user prompt, not the nudge text.

**v2.3.0 port (2026-09-08):** re-implemented against the mid-turn-streaming
`processQuery` (params after `emitsMidTurnText`: `initialHasUserChat`,
`idleStreamEndMs`). "Delivered this turn" now also counts DB-visible sends:
`turnDelivered = sent > 0 || maxOutboundSeq() > turnStartSeq`, so an agent that
replied via the MCP `send_message` tool is not nudged. Tests: `poll-loop.test.ts`
› "reply enforcement on user-message turns (fork §7)".

**Re-evaluate on upgrade — do NOT apply as a diff.** The poll-loop file has ~9
upstream commits since our base; `processQuery`'s signature, the exchange-hook
result handling, and the wrapping-nudge block have all likely moved. This patch
must be **re-implemented** against the new structure. Before doing so, check
whether upstream already guarantees a user-facing reply on chat turns (grep the
new poll-loop for reply/nudge/undelivered semantics) — if so, drop this patch.
Distinct from upstream's **one-door task delivery** (that governs *task/
scheduled* sessions requiring an explicit `to`; this governs *interactive*
chat turns owing any reply). Not superseded by it.

## 8. Misc

- `.gitignore` — fork additions: `_bmad/`, `.claude/skills/bmad-*/` (BMAD tooling
  is local-only, intentionally untracked).
- `.claude/skills/x-integration/` — carried from v1 (dropped upstream in v2).
- `.claude/skills/migrate-nanoclaw/` — upstream's own version (ships on v2 main).
- `.nanoclaw-migrations/` — the migration guide; keep, it documents this manifest's
  provenance and is the replay recipe for the next major migration.
- `docs/CUSTOMIZATIONS.md` — this file.
- `scripts/backup-snapshot.ts` — fork-only; the estate backup's consistent
  staging snapshot (DBs via online backup API, `groups/`, `.claude-shared`).
- `tools/clidash/` — installed via upstream `/add-clidash` (the skill ships the
  tool under `.claude/skills/add-clidash/add/`); `clidash.config.json` is local.
- Tavily MCP (`/add-tavily-tool`): `mcp-remote@0.1.38` in `container/cli-tools.json`
  + `src/tavily-manifest.test.ts`; per-group MCP server rows live in the DB.
- Pins: `@anthropic-ai/claude-code` 2.1.251 (`container/cli-tools.json`) and
  `@anthropic-ai/claude-agent-sdk` 0.3.251 exact (`container/agent-runner/
  package.json`) — Fable 5.1; upstream v2.3.0 ships ^0.3.238 / 2.1.238.

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

## 9. Task delivery: origin-thread inheritance + legacy-task visibility (2026-08-24)

Two fork blocks fixing v2.2.0 `ncl tasks` regressions (marked `// Fork:`):
- `src/delivery.ts` (`deliverMessage`): a task-session send to a channel
  destination with no explicit thread inherits the origin session's thread
  (task row `originSessionId` → session → thread_id), same messaging group
  only. Restores thread-scoped watcher delivery (game-gecko turn advice).
- `src/cli/resources/tasks.ts` (`selectedSessions`): group-scoped task
  verbs also scan the group's active chat sessions so legacy session-bound
  tasks stay visible to agents. **Conflict hotspots** — both upstream core.

## 10. Tasks may run inside their origin chat session (2026-09-05)

Fork blocks (marked `// Fork:`) re-exposing the pre-`ncl tasks` shape — a
task row living in the chat session that created it — as an opt-in:
- `src/modules/scheduling/create.ts` (`createScheduledTask`): `sessionId`
  option → `resolveHostSession` (must be active, same group, not a
  `system:tasks:*` session) instead of `resolveTaskSession`.
- `src/cli/resources/tasks.ts`: `tasks create --in-origin-session` (agent →
  own session) / `--session <id>` (host); `append-log` derives the series
  from the task row the chat session is processing (`firedSeriesInSession`).
- `src/delivery.ts`: `task_log` rows from a chat session append to that
  fired row's series log instead of being ignored.
- Docs: `docs/scheduled-tasks.md` "Run a task inside the chat session".

**v2.3.0 port:** host DB access is async and goes through the mailbox seam, so
the "task row most recently fired in this session" query became a fork method
on the seam: `InboundMailbox.latestFiredTaskSeries()` (`src/mailbox/types.ts` +
`src/mailbox/sqlite/index.ts`), used by `firedSeriesInSession` (tasks.ts) and
the `task_log` branch in delivery.ts. Origin-thread inheritance reads the task
row via `mailbox.getTask(series)` and sets `msg.threadId` (camelCase on the
v2.3.0 `OutboundMessage`).

Why: game-gecko's per-game BGA turn-watchers fired in an isolated task
session while the human talked to the thread session — two contexts advising
one game, and on 2026-09-02 they contradicted each other within 80 minutes
(game-gecko repo, `docs/obsession-structural-review-2026-09-03.md` §3.6).
With the watcher inside the thread's session there is one transcript per
game. §9's origin-thread delivery inheritance stays for legacy/isolated
tasks. **Conflict hotspots**: same two upstream files as §9 plus
`create.ts`; tests in `tasks.test.ts` ("tasks inside a chat session") and
`delivery.test.ts` cover the fork.

## 11. Host moved aliera → VM 206 (nanoclaw-vm), 2026-09-07

Phase 2 step 6 executed; runbook + execution log in
`.nanoclaw-migrations/09-vm-migration-runbook.md`. aliera keeps a stopped,
disabled copy for the 1-week soak (step 8); step 9 removes it.

**OneCLI vault restore gotcha (bit us at cutover):** `onecli-vault.sql` alone
is not a restorable vault. The gateway encrypts secret values with a key at
`/app/data/secret-encryption-key` inside the `onecli_app-data` docker volume;
a fresh gateway generates its own on first boot and then every restored secret
fails to decrypt ("skipping secret: decryption failed" → agents get
`401 No credentials configured`). Restore = pg_dump **and** that key file
(same volume also holds the MITM CA at `gateway/ca.{key,pem}`).

## 12. Agent-runner idle lifecycle: clean exit instead of host ceiling kill (2026-09-08)

**Fork block.** `container/agent-runner/src/poll-loop.ts` + `index.ts`.
Upstream keeps the SDK stream open between turns and the outer loop polls
forever; the heartbeat is only touched on stream events (and pre-task
scripts). So every idle chat container went stale and was reaped by
host-sweep's 30-min `ABSOLUTE_CEILING_MS` — logged as
`WARN Killing container past absolute ceiling` + `Container exited non-zero
code=143` (256 times in aliera's log), indistinguishable from a real hang.

Now: with nothing pending, a stream that has produced no provider event for
`idleStreamEndMs` (default 10 min, env `NANOCLAW_IDLE_STREAM_END_MS`) is
`end()`ed (in-flight turns finish first), and a loop with no work for
`idleExitMs` (default 15 min, env `NANOCLAW_IDLE_EXIT_MS`) resolves →
`index.ts` exits 0 → host logs `Container exited` at INFO and respawns on the
next inbound. `0` disables either. The host ceiling stays as the real-hang
safety net. Warm-container benefit (no SDK respawn) is kept for follow-ups
inside 10 min; game-gecko watchers (*/15) may now respawn per tick — that is
the "empty polls cost only a spawn" contract already assumed by turn_poll.sh.
Tests: `poll-loop.test.ts` › "idle lifecycle".

Reapply on upgrade: re-add the two config fields, `lastWorkAt`/`lastEventAt`
tracking, the idle-end branch in the follow-up poller, and the `process.exit(0)`
after `runPollLoop` in `index.ts`.
