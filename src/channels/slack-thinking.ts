/**
 * Fork: 👀 thinking indicator for Slack (docs/CUSTOMIZATIONS.md §1).
 *
 * Slack's Chat SDK `startTyping` only works in assistant threads, so the
 * bridge's `setTyping` is overridden to react to the triggering message
 * instead; the reaction is removed on reply delivery or after a staleness
 * timeout. Needs the `reactions:write` scope.
 *
 * Fork-owned file, deliberately NOT inside `slack.ts`: that file is a
 * channels-branch payload which `/update-nanoclaw` re-copies on every update,
 * wiping anything patched into it. This module re-registers the default
 * `slack` adapter with a decorated factory instead, and talks to the Slack
 * Web API directly because the bridge does not expose its SDK adapter (and
 * has no generic remove-reaction path). Wired by one line in the channel
 * barrel (`import './slack-thinking.js';`, after `./slack.js`). Classic
 * single-bot Slack only — named instances (SLACK_INSTANCES) are not decorated.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { createSlackBridge, SLACK_DEFAULTS } from './slack.js';

const THINKING_EMOJI = 'eyes';
// A stale reaction is removed after this long without a typing refresh.
const THINKING_STALE_MS = 15000;

type ReactionCall = (method: 'add' | 'remove', channel: string, timestamp: string) => Promise<void>;

/** `slack:C0123` (or a `slack:C0123:<ts>` thread id) → `C0123`. */
export function slackChannelId(platformId: string): string | null {
  const parts = platformId.split(':');
  const channel = parts[0] === 'slack' ? parts[1] : parts[0];
  return channel || null;
}

function slackReactionCall(botToken: string): ReactionCall {
  return async (method, channel, timestamp) => {
    const res = await fetch(`https://slack.com/api/reactions.${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ channel, timestamp, name: THINKING_EMOJI }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  };
}

/** Decorate a Slack bridge in place with the reaction-based thinking indicator. */
export function installThinkingIndicator(
  bridge: ChannelAdapter,
  react: ReactionCall,
  staleMs = THINKING_STALE_MS,
): ChannelAdapter {
  // Latest inbound message per chat (message.id is the Slack ts), so setTyping
  // can react to the message that triggered the turn.
  const lastInbound = new Map<string, string>();
  const thinking = new Map<string, { messageId: string; timer: NodeJS.Timeout }>();

  const clearThinking = async (platformId: string): Promise<void> => {
    const entry = thinking.get(platformId);
    if (!entry) return;
    thinking.delete(platformId);
    clearTimeout(entry.timer);
    const channel = slackChannelId(platformId);
    if (!channel) return;
    try {
      await react('remove', channel, entry.messageId);
    } catch (err) {
      // Best-effort — the reaction may already be gone.
      log.debug('Slack thinking-reaction remove failed', { platformId, err });
    }
  };

  const origSetup = bridge.setup.bind(bridge);
  bridge.setup = async (setup: ChannelSetup) => {
    const origOnInbound = setup.onInbound.bind(setup);
    await origSetup({
      ...setup,
      onInbound(platformId: string, threadId: string | null, message: InboundMessage) {
        if (message.id) lastInbound.set(platformId, message.id);
        return origOnInbound(platformId, threadId, message);
      },
    });
  };

  const origSetTyping = bridge.setTyping?.bind(bridge);
  bridge.setTyping = async (platformId, threadId, status, statusKind) => {
    // Agent-DM status lines (assistant threads) keep upstream's behavior.
    if (status !== undefined) return origSetTyping?.(platformId, threadId, status, statusKind);
    const messageId = lastInbound.get(platformId);
    const channel = slackChannelId(platformId);
    if (!messageId || !channel) return;
    const existing = thinking.get(platformId);
    if (existing && existing.messageId === messageId) {
      // Refresh tick for the same message — just renew the staleness timer.
      existing.timer.refresh();
      return;
    }
    // New triggering message: clear any reaction left on the previous one.
    if (existing) await clearThinking(platformId);
    const timer = setTimeout(() => {
      clearThinking(platformId).catch(() => {});
    }, staleMs);
    timer.unref();
    thinking.set(platformId, { messageId, timer });
    try {
      await react('add', channel, messageId);
    } catch (err) {
      // Best-effort — may already be reacted or lack reactions:write.
      log.debug('Slack thinking-reaction add failed', { platformId, err });
    }
  };

  const origDeliver = bridge.deliver.bind(bridge);
  bridge.deliver = async (platformId, threadId, message) => {
    const result = await origDeliver(platformId, threadId, message);
    // Reply delivered — the agent is done thinking for this trigger.
    await clearThinking(platformId);
    return result;
  };

  return bridge;
}

registerChannelAdapter('slack', {
  factory: () => {
    const bridge = createSlackBridge();
    const botToken = readEnvFile(['SLACK_BOT_TOKEN']).SLACK_BOT_TOKEN;
    if (!bridge || !botToken) return bridge;
    return installThinkingIndicator(bridge, slackReactionCall(botToken));
  },
  defaults: SLACK_DEFAULTS,
});
