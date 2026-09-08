# 02 — Credentials: OneCLI for containers, fork proxy for the sidecar

## Decision (user-confirmed)

- Agent containers: **OneCLI Agent Vault** (upstream v2 default). v2's
  `container-runner.ts` calls `onecli.applyContainerConfig(...)` and **refuses to
  spawn containers if it fails** ("OneCLI gateway not applied — refusing to spawn").
- GPT Researcher sidecar: **keep the fork's OAuth-impersonation proxy** as a
  fork-local standalone service on port 3001 (unchanged, so the sidecar's systemd
  unit keeps working with no edits).

## Part A: OneCLI (cutover-time infrastructure, not worktree code)

Nothing to code in the worktree — v2 main already ships the OneCLI client wiring
(`@onecli-sh/sdk` pinned 2.2.1; needs a gateway exposing the `/v1` API).

At cutover:
1. Install the gateway per upstream docs: `/init-onecli` flow (Docker Compose service
   under `~/.onecli`; see v2 `setup/onecli.ts`, `docs/onecli-upgrades.md`,
   `container/skills/onecli-gateway/SKILL.md`).
2. Configure `ONECLI_URL` / `ONECLI_API_KEY` in `.env` (user edits .env manually or
   confirms values; migration never writes .env).
3. The Anthropic credential (subscription OAuth token) is registered in the OneCLI
   vault so agent containers authenticate; real tokens never enter containers.

**Fallback if OneCLI blocks cutover:** upstream skill `use-native-credential-proxy`
(on v2 main, `.claude/skills/use-native-credential-proxy/`) — threads
`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_BASE_URL`
from `.env` straight into container env, gated by `NANOCLAW_NATIVE_CREDENTIALS=true`.

## Part B: Fork proxy for the GPT Researcher sidecar

**Intent:** the sidecar (GPT Researcher, langchain `ChatAnthropic` client, systemd
user unit with `--network host`, `ANTHROPIC_BASE_URL=http://localhost:3001`,
`x-api-key: placeholder`) must ride the Claude subscription. That requires converting
its requests to OAuth Bearer with claude-cli impersonation — which nothing in v2
provides (OneCLI does header rewriting only; no beta flags / system-prompt injection).

**How to apply:** copy the fork's whole file into the worktree as a fork-local module:

- Copy `src/credential-proxy.ts` from the v1 tree (pre-migration tag) into the
  worktree at `src/credential-proxy.ts`. Copy `src/credential-proxy.test.ts` too.
- v2 has no `startCredentialProxy` call — wire it into v2's host startup
  (`src/index.ts` `main()`, near other service startups):

```ts
import { startCredentialProxy } from './credential-proxy.js';
// Fork: standalone credential proxy for the GPT Researcher sidecar
// (agent containers use OneCLI; this serves third-party host-network clients only).
await startCredentialProxy(parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10));
```

  (Adapt to the actual v2 startup structure and `startCredentialProxy` signature —
  the v1 signature took `(port, host)`. CORRECTED at cutover: bind to the
  docker0 bridge IP via detectProxyBindHost() — the sidecar calls
  http://172.17.0.1:3001, NOT loopback; 127.0.0.1 broke it. ufw restricts the
  port to 172.17.0.0/16. Containers do NOT use this proxy in v2.)

- The file reads env at call time: `CLAUDE_CODE_OAUTH_TOKEN` or
  `ANTHROPIC_AUTH_TOKEN` (OAuth mode), `ANTHROPIC_API_KEY` (api-key mode) via
  `detectAuthMode()`. These live in the live `.env` already.
- Do NOT re-add the v1 `container-runner.ts` wiring that pointed agent containers'
  `ANTHROPIC_BASE_URL` at this proxy — v2 containers go through OneCLI.

**Core third-party logic being preserved** (fork commit 99179ba; the `else if` branch
in the OAuth path of `src/credential-proxy.ts` — for reference, the file copy carries it):

```ts
const PLACEHOLDER_KEY = 'placeholder';
const OAUTH_BETA_FLAGS = 'claude-code-20250219,oauth-2025-04-20';
const OAUTH_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

} else if (headers['x-api-key'] === PLACEHOLDER_KEY && oauthToken) {
  // Third-party client path (e.g. LangChain ChatAnthropic):
  // Convert x-api-key auth to OAuth Bearer auth.
  delete headers['x-api-key'];
  headers['authorization'] = `Bearer ${oauthToken}`;
  // Inject beta flags (append to existing anthropic-beta if present)
  headers['anthropic-beta'] = /* merge */ OAUTH_BETA_FLAGS;
  headers['user-agent'] = 'claude-cli/2.1.81 (external, cli)';
  headers['x-app'] = 'cli';
  // For /v1/messages: unshift {type:'text', text: OAUTH_SYSTEM_PREFIX} onto
  // parsed.system (array/string/absent all handled), rewrite content-length.
}
```

**Validation:** unit tests (`credential-proxy.test.ts`) must pass under v2's vitest
setup; live check at cutover = sidecar research query succeeds (see 04).
