# 01 — Slack channel: v2 install + 👀 indicator re-port

## Part A: Install Slack from the v2 `channels` registry branch

**Intent:** Slack as a channel over Socket Mode, as before, but on v2's adapter API.

**Procedure** (per upstream `/add-slack` SKILL.md — fetch-and-copy, NEVER a merge).
In the worktree, with `upstream` as the remote (upstream docs say `origin`):

```bash
git fetch upstream channels
git show upstream/channels:src/channels/slack.ts > src/channels/slack.ts
git show upstream/channels:src/channels/slack-registration.test.ts > src/channels/slack-registration.test.ts
```

Then:
1. Append `import './slack.js';` to `src/channels/index.ts` (self-registration barrel).
2. `pnpm install @chat-adapter/slack@4.29.0` (pinned exact — Chat SDK is pinned 4.29.0 on main).
3. `pnpm run build && pnpm exec vitest run src/channels/slack-registration.test.ts`.

**Credentials** (already in live `.env`, never touched): `SLACK_BOT_TOKEN` (xoxb-),
`SLACK_APP_TOKEN` (xapp- — presence of this enables Socket Mode in the v2 factory).
`SLACK_SIGNING_SECRET` only needed for webhook mode — not used.

**OAuth scopes** the v2 skill expects (fork's app already has all of these including
`reactions:write`, added by fork commit 795d c02's SKILL.md edit): chat:write, im:write,
channels:history, groups:history, im:history, channels:read, groups:read, users:read,
reactions:write, files:read, files:write.

## Part B: Inbound attachments — verify, do not port

v1 fork had explicit `msg.files[]` processing (lazy media refs). v2's
`chat-sdk-bridge.ts` `messageToInbound()` downloads every attachment with
`fetchData()` eagerly and inlines base64; `session-manager.ts` writes it to
`inbox/<messageId>/` and the agent gets `[image: name — saved to /workspace/inbox/…]`
in its prompt. The Slack→attachments mapping lives inside the external
`@chat-adapter/slack` package.

**Action:** during live test, post an image and a PDF to a Slack group and confirm
the agent sees the inbox paths. Only if this fails, port fork logic (reference
implementation in fork tag, `src/channels/slack.ts` `processFiles`/`downloadMedia`).

## Part C: Re-port the 👀 emoji-reaction "thinking" indicator

**Intent:** Slack has no bot typing API. When the agent starts processing, add an 👀
(`eyes`) reaction to the triggering message; remove it when done. Requires
`reactions:write` (already granted).

**v1 reference implementation** (fork `src/channels/slack.ts`, commit 795dc02):

```ts
// Track the latest inbound (non-bot) message ts per channel so
// setTyping can add/remove a reaction as a "thinking" indicator.
private lastInboundTs = new Map<string, string>();
// ... on every non-bot inbound message:
if (!isBotMessage) {
  this.lastInboundTs.set(jid, msg.ts);
}

private static readonly THINKING_EMOJI = 'eyes';

async setTyping(jid: string, isTyping: boolean): Promise<void> {
  const channelId = jid.replace(/^slack:/, '');
  const messageTs = this.lastInboundTs.get(jid);
  if (!messageTs) return;
  try {
    if (isTyping) {
      await this.app.client.reactions.add({
        channel: channelId, timestamp: messageTs, name: SlackChannel.THINKING_EMOJI });
    } else {
      await this.app.client.reactions.remove({
        channel: channelId, timestamp: messageTs, name: SlackChannel.THINKING_EMOJI });
    }
  } catch (err) {
    // Silently ignore — reaction may already exist or be already removed
    logger.debug({ jid, isTyping, err }, 'Slack reaction indicator failed');
  }
}
```

**v2 adaptation strategy.** v2's `slack.ts` is a thin factory returning a
`createChatSdkBridge(...)` bridge whose `setTyping(platformId, threadId)` calls the
Chat SDK adapter's `startTyping` (no real Slack signal). The factory already
demonstrates the override pattern (it overrides `bridge.resolveChannelName`). Plan:

1. Read worktree `src/channels/chat-sdk-bridge.ts` + `adapter.ts` to find where the
   inbound message's platform ts/messageId is available (the `ChannelSetup.onInbound`
   callback and/or serialized `InboundMessage.content`).
2. In `slack.ts`'s factory, after `createChatSdkBridge(...)`:
   - Wrap `bridge.setup` to intercept `onInbound` and record
     `platformId → last inbound message ts` in a module-level Map (skip bot/self messages).
   - Override `bridge.setTyping = async (platformId, threadId) => { reactions.add('eyes') }`.
   - v2's setTyping signature has no `isTyping=false` call — check how/whether the host
     signals completion (look at callers of `setTyping` in v2 src/). If v2 only ever
     signals start, remove the reaction when the outbound reply is delivered instead
     (wrap `bridge.deliver`).
3. Slack Web API access for reactions: `@chat-adapter/slack`'s adapter may expose its
   web client; if not, `new WebClient(env.SLACK_BOT_TOKEN)` from `@slack/web-api`
   (already in the dependency tree via @chat-adapter/slack).
4. Reaction name is `eyes`; add/remove errors are non-fatal (debug-log only).

**Files:** `src/channels/slack.ts` (worktree copy) only. Keep the patch small and
clearly commented as a fork customization.
