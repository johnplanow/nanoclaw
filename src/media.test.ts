import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';

// Mock config before importing media module
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  MEDIA_DIR: '/tmp/nanoclaw-test-data/media',
  MAX_MEDIA_SIZE: 52428800, // 50MB
}));

import {
  getExtFromMime,
  guessMimetype,
  isTextMimetype,
  generateMediaId,
  mediaIdToFilename,
  processInboundMedia,
  resolveContainerMediaPath,
} from './media.js';

// --- MIME helpers ---

describe('getExtFromMime', () => {
  it('returns correct extension for known types', () => {
    expect(getExtFromMime('image/jpeg')).toBe('jpg');
    expect(getExtFromMime('image/png')).toBe('png');
    expect(getExtFromMime('video/mp4')).toBe('mp4');
    expect(getExtFromMime('audio/ogg')).toBe('ogg');
    expect(getExtFromMime('application/pdf')).toBe('pdf');
  });

  it('returns correct extension for text types', () => {
    expect(getExtFromMime('text/plain')).toBe('txt');
    expect(getExtFromMime('text/markdown')).toBe('md');
    expect(getExtFromMime('text/csv')).toBe('csv');
    expect(getExtFromMime('application/json')).toBe('json');
  });

  it('returns "bin" for unknown types', () => {
    expect(getExtFromMime('application/zip')).toBe('bin');
    expect(getExtFromMime('application/wasm')).toBe('bin');
  });
});

describe('guessMimetype', () => {
  it('guesses correct MIME type from extension', () => {
    expect(guessMimetype('/path/to/photo.jpg')).toBe('image/jpeg');
    expect(guessMimetype('/path/to/photo.jpeg')).toBe('image/jpeg');
    expect(guessMimetype('/path/to/image.png')).toBe('image/png');
    expect(guessMimetype('/path/to/video.mp4')).toBe('video/mp4');
    expect(guessMimetype('/path/to/doc.pdf')).toBe('application/pdf');
  });

  it('guesses correct MIME type for text files', () => {
    expect(guessMimetype('/path/to/readme.md')).toBe('text/markdown');
    expect(guessMimetype('/path/to/data.json')).toBe('application/json');
    expect(guessMimetype('/path/to/notes.txt')).toBe('text/plain');
    expect(guessMimetype('/path/to/script.ts')).toBe('text/typescript');
    expect(guessMimetype('/path/to/app.py')).toBe('text/x-python');
  });

  it('returns application/octet-stream for unknown extensions', () => {
    expect(guessMimetype('/path/to/file.xyz')).toBe('application/octet-stream');
    expect(guessMimetype('/path/to/file')).toBe('application/octet-stream');
  });
});

describe('isTextMimetype', () => {
  it('returns true for text types', () => {
    expect(isTextMimetype('text/plain')).toBe(true);
    expect(isTextMimetype('text/markdown')).toBe(true);
    expect(isTextMimetype('text/csv')).toBe(true);
    expect(isTextMimetype('text/html')).toBe(true);
    expect(isTextMimetype('text/typescript')).toBe(true);
  });

  it('returns true for text-like application types', () => {
    expect(isTextMimetype('application/json')).toBe(true);
    expect(isTextMimetype('application/xml')).toBe(true);
    expect(isTextMimetype('application/yaml')).toBe(true);
  });

  it('returns false for binary types', () => {
    expect(isTextMimetype('image/jpeg')).toBe(false);
    expect(isTextMimetype('video/mp4')).toBe(false);
    expect(isTextMimetype('audio/ogg')).toBe(false);
    expect(isTextMimetype('application/pdf')).toBe(false);
    expect(isTextMimetype('application/octet-stream')).toBe(false);
  });
});

// --- ID helpers ---

describe('generateMediaId', () => {
  it('produces channel:media:uid format', () => {
    const id = generateMediaId('slack');
    expect(id).toMatch(/^slack:media:\d+-[a-f0-9]+$/);
  });

  it('produces unique IDs', () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateMediaId('test')));
    expect(ids.size).toBe(10);
  });
});

describe('mediaIdToFilename', () => {
  it('extracts uid from media ID', () => {
    expect(mediaIdToFilename('whatsapp:media:1709123456789-abc123')).toBe(
      '1709123456789-abc123',
    );
  });

  it('handles colons in uid', () => {
    expect(mediaIdToFilename('slack:media:part1:part2')).toBe('part1:part2');
  });

  it('throws for invalid format', () => {
    expect(() => mediaIdToFilename('invalid')).toThrow('Invalid media ID');
    expect(() => mediaIdToFilename('only:two')).toThrow('Invalid media ID');
  });
});

// --- resolveContainerMediaPath ---

describe('resolveContainerMediaPath', () => {
  it('resolves valid container path', () => {
    const result = resolveContainerMediaPath(
      '/workspace/media/photo.jpg',
      'main',
    );
    expect(result).toBe('/tmp/nanoclaw-test-data/media/main/photo.jpg');
  });

  it('resolves /workspace/group/ paths', () => {
    const result = resolveContainerMediaPath(
      '/workspace/group/output.png',
      'main',
    );
    expect(result).toBe('/tmp/nanoclaw-test-groups/main/output.png');
  });

  it('returns null for unrecognized prefixes', () => {
    expect(resolveContainerMediaPath('/etc/passwd', 'main')).toBeNull();
    expect(resolveContainerMediaPath('/workspace/other/file.txt', 'main')).toBeNull();
  });

  it('rejects path traversal in media path', () => {
    expect(resolveContainerMediaPath('/workspace/media/../../../etc/passwd', 'main')).toBeNull();
  });

  it('rejects path traversal in group path', () => {
    expect(resolveContainerMediaPath('/workspace/group/../../../etc/passwd', 'main')).toBeNull();
  });
});

// --- processInboundMedia ---

describe('processInboundMedia', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns content with caption when provided', () => {
    const result = processInboundMedia('main', {
      channel: 'slack',
      mimetype: 'image/jpeg',
      sender: 'user1',
      timestamp: '2024-01-01T00:00:00.000Z',
      ref: {},
      caption: 'Check this photo',
      mediaType: 'image',
    });
    expect(result).not.toBeNull();
    expect(result!.content).toBe('Check this photo');
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0].mimetype).toBe('image/jpeg');
  });

  it('returns label when no caption', () => {
    const result = processInboundMedia('main', {
      channel: 'slack',
      mimetype: 'audio/ogg',
      sender: 'user1',
      timestamp: '2024-01-01T00:00:00.000Z',
      ref: {},
      mediaType: 'audio',
    });
    expect(result).not.toBeNull();
    expect(result!.content).toBe('[Audio]');
  });

  it('returns [File] label when no mediaType', () => {
    const result = processInboundMedia('main', {
      channel: 'slack',
      mimetype: 'application/octet-stream',
      sender: 'user1',
      timestamp: '2024-01-01T00:00:00.000Z',
      ref: {},
    });
    expect(result).not.toBeNull();
    expect(result!.content).toBe('[File]');
  });

  it('returns null when size exceeds MAX_MEDIA_SIZE', () => {
    const result = processInboundMedia('main', {
      channel: 'slack',
      mimetype: 'video/mp4',
      size: 100_000_000, // 100MB > 50MB limit
      sender: 'user1',
      timestamp: '2024-01-01T00:00:00.000Z',
      ref: {},
      mediaType: 'video',
    });
    expect(result).toBeNull();
  });

  it('allows media when size is under MAX_MEDIA_SIZE', () => {
    const result = processInboundMedia('main', {
      channel: 'slack',
      mimetype: 'image/jpeg',
      size: 1_000_000,
      sender: 'user1',
      timestamp: '2024-01-01T00:00:00.000Z',
      ref: {},
      mediaType: 'image',
    });
    expect(result).not.toBeNull();
  });

  it('allows media when size is undefined', () => {
    const result = processInboundMedia('main', {
      channel: 'slack',
      mimetype: 'image/jpeg',
      sender: 'user1',
      timestamp: '2024-01-01T00:00:00.000Z',
      ref: {},
    });
    expect(result).not.toBeNull();
  });

  it('generates unique attachment IDs', () => {
    const r1 = processInboundMedia('main', {
      channel: 'slack',
      mimetype: 'image/png',
      sender: 'u1',
      timestamp: 't1',
      ref: {},
    });
    const r2 = processInboundMedia('main', {
      channel: 'slack',
      mimetype: 'image/png',
      sender: 'u1',
      timestamp: 't2',
      ref: {},
    });
    expect(r1!.attachments[0].id).not.toBe(r2!.attachments[0].id);
  });

  it('saves media ref to disk', () => {
    processInboundMedia('test-group', {
      channel: 'slack',
      mimetype: 'video/mp4',
      filename: 'clip.mp4',
      size: 5000,
      sender: 'user2',
      timestamp: '2024-01-01T00:00:00.000Z',
      ref: { url: 'https://files.slack.com/...' },
      mediaType: 'video',
    });
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled();
  });
});
