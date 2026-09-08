# Phase 2 — NanoClaw constellation migration to proxmox1 (MERGED RUNBOOK)

**Status: STEP 6 EXECUTED 2026-09-07; soak (step 8) running, step 9 due ~2026-09-14.**
Estate half: `ansible-playbooks/docs/nanoclaw-migration-plan.md` (e03e5bb).
App half + merge: this doc. Architecture approved 2026-08-23: backends →
containers VM 205 (Quadlets); nanoclaw → new VM 206 (4G/2vCPU,
192.168.1.206); **Ollama/qwen stays on aliera**.

## Backend consumer inventory (measured, not guessed)

Sources: grep of all agent specs/scripts + live `docker ps` on aliera.

| Service | Port | Consumed by | Today | After migration |
|---|---|---|---|---|
| Qdrant | 6333 | movie-recs + book-recs agents | `host.docker.internal:6333` | `192.168.1.205:6333` |
| RSSBrew | 8001 | ai-news-daily agent | `host.docker.internal:8001` | `192.168.1.205:8001` |
| Ollama | 11434 | movie-recs + book-recs agents (nomic embeds); RSSBrew (qwen) | `host.docker.internal:11434` | `192.168.1.110:11434` (stays on aliera; already binds 0.0.0.0) |
| RSSHub | 1200 | **RSSBrew only** (compose-internal) — no agent touches it | published 0.0.0.0 | internal on 205 `backends` network; external publish can be dropped |
| redis, browserless | — | news-agg internal only | not published | internal on 205 network |
| OneCLI postgres | 5432 | OneCLI gateway only | `172.17.0.1:5432` | moves WITH nanoclaw to VM 206, internal |
| game-gecko | — | external BGA API only, no local backend | — | repo/venv/crons move to VM 206 (mounts must be host-local) |
| hash-monkey | — | external Weedmaps API only | — | no change |

**ufw scoping on 205:** 6333 + 8001 from 192.168.1.206 (+ aliera .110,
soak-scoped — removed at step 9). **ufw on aliera:** add 11434 from .205
(RSSBrew/qwen) + .206 (agent embeds) — verified 2026-08-23: today's rules
admit ONLY docker-bridge ranges (172.17/172.19), so LAN callers are blocked
until this lands. **Must be in place before step 4's verification** or
ai-news fails with a confusing qwen timeout.

## App-side work items (nanoclaw session)

1. **Pre-cutover complete backup** (gate, step 0): run the 02:45 wrapper
   manually, confirm ship, verify `secrets.tar.sops` in the tarball.
2. **VM 206 app install:** clone fork (`johnplanow/nanoclaw` + nested
   `nanoclaw-agents` at groups/) → restore `data/` + `groups/` from staging
   backup → decrypt `secrets.tar.sops` → `.env`, `data/env/env` → OneCLI
   gateway compose on 206 (restore `onecli-vault.sql`; **set
   `ONECLI_BIND_HOST` to 206's docker-bridge IP — the 1.41 bind gotcha**) →
   `./container/build.sh` → systemd service → crons (02:30 autocommit, 02:45
   backup-snapshot + `~/.config/nanoclaw-backup/hb-url`).
3. **Spec re-pointing** (in `groups/` repo, committed): movie-recs + book-recs
   `6333`/`11434` URLs; ai-news `8001` URL; per the table above.
4. **NO_PROXY fork block** (`src/container-runner.ts`): add
   `192.168.1.205,192.168.1.110` to the exemption list (same Host-rewrite
   failure class that broke RSSBrew 2026-07-04 applies to any proxied LAN hop).
   Commit to fork.
5. **game-gecko move:** clone repo to 206, rebuild `.venv`, copy `.bga/`
   state, install chromium (playwright login), move the 3 crons (corpus 3×/day,
   login 06:00), update mount allowlist + `additional_mounts` paths on 206.
6. **Slack cutover** is automatic (Socket Mode = outbound WebSocket; stop
   aliera service before starting 206's so two hosts never both consume).

## Estate-side work items (ansible session) — summary, details in their doc

205 RAM 4G→6G (+reboot, Kuma maintenance window) · `containers_backends`
Quadlet role (images pinned by digest to what aliera runs, rootless,
`backends` network, ufw-scoped — consumers: .206, .110 soak-scoped, **and
o11y .202 for the Kuma port monitors**) · backend data migration (stop →
rsync: Qdrant ~5.1G volume + RSSBrew `/app/data` only — **redis is ephemeral**
(`--save "" --appendonly no`), nothing to migrate) · **RSSBrew is a local
patched build**, rebuilt on 205 from news-agg ref `a8ee399`
(`containers_backends_newsagg_ref`); base image must ALSO be digest-pinned:
`yinanc/rssbrew@sha256:9aef2bf2e3576482b44b515fccd8322ba0a1702b37ff671737dbeb69cc17f618`
(the Dockerfile's bare `FROM yinanc/rssbrew` would pull today's `latest`,
which may not be the 2025-09-02 layer aliera runs; the patch asserts loudly
on divergence, but digest-pin avoids discovering that mid-migration) · VM 206
via `deploy_app.yml` (Debian 13, docker+node22) · backup re-point (app_vars
target_host → 206; staging path + heartbeats unchanged) · catalog/Kuma for
every new piece. End state 42G/46G — hard stop for new proxmox1 tenants.

## Sequencing

1. Fresh complete backup (gate) → 2. **GPU driver fix + aliera reboot** (early
on purpose: qwen-over-LAN gets tested in its final form, and the reboot
happens while everything still runs on aliera where restart is routine) →
3. 205 RAM bump window; backends up on 205 + data migrated; **aliera ufw
opens 11434 to .205/.206** (blocker for the next step — see inventory note) →
4. **Re-point aliera's nanoclaw to 205 backends and verify agents green**
(validates backends before the VM move risks anything) → 5. VM 206
provisioned → 6. App install/restore on 206 (aliera service STOPPED first) →
7. Acceptance → 8. 1-week soak (aliera services stopped, not removed) →
9. Decommission + catalog/docs final pass (incl. removing the soak-scoped
.110 allowances on 205).

Step 4 is deliberate: it splits "backends moved" from "nanoclaw moved" so a
regression is attributable to one change, and rollback at any point before 6
is just re-pointing URLs.

## Acceptance checklist (step 7)

- [x] (2026-09-07 22:38) Each agent answers in its Slack channel (movie-recs → Qdrant+Ollama;
      ai-news → RSSBrew; game-gecko → BGA fetch; hash-monkey → Weedmaps)
- [x] (2026-09-07 22:38) 👀 indicator + reply delivery work
- [ ] (pending 2026-09-08 05:45) Daily brief fires next 05:45 with feed-health footer clean
- [x] (2026-09-07 22:45, runs 193/191) Turn-watcher fires on schedule from 206
- [x] (2026-09-07) `ncl` works on 206; clidash reinstalled (unit + config)
- [x] (2026-09-07 22:44 live ship nanoclaw_20260907_224403.tar.gz, both dead-men) Backup chain green from 206 (staging heartbeat + 03:15 ship + tarball
      with secrets)
- [x] (2026-09-07 22:38, after the vault-key fix) OneCLI credentialed call succeeds from an agent (gateway bind correct)

## Rollback

Any point ≤ step 5: re-point URLs back to aliera, restart aliera units.
After step 6: stop 206 service, start aliera service (data divergence window
= time since cutover; restore from pre-cutover backup if needed), re-point
specs back. aliera keeps everything stopped-not-removed for the soak week.

## Open items riding along

- clidash: reinstall on 206 (its config points at local `bin/ncl`).
- `hb-nanoclaw-staging` grace stays 2h; no change needed.

(GTX 1060 driver fix was promoted from here into sequencing step 2.)

## Step 6 execution log (2026-09-07 22:14–22:40 MDT)

Pre-cutover gaps found on 206 and fixed: `sops` binary + backup PGP pubkey
missing; `cron` package not installed; system tz was `Etc/UTC` (nanoclaw takes
the install tz from the system — set to `America/Denver`); Playwright chromium
not installed; repo 3 commits behind; clidash unit absent. Base + per-group
images rebuilt on 206 (Fable 5.1 CLI pins).

Cutover: aliera `nanoclaw` + `clidash` disabled+stopped 22:31, agent
containers killed, nanoclaw/game-gecko crons commented out (`#SOAK-2026-09-07`),
final staging snapshot (199 DBs) rsynced to 206 (`data/`, `groups/` minus
`.git`, `game-gecko/.bga`, staging dir). Fixups + crontab applied; 206
service enabled 22:32; Slack Socket Mode connected first try.

Two post-start defects, both fixed:
- `scripts/backup-snapshot.ts` hardcoded `/home/jplanow` → EACCES on 206.
  Fixed (fork 49fe2930, 4a5fcb74: `$HOME` + real hostname in MANIFEST).
- **OneCLI vault: every agent got `401 No credentials configured`.** The
  gateway on 206 had generated its own `/app/data/secret-encryption-key`
  (app-data volume) on 08-24 first boot, so aliera's restored `secrets` rows
  failed to decrypt ("skipping secret: decryption failed"). Fix: stream
  aliera's key into 206's `onecli_app-data` volume (old key kept as
  `secret-encryption-key.206-generated-20260824`), `docker compose restart
  onecli`. **A pg_dump restore is NOT a complete vault restore — the key file
  in the app-data volume must travel with it.** Added to the secrets-restore
  recipe.
- Dead-man ping from 206 timed out: Kuma on o11y gates 3001 via a
  DOCKER-USER allow-list; ansible session added .206 (add4301).

### Day-1 defect (2026-09-08 morning): `.claude-shared` was not restored

The 05:45 brief and the game-gecko turn-watchers failed all night with
`No conversation found with session ID: …`. Cause: per-agent-group Claude
state (`data/v2-sessions/<group>/.claude-shared/` — SDK transcripts,
session-env; mounted at `/home/node/.claude`) was never in the backup
snapshot, so 206 had none; only brand-new threads (fresh conversations)
worked, which is why the cutover-night health checks passed. Fix: rsync'd
all eight dirs from aliera (~56 MB, `--update`), added them to
`scripts/backup-snapshot.ts` (1e106a88), re-fired the brief with
`ncl tasks run`. Secondary defect to fix later: on that resume error the
container hung until the 30-min heartbeat ceiling instead of exiting.

### Day-1 defects, continued (2026-09-08 08:00–08:35)

- `~/game-gecko` on 206 was the 08-24 prep copy, 10 commits behind (no Lost
  Fleet fetch support → Gaia watcher never saw `Active: jplanow`). The
  cutover rsync covered only `.bga/`; the repo itself was never re-synced.
  Fixed by direct push from aliera + hand-merge of the journal the 206 agent
  had already written. 206 got its own read-write deploy key for game-gecko.
- `~/game-gecko/.env` (BGA creds) on 206 was a stale 07-02 copy → 06:00
  login cron hit "Wrong password 1/3". Copied current file; login verified.
- Watcher `.advised` flag was consumed by the failed 07:00 run (see
  `.claude-shared` defect above) → cleared by hand and re-fired.
**Lesson for any future host move: re-sync EVERY working tree the agents
mount (repo + dotfiles the allowlist hides), not just runtime state dirs.**
