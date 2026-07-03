# 03 — Media: adopt v2 native stack; port two gaps only

v2's native attachment infrastructure supersedes the fork's entire media stack
(see index.md "Dropped in v2"). Two gaps get ported:

## Gap 1: Inbound attachment size cap

**Intent:** v1 enforced `MAX_MEDIA_SIZE` (env var, default 52428800 = 50MB) before
storing inbound media. v2 has NO inbound size limit anywhere — `chat-sdk-bridge.ts`
`messageToInbound()` calls `att.fetchData()` unbounded and inlines base64;
`session-manager.ts` `extractAttachmentFiles` writes whatever arrives. A large file
posted to any channel would balloon memory and the session DB/content JSON.

**Files:** `src/channels/chat-sdk-bridge.ts` (primary chokepoint — skip download
before it happens; the size is usually known pre-download via `att.size`).

**How to apply:** in `messageToInbound()`'s attachment loop, before calling
`att.fetchData()`:

```ts
const MAX_ATTACHMENT_SIZE = parseInt(process.env.MAX_MEDIA_SIZE || '52428800', 10);
// Fork: cap inbound attachment downloads (v1 MAX_MEDIA_SIZE behavior)
if (typeof att.size === 'number' && att.size > MAX_ATTACHMENT_SIZE) {
  log.warn('Attachment skipped (exceeds size limit)', { name: att.name, size: att.size });
  enriched.push(entry); // keep metadata entry, no data → no inbox file
  continue;
}
```

Also guard post-download for channels that report no size:
`if (buffer.length > MAX_ATTACHMENT_SIZE) { log.warn(...); } else { entry.data = buffer.toString('base64'); }`

Match the file's existing style/logger. Put the constant at module top, reading env
once. Keep the env var name `MAX_MEDIA_SIZE` for continuity with the live `.env`.

## Gap 2: poppler-utils in the container image

**Intent:** agents read PDFs via `pdftotext`. v2's `container/Dockerfile` has no PDF
tooling.

**Files:** `container/Dockerfile`.

**How to apply:** add `poppler-utils` to the existing `apt-get install` list
(alphabetical position, matching upstream's list formatting). If v2 offers a
`container/cli-tools.json` / packages_apt mechanism per agent group
(container_configs has `packages_apt`), prefer the Dockerfile for parity with v1
(all groups need it) — but note the per-group alternative exists.

**Validation:** after container rebuild at cutover, `pdftotext -v` inside the agent
container; live-test a PDF attachment in Slack.
