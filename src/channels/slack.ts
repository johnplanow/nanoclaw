/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Socket Mode opt-in: set SLACK_APP_TOKEN (xapp-…) to receive events over an
 * outbound WebSocket instead of an inbound HTTPS webhook.
 *
 * Additional bot identities in the same workspace: set
 * SLACK_INSTANCES=<name>[,<name>…] plus a per-instance token set
 * (SLACK_BOT_TOKEN_<NAME> / SLACK_APP_TOKEN_<NAME> /
 * SLACK_SIGNING_SECRET_<NAME>; name uppercased, dashes → underscores). Each
 * name registers under the `slack-<name>` instance key through the same
 * createSlackBridge factory as the default app — no mirrored construction.
 * channelType stays 'slack' either way, so user ids, formatting, container
 * config, and the wiring-defaults declaration are shared across instances.
 */
import { createSlackAdapter, type SlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelContextDefaults, ChannelDefaults, ChannelSetup, InboundMessage } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// Fork: 👀 thinking indicator (docs/CUSTOMIZATIONS.md §1). Slack's Chat SDK
// startTyping only works in assistant threads, so setTyping is overridden to
// react to the triggering message instead. Needs the reactions:write scope.
const THINKING_EMOJI = ':eyes:';
// A stale reaction is removed after this long without a typing refresh.
const THINKING_STALE_MS = 15000;

/**
 * Dedicated bot app on a threaded platform. group threads:true keeps
 * mention-sticky bounded — engagement sticks per-thread, not forever.
 * dm.threads:false is a deliberate policy choice, not a capability limit:
 * Slack users can open sub-threads inside a DM, but by default the agent
 * replies top-level and all DM sub-threads collapse into the one DM session.
 * This declaration owns that judgment (it used to be hardcoded router
 * behavior); operators who want in-thread DM replies override per wiring
 * with `--threads true`.
 *
 * Agent-DM anchors (the settled Slack DM shape) — creation-time stamps, so
 * they apply to wirings/rows created from this declaration onward and never
 * flip existing installs:
 * - dm.sessionMode 'per-thread': Slack's agent-mode DM surface materializes
 *   a thread per conversation, so a new DM wiring roots a session per thread.
 *   resolveWiringDefaults derives the threads=1 stamp from this at creation
 *   (per-thread sessions structurally require honored thread ids — no
 *   separate field to declare). The live inherit value dm.threads stays
 *   false, so wirings created earlier (threads column NULL) keep collapsing
 *   DM sub-threads into the one DM session.
 * - dm.unknownSenderPolicy 'decline_notify': an unknown DM sender gets a
 *   polite decline and the owner a one-line FYI — no approval card; access
 *   grants stay explicit (`ncl members add`). A deliberate, reviewed default
 *   change for Slack DM rows auto-created after this lands.
 */
export const SLACK_DEFAULTS: ChannelDefaults = {
  dm: {
    engageMode: 'pattern',
    engagePattern: '.',
    threads: false,
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'decline_notify',
  },
  group: {
    engageMode: 'mention-sticky',
    threads: true,
    // D29: group conversations are per-thread too — Slack channels
    // materialize a thread per top-level message, and ambient context
    // (same-mg fan + channel-timeline backfill) is the continuity layer.
    // Creation-time stamp like dm.sessionMode; existing wirings never flip.
    // Canvas-comment shadow channels deliberately stay shared (wired
    // explicitly in room-canvas, the documented D29 exception).
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'request_approval',
  },
  mentions: 'platform',
};

/**
 * Classify a Slack conversation for consumers that render it to a human
 * (e.g. approval cards): a 1:1 DM, a group DM (MPDM), or a channel. Channels
 * resolve their name; MPDMs resolve their human participants through the
 * calling bot's own authenticated client. Returns null when the Slack API
 * can't classify the conversation (network failure, missing scope) so the
 * caller falls through to its generic rendering.
 */
export async function resolveSlackConversation(
  slackAdapter: SlackAdapter,
  platformId: string,
): Promise<{
  type: 'direct' | 'group_dm' | 'channel';
  name: string | null;
  participantNames?: string[];
  participantIds?: string[];
} | null> {
  const channelId = platformId.replace(/^slack:/, '').split(':')[0];
  if (channelId.startsWith('D')) return { type: 'direct', name: null };

  try {
    const info = await slackAdapter.fetchThread(`slack:${channelId}`);
    const channel = (info.metadata as { channel?: { is_mpim?: boolean } }).channel;
    if (!channel?.is_mpim) return { type: 'channel', name: info.channelName ?? null };

    try {
      const { members = [] } = await slackAdapter.webClient.conversations.members({
        channel: channelId,
        limit: 100,
      });
      const users = await Promise.all(members.map((id) => slackAdapter.getUser(id)));
      // participantIds (raw Slack "U…" ids) MUST stay parallel to
      // participantNames — same length, same order. A consumer pairing the
      // two arrays positionally (e.g. to exclude one participant by id)
      // breaks silently if a member is filtered from only ONE array (bot,
      // failed profile lookup). Both arrays are therefore projected from a
      // single filtered list: bots and members whose profile lookup failed
      // drop from BOTH.
      const humans = members
        .map((id, i) => ({ id, user: users[i] }))
        .filter((entry): entry is { id: string; user: NonNullable<(typeof users)[number]> } =>
          Boolean(entry.user && !entry.user.isBot),
        );
      return {
        type: 'group_dm',
        name: null,
        participantNames: humans.map(({ user }) => user.userName || user.fullName),
        participantIds: humans.map(({ id }) => id),
      };
    } catch {
      return { type: 'group_dm', name: null };
    }
  } catch {
    return null;
  }
}

/** Construction knobs for one Slack bot identity. */
export interface SlackBridgeOptions {
  /**
   * Uppercased/underscored instance suffix appended to each token env key
   * after an underscore — 'ALPHA' reads SLACK_BOT_TOKEN_ALPHA /
   * SLACK_SIGNING_SECRET_ALPHA / SLACK_APP_TOKEN_ALPHA. Omit (or pass '')
   * for the default app's unsuffixed keys.
   */
  envKeySuffix?: string;
  /**
   * Registry/bridge instance key (e.g. 'slack-alpha'). Omit for the default
   * instance, keyed by channelType. channelType stays 'slack' either way —
   * instance is a host-side routing key only, so user ids, formatting,
   * container config, and the wiring-defaults declaration are shared with
   * the default Slack app.
   */
  instanceKey?: string;
}

/**
 * Build one Slack bot identity's bridge from its token set. The default app
 * is the zero-suffix call (used by the registration below); named instances
 * pass a suffix + instance key and get the exact same construction — Socket
 * Mode opt-in, channel-name resolution, SLACK_DEFAULTS declaration. Returns
 * null when the bot token is missing so the registry surfaces its normal
 * "credentials missing, skipping" warning.
 */
export function createSlackBridge(options: SlackBridgeOptions = {}): ChannelAdapter | null {
  const suffix = options.envKeySuffix ? `_${options.envKeySuffix}` : '';
  const keys = {
    botToken: `SLACK_BOT_TOKEN${suffix}`,
    signingSecret: `SLACK_SIGNING_SECRET${suffix}`,
    appToken: `SLACK_APP_TOKEN${suffix}`,
  };
  const env = readEnvFile([keys.botToken, keys.signingSecret, keys.appToken]);
  const botToken = env[keys.botToken];
  if (!botToken) return null;
  // An xapp-… token enables Socket Mode: events arrive over an outbound
  // WebSocket, so no public HTTPS endpoint is required. When set, the
  // signing secret is optional (Slack signs socket frames separately).
  const appToken = env[keys.appToken];
  const slackAdapter = createSlackAdapter({
    botToken,
    signingSecret: env[keys.signingSecret],
    appToken,
    mode: appToken ? 'socket' : 'webhook',
  });
  const bridge = createChatSdkBridge({
    adapter: slackAdapter,
    instance: options.instanceKey, // undefined ⇒ default instance (keyed by channelType)
    concurrency: 'concurrent',
    supportsThreads: true,
    defaults: SLACK_DEFAULTS,
  });
  bridge.resolveChannelName = async (platformId: string) => {
    try {
      const info = await slackAdapter.fetchThread(platformId);
      return (info as { channelName?: string }).channelName ?? null;
    } catch {
      return null;
    }
  };
  // Fork: 👀 thinking indicator. Track the latest inbound message per chat
  // (message.id is the Slack ts) so setTyping can react to the triggering
  // message; the reaction is removed on reply delivery or after a staleness
  // timeout. Applies per instance (each createSlackBridge call has its own
  // adapter + maps).
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
  bridge.setup = async (setup: ChannelSetup) => {
    const origOnInbound = setup.onInbound.bind(setup);
    await origSetup({
      ...setup,
      onInbound(platformId: string, threadId: string | null, message: InboundMessage) {
        if (message.id) {
          lastInbound.set(platformId, { tid: threadId ?? platformId, messageId: message.id });
        }
        return origOnInbound(platformId, threadId, message);
      },
    });
  };

  bridge.setTyping = async (platformId: string, threadId: string | null) => {
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
  bridge.deliver = async (platformId: string, threadId: string | null, message) => {
    const result = await origDeliver(platformId, threadId, message);
    // Reply delivered — the agent is done thinking for this trigger.
    await clearThinking(platformId);
    return result;
  };

  // Conversation classification closes over THIS identity's adapter, so
  // every instance (default or named) resolves through its own token.
  // ChannelAdapter does not declare resolveConversation yet — the extension
  // rides on the returned object until the core seam lands.
  return Object.assign(bridge, {
    resolveConversation: (platformId: string) => resolveSlackConversation(slackAdapter, platformId),
  });
}

/** Env-key suffix for a named instance: uppercased, dashes → underscores. */
export function instanceEnvKeySuffix(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

/**
 * Build one named instance's bridge from its per-instance token set, through
 * the shared factory. Returns null when the bot token is missing so the
 * registry surfaces its normal "credentials missing, skipping" warning.
 *
 * Exported so a test can drive the real factory against a token set.
 */
export function slackInstanceBridgeFactory(name: string): ChannelAdapter | null {
  return createSlackBridge({
    envKeySuffix: instanceEnvKeySuffix(name),
    instanceKey: `slack-${name}`,
  });
}

registerChannelAdapter('slack', {
  factory: () => createSlackBridge(),
  defaults: SLACK_DEFAULTS,
});

// Named instances — registration is unconditional for every listed name so a
// missing token set surfaces as the registry's "credentials missing, skipping"
// warning at boot rather than a silently absent bot. Every registration carries
// the same SLACK_DEFAULTS declaration as the default app, so offline creation
// paths (setup, ncl) resolve declared wiring defaults for named instances too.
for (const raw of (readEnvFile(['SLACK_INSTANCES']).SLACK_INSTANCES ?? '').split(',')) {
  const name = raw.trim();
  if (!name) continue;
  registerChannelAdapter(`slack-${name}`, {
    factory: () => slackInstanceBridgeFactory(name),
    defaults: SLACK_DEFAULTS,
  });
}
