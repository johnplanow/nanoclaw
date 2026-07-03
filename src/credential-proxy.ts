/**
 * Fork customization: standalone credential proxy for host-network sidecars.
 *
 * In v2, agent containers get credentials through the OneCLI gateway — this
 * proxy is NOT in that path. It exists solely for third-party host-network
 * clients (the GPT Researcher sidecar's LangChain ChatAnthropic client) that
 * need to ride the Claude subscription.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    CLI path — client sends Authorization: Bearer placeholder,
 *             proxy replaces with real OAuth token. CLI adds its own beta header.
 *
 *             Third-party path — client sends x-api-key: placeholder
 *             (no Authorization header). Proxy converts to OAuth Bearer auth
 *             by stripping x-api-key, injecting Authorization: Bearer + the
 *             required anthropic-beta: oauth-2025-04-20 header.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { log } from './log.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const PLACEHOLDER_KEY = 'placeholder';
const OAUTH_BETA_FLAGS = 'claude-code-20250219,oauth-2025-04-20';
const OAUTH_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode
          if (headers['authorization']) {
            // CLI path: replace placeholder Bearer token with real one.
            // The CLI adds anthropic-beta: oauth-2025-04-20 itself.
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          } else if (headers['x-api-key'] === PLACEHOLDER_KEY && oauthToken) {
            // Third-party client path (e.g. LangChain ChatAnthropic):
            // Convert x-api-key auth to OAuth Bearer auth.
            delete headers['x-api-key'];
            headers['authorization'] = `Bearer ${oauthToken}`;

            // Inject required OAuth headers: beta flags, User-Agent, x-app
            const existing = headers['anthropic-beta'];
            if (existing && typeof existing === 'string') {
              if (!existing.includes(OAUTH_BETA_FLAGS)) {
                headers['anthropic-beta'] = `${existing},${OAUTH_BETA_FLAGS}`;
              }
            } else {
              headers['anthropic-beta'] = OAUTH_BETA_FLAGS;
            }
            headers['user-agent'] = 'claude-cli/2.1.81 (external, cli)';
            headers['x-app'] = 'cli';

            // Inject required system prompt prefix into the request body.
            // The API requires the system prompt to start with the Claude Code
            // identifier when using OAuth tokens.
            if (req.url?.startsWith('/v1/messages')) {
              try {
                const parsed = JSON.parse(body.toString());
                const prefixBlock = {
                  type: 'text',
                  text: OAUTH_SYSTEM_PREFIX,
                };
                if (Array.isArray(parsed.system)) {
                  parsed.system.unshift(prefixBlock);
                } else if (typeof parsed.system === 'string') {
                  parsed.system = [
                    prefixBlock,
                    { type: 'text', text: parsed.system },
                  ];
                } else {
                  parsed.system = [prefixBlock];
                }
                body = Buffer.from(JSON.stringify(parsed));
                headers['content-length'] = body.length;
              } catch {
                // Not valid JSON — forward as-is
              }
            }
          }
          // else: post-exchange requests with a real temp key pass through
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          log.error('Credential proxy upstream error', { err, url: req.url });
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      log.info('Credential proxy started', { port, host, authMode });
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
