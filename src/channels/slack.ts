/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Socket Mode opt-in: set SLACK_APP_TOKEN (xapp-…) to receive events over an
 * outbound WebSocket instead of an inbound HTTPS webhook.
 *
 * Fork customization: emoji-reaction "thinking" indicator. Slack has no bot
 * typing API for regular channel messages (the Chat SDK's startTyping only
 * works in assistant threads), so setTyping adds an 👀 reaction to the
 * triggering message instead; the reaction is removed when the reply is
 * delivered, or after a staleness timeout once typing refreshes stop.
 * Requires the reactions:write OAuth scope.
 * See .nanoclaw-migrations/01-slack.md.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

const THINKING_EMOJI = ':eyes:';
// The typing module refreshes every 4s while the agent works; if no refresh
// arrives for this long and nothing was delivered, drop the reaction.
const THINKING_STALE_MS = 15000;

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN']);
    if (!env.SLACK_BOT_TOKEN) return null;
    // SLACK_APP_TOKEN (xapp-…) enables Socket Mode: events arrive over an
    // outbound WebSocket, so no public HTTPS endpoint is required. When set,
    // the signing secret is optional (Slack signs socket frames separately).
    const useSocketMode = Boolean(env.SLACK_APP_TOKEN);
    const slackAdapter = createSlackAdapter({
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
      appToken: env.SLACK_APP_TOKEN,
      mode: useSocketMode ? 'socket' : 'webhook',
    });
    const bridge = createChatSdkBridge({ adapter: slackAdapter, concurrency: 'concurrent', supportsThreads: true });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };

    // Fork: 👀 thinking indicator.
    // Track the latest inbound message per chat (message.id is the Slack ts)
    // so setTyping can react to the triggering message.
    const lastInbound = new Map<string, { tid: string; messageId: string }>();
    const thinking = new Map<string, { tid: string; messageId: string; timer: NodeJS.Timeout }>();

    const clearThinking = async (platformId: string): Promise<void> => {
      const entry = thinking.get(platformId);
      if (!entry) return;
      thinking.delete(platformId);
      clearTimeout(entry.timer);
      try {
        await slackAdapter.removeReaction(entry.tid, entry.messageId, THINKING_EMOJI);
      } catch (err) {
        // Best-effort — the reaction may already be gone.
        log.debug('Slack thinking-reaction remove failed', { platformId, err });
      }
    };

    const origSetup = bridge.setup.bind(bridge);
    bridge.setup = async (setup) => {
      const origOnInbound = setup.onInbound;
      await origSetup({
        ...setup,
        onInbound(platformId, threadId, message) {
          if (message.id) {
            lastInbound.set(platformId, { tid: threadId ?? platformId, messageId: message.id });
          }
          origOnInbound(platformId, threadId, message);
        },
      });
    };

    bridge.setTyping = async (platformId, threadId) => {
      void threadId;
      const last = lastInbound.get(platformId);
      if (!last) return;
      const existing = thinking.get(platformId);
      if (existing && existing.messageId === last.messageId) {
        // Refresh tick for the same message — just renew the staleness timer.
        existing.timer.refresh();
        return;
      }
      // New triggering message: clear any reaction left on the previous one.
      if (existing) await clearThinking(platformId);
      const timer = setTimeout(() => {
        clearThinking(platformId).catch(() => {});
      }, THINKING_STALE_MS);
      timer.unref();
      thinking.set(platformId, { ...last, timer });
      try {
        await slackAdapter.addReaction(last.tid, last.messageId, THINKING_EMOJI);
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
  },
});
