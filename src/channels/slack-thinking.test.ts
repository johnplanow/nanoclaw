/** Fork: 👀 thinking indicator (docs/CUSTOMIZATIONS.md §1). */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./slack.js', () => ({ createSlackBridge: () => null, SLACK_DEFAULTS: {} }));

import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { installThinkingIndicator, slackChannelId } from './slack-thinking.js';

function fakeBridge() {
  let captured: ChannelSetup | undefined;
  const typed: unknown[][] = [];
  const bridge = {
    setup: async (setup: ChannelSetup) => {
      captured = setup;
    },
    deliver: async () => 'ts-out',
    setTyping: async (...args: unknown[]) => {
      typed.push(args);
    },
  } as unknown as ChannelAdapter;
  return { bridge, typed, inbound: (id: string) => captured!.onInbound('slack:C1', null, { id } as InboundMessage) };
}

describe('slack thinking indicator', () => {
  it('parses the channel id out of a platform or thread id', () => {
    expect(slackChannelId('slack:C0AMY13SHJR')).toBe('C0AMY13SHJR');
    expect(slackChannelId('slack:C0AMY13SHJR:1700000000.000100')).toBe('C0AMY13SHJR');
    expect(slackChannelId('slack:')).toBeNull();
  });

  it('reacts to the triggering message once and removes the reaction on delivery', async () => {
    const calls: string[] = [];
    const { bridge, inbound } = fakeBridge();
    installThinkingIndicator(bridge, async (method, channel, ts) => void calls.push(`${method} ${channel} ${ts}`));
    await bridge.setup({ onInbound: vi.fn() } as unknown as ChannelSetup);

    await bridge.setTyping!('slack:C1', null); // nothing inbound yet
    await inbound('111.1');
    await bridge.setTyping!('slack:C1', null);
    await bridge.setTyping!('slack:C1', null); // refresh tick — no second add
    expect(calls).toEqual(['add C1 111.1']);

    expect(await bridge.deliver('slack:C1', null, {} as never)).toBe('ts-out');
    expect(calls).toEqual(['add C1 111.1', 'remove C1 111.1']);
  });

  it('moves the reaction to a newer message and survives Slack API errors', async () => {
    const calls: string[] = [];
    const { bridge, inbound } = fakeBridge();
    installThinkingIndicator(bridge, async (method, _channel, ts) => {
      calls.push(`${method} ${ts}`);
      throw new Error('already_reacted');
    });
    await bridge.setup({ onInbound: vi.fn() } as unknown as ChannelSetup);

    await inbound('1');
    await bridge.setTyping!('slack:C1', null);
    await inbound('2');
    await bridge.setTyping!('slack:C1', null);
    expect(calls).toEqual(['add 1', 'remove 1', 'add 2']);
  });

  it('removes a stale reaction and leaves agent status lines to the bridge', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const { bridge, typed, inbound } = fakeBridge();
      installThinkingIndicator(bridge, async (method) => void calls.push(method), 1000);
      await bridge.setup({ onInbound: vi.fn() } as unknown as ChannelSetup);

      await inbound('1');
      await bridge.setTyping!('slack:C1', 't1', 'Reading files', 'agent');
      expect(typed).toEqual([['slack:C1', 't1', 'Reading files', 'agent']]);
      expect(calls).toEqual([]);

      await bridge.setTyping!('slack:C1', null);
      await vi.advanceTimersByTimeAsync(1500);
      expect(calls).toEqual(['add', 'remove']);
    } finally {
      vi.useRealTimers();
    }
  });
});
