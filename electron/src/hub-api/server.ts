import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type {
  ReticulumChatEvent,
  ReticulumChatHistoryReadOptions,
} from '../reticulum-chat';
import {
  HubApiError,
  type HubApiAuthorize,
  type HubApiPrincipal,
  type HubApiScope,
} from './auth';
import type { HubApiConfig } from './config';
import type { HubApiRuntime } from './runtime';

const MAX_BODY_BYTES = 256 * 1024;
const LEASE_MS = 30_000;
const STREAM_MS = 30_000;
const MESSAGE_TYPES = new Set([
  'message',
  'edit',
  'delete',
  'reaction_add',
  'reaction_remove',
]);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  if (
    request.headers['content-type']?.split(';')[0].trim() !== 'application/json'
  ) {
    throw new HubApiError(415, 'json_required');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new HubApiError(413, 'body_too_large');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw new HubApiError(400, 'invalid_json');
  }
}

function integer(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new HubApiError(400, 'invalid_integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HubApiError(400, 'invalid_integer');
  }
  return parsed;
}

export type HubAccountResolver = (
  token: string,
  walletId: string,
  scope: HubApiScope
) => Promise<{
  config: HubApiConfig;
  principal: HubApiPrincipal;
  runtime: HubApiRuntime;
}>;

type Lease = {
  key: string;
  groupId: number;
  runtime: HubApiRuntime;
  owner: string;
  sequence?: { authorStreamId: string; authorSeq: number };
  timer?: NodeJS.Timeout;
  publishing?: boolean;
  cancelled?: boolean;
};

/** Transport-only service; getRuntime supplies the current isolated account worker. */
export async function startHubApi(
  config: HubApiConfig,
  authorize: HubApiAuthorize,
  getRuntime: () => Promise<HubApiRuntime>,
  resolveAccount?: HubAccountResolver
) {
  const leases = new Map<string, Lease>();
  const streams = new Set<() => void>();
  let inFlight = 0;
  let closed = false;
  const release = (groupId: number, lease: Lease) => {
    if (leases.get(lease.key) !== lease) return;
    leases.delete(lease.key);
    clearTimeout(lease.timer);
    if (lease.sequence) lease.runtime.release(groupId, lease.sequence);
    else lease.cancelled = true;
  };

  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Reverse proxies must replace Host with the loopback upstream authority.
    const bound = server.address();
    const authority = `${config.host === '::1' ? '[::1]' : config.host}:${typeof bound === 'object' && bound ? bound.port : config.port}`;
    if (request.headers.host !== authority)
      throw new HubApiError(421, 'invalid_host');
    const origin = request.headers.origin;
    if (origin) {
      if (!config.origins.includes(origin))
        throw new HubApiError(403, 'origin_denied');
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      if (!origin) throw new HubApiError(403, 'origin_required');
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':
          'Authorization, Content-Type, X-Qortal-Hub-Wallet-Id',
      });
      response.end();
      return;
    }
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/healthz' && request.method === 'GET') {
      json(response, 200, { service: 'qortal-hub-api', apiVersion: 1 });
      return;
    }
    if (url.searchParams.has('token') || url.searchParams.has('access_token')) {
      throw new HubApiError(400, 'authorization_header_required');
    }
    const token = /^Bearer ([^\s]{1,4096})$/.exec(
      request.headers.authorization || ''
    )?.[1];
    if (!token) throw new HubApiError(401, 'unauthorized');
    if (!['GET', 'POST'].includes(request.method || ''))
      throw new HubApiError(405, 'method_not_allowed');
    const requestedWallet = request.headers['x-qortal-hub-wallet-id'];
    const scope = request.method === 'POST' ? 'QCHAT_PUBLISH' : 'QCHAT_READ';
    let accountConfig = config;
    let principal: HubApiPrincipal;
    let runtime: HubApiRuntime;
    if (resolveAccount) {
      if (
        typeof requestedWallet !== 'string' ||
        !requestedWallet ||
        requestedWallet.length > 256
      )
        throw new HubApiError(400, 'wallet_id_required');
      const account = await resolveAccount(token, requestedWallet, scope);
      accountConfig = account.config;
      principal = account.principal;
      runtime = account.runtime;
    } else {
      principal = await authorize(token, scope);
      if (principal.address !== config.address)
        throw new HubApiError(403, 'account_mismatch');
      if (requestedWallet !== undefined && requestedWallet !== config.walletId)
        throw new HubApiError(403, 'wallet_mismatch');
      runtime = await getRuntime();
    }
    response.setHeader('X-Qortal-Hub-Wallet-Id', accountConfig.walletId);
    runtime.assertAccount();
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      json(response, 200, {
        apiVersion: 1,
        backend: runtime.backend,
        address: accountConfig.address,
        walletId: accountConfig.walletId,
        groupIds: accountConfig.groupIds,
        reticulum: runtime.transportStatus(),
      });
      return;
    }
    const route =
      /^\/v1\/groups\/(\d+)\/(channels|sequences|events)(?:\/([^/]+)(?:\/(events|stream))?)?$/.exec(
        url.pathname
      );
    if (!route) throw new HubApiError(404, 'not_found');
    const groupId = integer(route[1], 1, Number.MAX_SAFE_INTEGER);
    if (!accountConfig.groupIds.includes(groupId))
      throw new HubApiError(403, 'group_not_allowed');
    const leaseKey = JSON.stringify([accountConfig.walletId, groupId]);
    const action = route[2];
    const releasing =
      action === 'sequences' && route[3] === 'release' && !route[4];
    let channelId: string | undefined;
    if (route[3] && !releasing) {
      try {
        channelId = decodeURIComponent(route[3]);
      } catch {
        throw new HubApiError(400, 'invalid_channel');
      }
      if (action !== 'channels' || !channelId || channelId.length > 128)
        throw new HubApiError(400, 'invalid_channel');
    }
    if (request.method === 'GET' && action === 'channels' && !channelId) {
      json(response, 200, runtime.channelMetadata(groupId));
      return;
    }
    if (request.method === 'GET' && channelId && route[4] === 'events') {
      const limit = integer(url.searchParams.get('limit') || '100', 1, 500);
      const options: ReticulumChatHistoryReadOptions = {};
      for (const key of ['beforeTimestamp', 'afterTimestamp'] as const) {
        const value = url.searchParams.get(key);
        if (value != null)
          options[key] = integer(value, 0, Number.MAX_SAFE_INTEGER);
      }
      for (const key of ['beforeEventId', 'afterEventId'] as const) {
        const value = url.searchParams.get(key);
        if (value != null) {
          if (!value || value.length > 128)
            throw new HubApiError(400, 'invalid_cursor');
          options[key] = value;
        }
      }
      json(response, 200, {
        events: runtime.history(groupId, channelId, limit, options),
      });
      return;
    }
    if (request.method === 'GET' && channelId && route[4] === 'stream') {
      runtime.assertChannel(groupId, channelId);
      if (streams.size >= 16) throw new HubApiError(429, 'stream_limit');
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.write('event: ready\ndata: {}\n\n');
      let refreshing = false;
      let ended = false;
      const close = () => {
        if (ended) return;
        ended = true;
        clearTimeout(expiry);
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(close);
        response.end();
      };
      const unsubscribe = runtime.onChange(groupId, channelId, () => {
        if (refreshing || ended) return;
        refreshing = true;
        void (resolveAccount ? Promise.resolve(runtime) : getRuntime())
          .then((current) => {
            if (ended) return;
            if (current.manager !== runtime.manager) {
              close();
              return;
            }
            current.assertChannel(groupId, channelId!);
            if (
              !response.write(
                `event: changed\ndata: ${JSON.stringify({ groupId, channelId })}\n\n`
              )
            )
              close();
          })
          .catch(close)
          .finally(() => {
            refreshing = false;
          });
      });
      // Short-lived streams bound revocation latency; reconnect with a fresh bearer check.
      const expiry = setTimeout(close, STREAM_MS);
      const heartbeat = setInterval(() => {
        try {
          runtime.assertAccount();
        } catch {
          close();
          return;
        }
        if (!response.write(': heartbeat\n\n')) close();
      }, 10_000);
      streams.add(close);
      response.once('close', close);
      return;
    }
    const owner = createHash('sha256').update(token).digest('hex');
    if (request.method === 'POST' && releasing) {
      const body = await readJson(request);
      const lease = leases.get(leaseKey);
      if (!lease) {
        json(response, 200, { released: false });
        return;
      }
      if (
        !lease.sequence ||
        lease.publishing ||
        lease.owner !== owner ||
        lease.runtime.manager !== runtime.manager ||
        body.authorStreamId !== lease.sequence.authorStreamId ||
        body.authorSeq !== lease.sequence.authorSeq
      )
        throw new HubApiError(409, 'sequence_reservation_required');
      release(groupId, lease);
      json(response, 200, { released: true });
      return;
    }
    if (
      request.method === 'POST' &&
      action === 'sequences' &&
      !channelId &&
      !releasing
    ) {
      await readJson(request);
      if (leases.has(leaseKey)) throw new HubApiError(409, 'sequence_busy');
      if (leases.size >= 32) throw new HubApiError(429, 'sequence_limit');
      const lease: Lease = { runtime, owner, key: leaseKey, groupId };
      leases.set(leaseKey, lease);
      try {
        lease.sequence = await runtime.reserve(groupId);
        if (lease.cancelled) {
          runtime.release(groupId, lease.sequence);
          return;
        }
        if (closed || response.destroyed) {
          release(groupId, lease);
          return;
        }
        lease.timer = setTimeout(() => release(groupId, lease), LEASE_MS);
        json(response, 201, {
          ...lease.sequence,
          expiresAt: Date.now() + LEASE_MS,
        });
      } catch (error) {
        release(groupId, lease);
        throw error;
      }
      return;
    }
    if (request.method === 'POST' && action === 'events' && !channelId) {
      const event = await readJson(request);
      if (
        event.groupId !== groupId ||
        event.authorAddress !== principal.address ||
        event.authorPublicKey !== principal.publicKey
      ) {
        throw new HubApiError(403, 'event_author_mismatch');
      }
      if (
        typeof event.channelId !== 'string' ||
        !MESSAGE_TYPES.has(String(event.eventType))
      ) {
        throw new HubApiError(400, 'unsupported_event');
      }
      const lease = leases.get(leaseKey);
      if (
        !lease?.sequence ||
        lease.publishing ||
        lease.owner !== owner ||
        lease.runtime.manager !== runtime.manager ||
        event.authorStreamId !== lease.sequence.authorStreamId ||
        event.authorSeq !== lease.sequence.authorSeq
      ) {
        throw new HubApiError(409, 'sequence_reservation_required');
      }
      lease.publishing = true;
      try {
        await runtime.publish(event as unknown as ReticulumChatEvent);
        // Matches Hub semantics: accepted locally, not a remote-delivery receipt.
        json(response, 202, { accepted: true, eventId: event.eventId });
      } finally {
        release(groupId, lease);
      }
      return;
    }
    throw new HubApiError(404, 'not_found');
  };

  const server = createServer(
    { maxHeaderSize: 16 * 1024, requestTimeout: 10_000 },
    (request, response) => {
      if (closed || inFlight >= 32) {
        json(response, 503, { error: 'busy' });
        return;
      }
      inFlight += 1;
      void serve(request, response)
        .catch((error) => {
          if (response.destroyed) return;
          if (response.headersSent) {
            response.end();
            return;
          }
          const known = error instanceof HubApiError;
          if (known && error.status === 401)
            response.setHeader('WWW-Authenticate', 'Bearer');
          json(response, known ? error.status : 500, {
            error: known ? error.code : 'internal_error',
          });
        })
        .finally(() => {
          inFlight -= 1;
        });
    }
  );
  server.headersTimeout = 10_000;
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    async close(): Promise<void> {
      closed = true;
      for (const close of [...streams]) close();
      for (const lease of leases.values()) release(lease.groupId, lease);
      const closing = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      server.closeAllConnections();
      await closing;
    },
  };
}
