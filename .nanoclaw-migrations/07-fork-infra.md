# 07 — Fork infrastructure & post-migration steps

## .gitignore fork additions

Re-add to the worktree's `.gitignore` (only these two lines are actually fork-local;
`.nanoclaw/` and `agents-sdk-docs` were already upstream at the v1 base):

```
_bmad/
.claude/skills/bmad-*/
```

(BMAD tooling is local-only, intentionally untracked.)

## Skills to carry into the worktree

- `.claude/skills/migrate-nanoclaw/` — this skill (copied from upstream branch).
- `docs/CUSTOMIZATIONS.md` — carry forward, then rewrite post-migration (below).
- Check on v2 main first, copy from v1 tree only if absent:
  `.claude/skills/get-qodo-rules/`, `.claude/skills/qodo-pr-resolver/`,
  `.claude/skills/x-integration/` (these were upstream-v1 content, may have been
  dropped in v2).

## Fork-sync CI (`.github/workflows/fork-sync-skills.yml`)

Fork-only file; carry into the worktree, but keep it **workflow_dispatch-only until
after cutover is confirmed**. Current logic: guard `github.repository !=
'qwibitai/nanoclaw'`; GitHub App token; merge upstream/main → main with
build+test gate; then merge main forward into each `origin/skill/*` branch with the
same gate; failure reporting via issues (labels upstream-sync / skill-maintenance);
concurrency group fork-sync.

**Post-migration rework (user step 6):**
1. Re-enable the schedule + push triggers (restore what commit 9f69ed3 removed).
2. Update for v2 conventions: `npm ci && npm run build && npm test` →
   `pnpm install --frozen-lockfile && pnpm run build && pnpm test`; Node ≥ 20 setup.
3. Re-point the skill-branch logic: the fork no longer has `origin/skill/*` content
   branches in the v1 sense. In v2, installed channel/provider code is plain files
   copied from upstream registry branches — the forward-merge loop over
   `origin/skill/*` is obsolete. Either drop that step, or repurpose it to watch
   `upstream/channels` for changes to `src/channels/slack.ts` and open an issue
   suggesting a re-run of `/add-slack` (fetch-and-copy refresh) when it drifts.

## docs/CUSTOMIZATIONS.md rewrite (post-migration)

Update to reflect the v2 state:
- **Dropped (superseded by v2):** media stack (v2 inbox/outbox + send_file), v1
  Slack bolt implementation + explicit files[] handling (v2 chat-sdk-bridge),
  agent-runner model hardcode (v2 container_configs), v1 credential-proxy
  container wiring (v2 OneCLI).
- **Re-ported:** 👀 setTyping override in v2 slack.ts; inbound size cap in
  chat-sdk-bridge; poppler-utils in container/Dockerfile; credential-proxy.ts as
  sidecar-only standalone service; gpt-researcher sidecar dir.
- **New fork infra:** OneCLI gateway (external), upgrade-state marker, v2 data
  layout; corrected external-state note (research.mjs lives under session skill
  dirs, not the group folder).
- Fix known v1 doc inaccuracies (gitignore over-claim, research.mjs location,
  "text-inline fast path" overstatement).

## Cutover checklist deltas vs the skill's generic flow (Linux/systemd install)

- Service management is systemd user units (`systemctl --user`), NOT launchctl:
  `nanoclaw.service` and `gpt-researcher.service` are both active and in daily use.
  **Ask the user before stopping either.**
- v2 generates slugged unit names (`nanoclaw-<slug>.service`); we keep our existing
  unit but must verify its ExecStart matches v2's start command (pnpm/node
  entrypoint may have changed) and that WorkingDirectory still applies.
- Container rebuild: prune the buildkit builder first — `--no-cache` alone does NOT
  invalidate COPY steps (project CLAUDE.md warning). v2 builds per-agent-group
  images (image_tag in container_configs) — use v2's build path
  (`./container/build.sh` equivalent on v2 main; verify script name).
- OneCLI gateway install happens at cutover, before starting v2 (02).
- Recreate scheduled tasks from the pre-cutover inventory (06).
- Slack live test: message a Slack group; verify 👀 appears/disappears, attachments
  land in inbox, replies deliver.
- Sidecar test: research query through the gpt-researcher group (04).
