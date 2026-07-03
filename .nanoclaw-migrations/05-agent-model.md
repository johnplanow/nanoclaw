# 05 — Agent model: 'opus' alias via container_configs (no code patch)

**Intent (v1):** the container agent tracks the latest Opus via the SDK's `'opus'`
model alias instead of a pinned model ID. v1 implementation was a hardcode in
`container/agent-runner/src/index.ts` (`model: 'opus'`) + SDK bump to `^0.3.150`.

**v2 reality:** model/effort are per-agent-group DB config (`container_configs`
table, migration 014), materialized to `groups/<folder>/container.json` at spawn and
passed **verbatim** to `sdkQuery({ options: { model } })`. v2 ships
`@anthropic-ai/claude-agent-sdk ^0.3.197` (≥ fork's 0.3.150, so alias resolution is
at least as new). No env var, no code path to patch.

**How to apply:** nothing in the worktree. At/after cutover, once groups are seeded:

```bash
# For each agent group (repeat per group id; list via `ncl groups`):
ncl groups config update --id <group-id> --model opus
ncl groups restart   # config is read at container spawn, not hot-reloaded
```

If a host-level default model setting exists (CHANGELOG 2.0.54 "host-configured
model when unset"), prefer setting the default once instead of per-group — check
v2 docs/config at cutover.

**Do NOT reapply:** the v1 hardcode in agent-runner or the SDK version pin.

**Memory note (from prior sessions):** which Opus the alias resolves to depends on
the bundled SDK/CLI version — after cutover, verify the resolved model in agent logs
and bump the SDK when a newer Opus ships.
