# 04 — GPT Researcher sidecar

**Intent:** research sidecar (gptresearcher/gpt-researcher image) that rides the
Claude subscription through the fork credential proxy (02). Repo-tracked part is one
Dockerfile; the rest is external state that the migration must NOT disturb.

## Repo part: `container/gpt-researcher/Dockerfile`

Copy the directory as-is from the v1 tree into the worktree (purely additive; no v2
conflicts). Full file for reference:

```dockerfile
FROM gptresearcher/gpt-researcher:latest

# Pre-install optional LLM/embedding providers.
# Pin to 0.3.x versions compatible with the base image's langchain-core 0.3.41.
RUN pip install --no-cache-dir \
    "langchain-ollama>=0.3,<0.4" \
    "langchain-anthropic>=0.3,<0.4" \
    ollama

# Strip the `temperature` param from every Anthropic call. GPT Researcher always
# sets temperature (default 0.4, gpt_researcher/utils/llm.py), but newer Claude
# models (e.g. Opus 4.7) reject it: 400 "`temperature` is deprecated for this model".
# Patch the single chokepoint where the ChatAnthropic client is built. Build fails
# loudly if upstream changes the line, so this never silently no-ops.
RUN python -c "import pathlib; p=pathlib.Path('/usr/src/app/gpt_researcher/llm_provider/generic/base.py'); s=p.read_text(); old='            llm = ChatAnthropic(**kwargs)'; new='            kwargs.pop(\"temperature\", None)  # Opus 4.7+ reject the temperature param\n'+old; assert old in s, 'anthropic branch not found - upstream base.py changed'; p.write_text(s.replace(old, new, 1)); print('patched: temperature stripped from anthropic provider')"
```

## External state (do not touch during migration; verify at cutover)

- systemd user unit `gpt-researcher` — runs the sidecar with `--network host`; LLM
  model IDs pinned in the unit (the `opus` alias does NOT work there; pin full IDs).
- Node.js WebSocket helper: lives in the untracked per-session container skill dir
  (e.g. `data/sessions/slack_gpt-researcher/.claude/skills/research/research.mjs`),
  NOT in `groups/slack_gpt-researcher/` as older docs said. Connects to
  `ws://host.docker.internal:8000/ws`.
  ⚠️ v2 relocates session state to `data/v2-sessions/<agent_group>/<session>/` —
  after data migration, verify the research skill is still reachable in the new
  session layout for the gpt-researcher group and re-place `research.mjs` if the
  old session dirs aren't carried over.
- Depends on the fork credential proxy at `http://localhost:3001` (02).

## Cutover validation

1. `systemctl --user status gpt-researcher` active.
2. Trigger a research query via the Slack gpt-researcher group; confirm the sidecar
   reaches the proxy (proxy logs show the x-api-key→Bearer conversion) and returns
   a report.
