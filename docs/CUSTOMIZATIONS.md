# Fork Customizations Manifest

This fork (`johnplanow/nanoclaw`) carries local customizations on top of upstream
(`qwibitai/nanoclaw`). This manifest inventories every fork-local change per the
upstream extension-architecture guarantees (additive, documented, reversible —
see <https://docs.nanoclaw.dev/extend/overview>), so upstream updates can be merged
with full knowledge of what is ours, why it exists, and what can be dropped if
upstream ships an equivalent.

**Fork baseline at last audit (2026-07-03):** merge base `d768a04` (upstream v1
line, ~1.2.21). Upstream `main` is now on the **v2 line (2.1.24)**, ~1,555 commits
ahead, with a new extension architecture: registry branches (`channels`,
`providers`), per-channel registration tests, REMOVE.md reversibility, and a
`skills` column in container config. Upstream also ships `migrate/v1-to-v2` and a
`skill/migrate-nanoclaw` branch — use those (via `/update-nanoclaw`) when taking
the update.

---

## 1. Slack channel (channel install)

**Category:** channel install. Origin: `qwibitai/nanoclaw-slack` (merged from the
`slack` remote — predates the fetch-and-copy registry pattern).

- `src/channels/slack.ts` — self-registering Socket Mode channel module
- `src/channels/slack.test.ts` — tests (56)
- `src/channels/index.ts` — barrel import line `import './slack.js';`
- `.env.example` — `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`
- `package.json` — dependency `@slack/bolt ^4.6.0`
- `.claude/skills/add-slack/SKILL.md` — modified: added `reactions:write` OAuth scope

**Fork-only enhancements (not in nanoclaw-slack):**
- **Attachment support** — handles `msg.files[]` for images, text, PDFs, code
  snippets; lazy download; text-inline fast path for small text files (commit `99179ba`)
- **Emoji-reaction "thinking" indicator** — Slack has no bot typing API, so
  `setTyping` adds/removes an 👀 reaction on the triggering message; requires the
  `reactions:write` scope (commit `795dc02`)

**Removal:** delete `slack.ts`/`slack.test.ts`, drop the barrel import line, remove
`@slack/bolt`, remove the two env vars.

**v2 conflict notes:** upstream's `channels` registry branch ships its own
`src/channels/slack.ts` + `slack-registration.test.ts` on a new adapter API
(`adapter.ts`, `channel-registry.ts` replace v1 `registry.ts`). Expect to
**reinstall Slack from the v2 registry branch** and re-port the two fork
enhancements (attachments may be covered by v2's native attachment support —
verify before porting).

## 2. Media infrastructure (cross-cutting core change)

Per-group media handling for channel attachments (commit `99179ba`).

New files (additive):
- `src/media.ts` — MIME helpers, media-ref storage, `processInboundMedia()`, path-traversal guards
- `src/media.test.ts`, `src/formatting.test.ts` (attachment formatting coverage)
- `container/agent-runner/src/ipc-mcp-stdio.ts` — `get_media`/`send_media` MCP tools (stdio server)

Modified core files (**merge-conflict hotspots**):
- `src/db.ts` — schema migration adding `attachments` column
- `src/router.ts` — emits `<attachment>` XML elements
- `src/ipc.ts` — `get_media`/`send_media` task processing
- `src/index.ts` — media wiring
- `src/config.ts` — `MEDIA_DIR`, `MAX_MEDIA_SIZE` (env `MAX_MEDIA_SIZE`, default 50MB)
- `src/container-runner.ts` — mounts `/workspace/media` per group
- `src/types.ts` — attachment types
- `container/Dockerfile` — adds `poppler-utils` for PDF reading

**Removal:** revert the modified-file hunks of `99179ba`; delete the new files;
drop the `attachments` column (or leave it — additive schema).

**v2 conflict notes:** upstream v2 has native attachment infrastructure
(`src/attachment-naming.ts`, `src/attachment-safety.ts`) and `src/db` is now a
directory. **Prefer upstream's implementation** during the update; carry over only
gaps (e.g. `send_media` outbound flow) after comparing.

## 3. Credential proxy OAuth passthrough

`src/credential-proxy.ts` + `src/credential-proxy.test.ts` (commit `99179ba`): in
OAuth mode, converts third-party `x-api-key: placeholder` requests to Bearer auth
with `claude-code` beta flags and system-prompt injection, so any Anthropic API
client (e.g. GPT Researcher's langchain) rides the Claude subscription.

**v2 conflict notes:** upstream has a `skill/native-credential-proxy` branch —
compare during the update; ours may be superseded.

## 4. GPT Researcher sidecar (tool install)

Commits `99179ba`, `c285213`.

- `container/gpt-researcher/Dockerfile` (additive dir) — pre-installs
  `langchain-ollama`/`langchain-anthropic`; patches ChatAnthropic construction to
  strip the `temperature` param (rejected by Opus 4.7+ with a 400); the patch
  asserts its target line so the image build fails loudly if upstream
  gpt-researcher changes.
- **External state (not in repo):** systemd user unit running the sidecar with
  `--network host`; LLM model IDs are pinned in the unit (the `opus` alias does
  not work there); a Node.js WebSocket helper lives in the untracked
  `groups/slack_gpt-researcher/` group folder.

## 5. Agent model tracking (`opus` alias)

Commit `c25a818`:
- `container/agent-runner/src/index.ts` — model set to the `opus` alias
- `container/agent-runner/package.json` — `@anthropic-ai/claude-agent-sdk ^0.3.150`
  (the bundled CLI version determines which Opus the alias resolves to)

## 6. Fork-sync CI workflow (fork infrastructure)

`.github/workflows/fork-sync-skills.yml` — fork-only file. Originally auto-merged
`upstream/main` every 6 h and merged main forward into `origin/skill/*` branches.
**Gated to `workflow_dispatch` only (2026-07-03)** so the v1→v2 update can't happen
unsupervised; re-enable triggers after the fork is on v2 (and re-point the
skill-branch logic at the v2 registry-branch model).

## 7. Misc

- `.gitignore` — fork additions: `.nanoclaw/`, `agents-sdk-docs`, `_bmad/`,
  `.claude/skills/bmad-*/` (BMAD tooling is local-only, intentionally untracked)
- `.claude/skills/get-qodo-rules`, `qodo-pr-resolver`, `x-integration` — tracked at
  merge base (upstream v1); not fork-local
- `repo-tokens/badge.svg` — regenerated locally; noise, take upstream's on conflict

---

## Update-readiness checklist (verified 2026-07-03)

- Working tree clean, `main` == `origin/main`
- `upstream` remote → `qwibitai/nanoclaw` (fetched + pruned)
- Build green, 309 tests green, lint 0 errors (90 warnings, matching upstream baseline)
- package.json regressions from the old `slack/main` merge repaired (version,
  lint scripts, eslint devDeps)
- Auto-merge CI disabled (manual dispatch only)

**Taking the update:** run `/update-nanoclaw`. It is a v1→v2 major: expect the
merge path to be heavy; upstream's `skill/migrate-nanoclaw` / `migrate/v1-to-v2`
are the intended route. Decide per section above what to drop (superseded by v2)
vs re-port.
