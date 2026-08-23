# Phase 2 — NanoClaw constellation migration to proxmox1 (MERGED RUNBOOK)

**Status: DRAFT for John's review. Nothing executes until approved.**
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

- [ ] Each agent answers in its Slack channel (movie-recs → Qdrant+Ollama;
      ai-news → RSSBrew; game-gecko → BGA fetch; hash-monkey → Weedmaps)
- [ ] 👀 indicator + reply delivery work
- [ ] Daily brief fires next 05:45 with feed-health footer clean
- [ ] Turn-watcher fires on schedule from 206
- [ ] `ncl` works on 206; clidash re-pointed or reinstalled
- [ ] Backup chain green from 206 (staging heartbeat + 03:15 ship + tarball
      with secrets)
- [ ] OneCLI credentialed call succeeds from an agent (gateway bind correct)

## Rollback

Any point ≤ step 5: re-point URLs back to aliera, restart aliera units.
After step 6: stop 206 service, start aliera service (data divergence window
= time since cutover; restore from pre-cutover backup if needed), re-point
specs back. aliera keeps everything stopped-not-removed for the soak week.

## Open items riding along

- clidash: reinstall on 206 (its config points at local `bin/ncl`).
- `hb-nanoclaw-staging` grace stays 2h; no change needed.

(GTX 1060 driver fix was promoted from here into sequencing step 2.)
