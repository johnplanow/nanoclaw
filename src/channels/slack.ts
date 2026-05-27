import { App, LogLevel } from '@slack/bolt';
import type {
  GenericMessageEvent,
  BotMessageEvent,
  FileShareMessageEvent,
} from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { isTextMimetype, processInboundMedia } from '../media.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  MediaAttachment,
  MediaSendOptions,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined), bot messages
// (BotMessageEvent, subtype 'bot_message'), and file shares (FileShareMessageEvent,
// subtype 'file_share') so we can handle attachments.
type HandledMessageEvent =
  | GenericMessageEvent
  | BotMessageEvent
  | FileShareMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  // Track the latest inbound (non-bot) message ts per channel so
  // setTyping can add/remove a reaction as a "thinking" indicator.
  private lastInboundTs = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share')
        return;

      const msg = event as HandledMessageEvent;
      const files = (msg as GenericMessageEvent | FileShareMessageEvent).files;

      // Skip messages with no text AND no files
      if (!msg.text && (!files || files.length === 0)) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage =
        !!(msg as GenericMessageEvent | BotMessageEvent).bot_id ||
        msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text || '';
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Process file attachments
      let attachments: MediaAttachment[] | undefined;
      if (files?.length && !isBotMessage) {
        const group = groups[jid];
        const result = this.processFiles(
          files,
          group.folder,
          msg.user || '',
          timestamp,
          content,
        );
        content = result.content;
        attachments = result.attachments.length
          ? result.attachments
          : undefined;
      }

      // Track latest inbound message ts for reaction-based typing indicator
      if (!isBotMessage) {
        this.lastInboundTs.set(jid, msg.ts);
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || (msg as BotMessageEvent).bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        attachments,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack doesn't support typing indicators for bots, so we use emoji
  // reactions as a lightweight "thinking" signal instead. When the agent
  // starts processing, we add an 👀 reaction to the triggering message;
  // when it finishes, we remove it.
  private static readonly THINKING_EMOJI = 'eyes';

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const messageTs = this.lastInboundTs.get(jid);
    if (!messageTs) return;

    try {
      if (isTyping) {
        await this.app.client.reactions.add({
          channel: channelId,
          timestamp: messageTs,
          name: SlackChannel.THINKING_EMOJI,
        });
      } else {
        await this.app.client.reactions.remove({
          channel: channelId,
          timestamp: messageTs,
          name: SlackChannel.THINKING_EMOJI,
        });
      }
    } catch (err) {
      // Silently ignore — reaction may already exist or be already removed
      logger.debug({ jid, isTyping, err }, 'Slack reaction indicator failed');
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  /**
   * Process file attachments from a Slack message.
   * Text files are inlined into the message content for immediate visibility.
   * Binary files (images, PDFs, etc.) use lazy-download via media refs.
   */
  private processFiles(
    files: Array<{
      id: string;
      name: string | null;
      mimetype: string;
      size: number;
      url_private?: string;
      url_private_download?: string;
    }>,
    groupFolder: string,
    sender: string,
    timestamp: string,
    existingContent: string,
  ): { content: string; attachments: MediaAttachment[] } {
    const allAttachments: MediaAttachment[] = [];
    const textParts: string[] = [];
    if (existingContent) textParts.push(existingContent);

    for (const file of files) {
      const result = processInboundMedia(groupFolder, {
        channel: 'slack',
        mimetype: file.mimetype,
        filename: file.name || undefined,
        size: file.size,
        sender,
        timestamp,
        ref: {
          fileId: file.id,
          urlPrivate: file.url_private,
          urlPrivateDownload: file.url_private_download,
        },
        mediaType: file.mimetype.startsWith('image/')
          ? 'image'
          : file.mimetype.startsWith('video/')
            ? 'video'
            : file.mimetype.startsWith('audio/')
              ? 'audio'
              : isTextMimetype(file.mimetype)
                ? 'document'
                : 'document',
      });

      if (result) {
        allAttachments.push(...result.attachments);
        // For file-only messages (no text), add the label
        if (!existingContent && result.content !== '[File]') {
          textParts.push(result.content);
        }
      } else {
        logger.info(
          { fileId: file.id, size: file.size },
          'Slack file skipped (exceeds size limit)',
        );
      }
    }

    return {
      content: textParts.join('\n') || '[File]',
      attachments: allAttachments,
    };
  }

  async downloadMedia(ref: unknown): Promise<Buffer> {
    const slackRef = ref as {
      urlPrivateDownload?: string;
      urlPrivate?: string;
    };
    const url = slackRef.urlPrivateDownload || slackRef.urlPrivate;
    if (!url) {
      throw new Error('No download URL in Slack media ref');
    }

    const env = readEnvFile(['SLACK_BOT_TOKEN']);
    const token = env.SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error('SLACK_BOT_TOKEN not available for media download');
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(
        `Slack media download failed: ${response.status} ${response.statusText}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async sendMedia(
    jid: string,
    filePath: string,
    options?: MediaSendOptions,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const fs = await import('fs');
    const path = await import('path');

    const fileBuffer = fs.readFileSync(filePath);
    const filename = options?.filename || path.basename(filePath);

    await this.app.client.files.uploadV2({
      channel_id: channelId,
      file: fileBuffer,
      filename,
      initial_comment: options?.caption,
    });
    logger.info({ jid, filename }, 'Slack media sent');
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
