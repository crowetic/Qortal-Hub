import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubApiError, createExternalAuthAuthorizer } from './auth';
import { readHubApiConfig, type HubApiConfig } from './config';
import { HubApiRuntime, type HubApiChatManager } from './runtime';
import { startHubApi } from './server';

const ADDRESS = 'QaU2XUB6iMgM9YUJnYRkxwVKJd322hJh91';
const OTHER = 'QeLB8NZBjQkWYkRdw3renvRgB63DWR9E5E';
const PUBLIC_KEY = 'public-key';
const config: HubApiConfig = {
  host: '127.0.0.1',
  port: 0,
  authUrl: 'http://127.0.0.1:3191',
  walletId: 'wallet-1',
  address: ADDRESS,
  groupIds: [716],
  origins: ['https://hub.qortal.link'],
};
const running: Array<Awaited<ReturnType<typeof startHubApi>>> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((api) => api.close()));
});

async function fixture() {
  let addresses = [ADDRESS];
  let enabled = true;
  const manager = Object.assign(new EventEmitter(), {
    getLocalAccountAddresses: vi.fn(() => [...addresses]),
    getChannels: vi.fn(() => [{ channelId: 'general' }]),
    getChannelMetadataBundle: vi.fn(() => ({
      channels: [{ channelId: 'general', categoryId: 'community' }],
      categories: [{ categoryId: 'community', name: 'Community', position: 1 }],
      ready: true,
      snapshotVersion: 7,
    })),
    getHistory: vi.fn(() => [
      { eventId: 'history-1', encryptedPayload: 'ciphertext' },
    ]),
    reserveAuthorSequence: vi.fn(async () => ({
      authorStreamId: 'stream-1',
      authorSeq: 1,
    })),
    releaseAuthorSequence: vi.fn(() => true),
    publishEvent: vi.fn(async () => ({ ok: true })),
  });
  const runtime = new HubApiRuntime(
    manager as unknown as HubApiChatManager,
    ADDRESS,
    () => enabled
  );
  const authorize = vi.fn(async (token: string, scope: string) => {
    if (!['valid', 'second', 'read-only'].includes(token))
      throw new HubApiError(403, 'access_denied');
    if (token === 'read-only' && scope === 'QCHAT_PUBLISH')
      throw new HubApiError(403, 'scope_required');
    return { address: ADDRESS, publicKey: PUBLIC_KEY };
  });
  const api = await startHubApi(config, authorize, async () => runtime);
  running.push(api);
  const bound = api.server.address();
  if (!bound || typeof bound === 'string')
    throw new Error('Expected TCP server');
  const base = `http://127.0.0.1:${bound.port}`;
  const request = (path: string, init: RequestInit = {}, token = 'valid') =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
  const post = (path: string, body: unknown, token = 'valid') =>
    request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      token
    );
  return {
    api,
    manager,
    runtime,
    authorize,
    base,
    request,
    post,
    switchAccount: (next: string[]) => {
      addresses = next;
    },
    disable: () => {
      enabled = false;
    },
  };
}

function event(overrides = {}) {
  return {
    eventId: 'event-1',
    groupId: 716,
    channelId: 'general',
    authorAddress: ADDRESS,
    authorPublicKey: PUBLIC_KEY,
    authorStreamId: 'stream-1',
    authorSeq: 1,
    eventType: 'message',
    encryptedPayload: 'ciphertext',
    signature: 'signed',
    ...overrides,
  };
}

it('returns an atomic readable category/channel snapshot through the existing channels API', async () => {
  const f = await fixture();
  const response = await f.request('/v1/groups/716/channels');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    channels: [{ channelId: 'general', categoryId: 'community' }],
    categories: [{ categoryId: 'community', name: 'Community', position: 1 }],
    ready: true,
    snapshotVersion: 7,
  });
  expect(f.manager.getChannelMetadataBundle).toHaveBeenCalledWith(716);
  f.manager.getChannelMetadataBundle.mockImplementationOnce(() => {
    throw new Error('Not a group member');
  });
  expect((await f.request('/v1/groups/716/channels')).status).toBe(403);
  f.switchAccount([OTHER]);
  expect((await f.request('/v1/groups/716/channels')).status).toBe(503);
});

it('isolates dynamic wallet selection and simultaneous sequence leases in one group', async () => {
  const first = await fixture();
  const second = await fixture();
  second.manager.getLocalAccountAddresses.mockReturnValue([OTHER]);
  const secondRuntime = new HubApiRuntime(
    second.manager as unknown as HubApiChatManager,
    OTHER,
    () => true,
    'node'
  );
  const api = await startHubApi(
    config,
    async () => {
      throw new Error('Desktop authorization must not run');
    },
    async () => {
      throw new Error('Desktop runtime must not run');
    },
    async (token, walletId) => {
      if (token !== 'valid' || !['wallet-1', 'wallet-2'].includes(walletId))
        throw new HubApiError(403, 'access_denied');
      const address = walletId === 'wallet-1' ? ADDRESS : OTHER;
      return {
        config: { ...config, walletId, address },
        principal: { address, publicKey: PUBLIC_KEY },
        runtime: walletId === 'wallet-1' ? first.runtime : secondRuntime,
      };
    }
  );
  running.push(api);
  const bound = api.server.address();
  if (!bound || typeof bound === 'string') throw new Error('Expected TCP');
  const request = (walletId?: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${bound.port}/v1/groups/716/sequences`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid',
        'Content-Type': 'application/json',
        ...(walletId ? { 'X-Qortal-Hub-Wallet-Id': walletId } : {}),
      },
      body: JSON.stringify(body || {}),
    });
  expect((await request()).status).toBe(400);
  const a = await request('wallet-1');
  const b = await request('wallet-2');
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  expect(a.headers.get('X-Qortal-Hub-Wallet-Id')).toBe('wallet-1');
  expect(b.headers.get('X-Qortal-Hub-Wallet-Id')).toBe('wallet-2');
  expect((await request('wallet-1')).status).toBe(409);
  expect((await request('unknown-wallet')).status).toBe(403);
  await api.close();
  running.splice(running.indexOf(api), 1);
  expect(first.manager.releaseAuthorSequence).toHaveBeenCalledWith(
    716,
    ADDRESS,
    'stream-1',
    1
  );
  expect(second.manager.releaseAuthorSequence).toHaveBeenCalledWith(
    716,
    OTHER,
    'stream-1',
    1
  );
});

describe('Hub API configuration', () => {
  const env = {
    QORTAL_HUB_API_ENABLED: '1',
    QORTAL_HUB_API_AUTH_URL: config.authUrl,
    QORTAL_HUB_API_WALLET_ID: config.walletId,
    QORTAL_HUB_API_ADDRESS: ADDRESS,
    QORTAL_HUB_API_GROUP_IDS: '716,42,716',
  };
  it('is disabled by default and requires complete explicit configuration', () => {
    expect(readHubApiConfig({})).toBeNull();
    expect(() => readHubApiConfig({ QORTAL_HUB_API_ENABLED: '1' })).toThrow();
    expect(readHubApiConfig(env)).toMatchObject({
      host: '127.0.0.1',
      port: 3192,
      groupIds: [716, 42],
    });
  });
  it.each([
    { QORTAL_HUB_API_HOST: '0.0.0.0' },
    { QORTAL_HUB_API_PORT: '0' },
    { QORTAL_HUB_API_AUTH_URL: 'https://user:secret@example.com' },
    { QORTAL_HUB_API_AUTH_URL: 'file:///tmp/auth' },
    { QORTAL_HUB_API_AUTH_URL: 'http://localhost:3191/anything' },
    { QORTAL_HUB_API_GROUP_IDS: '716,,42' },
    { QORTAL_HUB_API_ORIGINS: '*' },
    { QORTAL_HUB_API_ORIGINS: 'https://hub.qortal.link/path' },
  ])('rejects unsafe or malformed deployment settings: %o', (override) => {
    expect(() => readHubApiConfig({ ...env, ...override })).toThrow();
  });
});

describe('External Auth adapter', () => {
  const wallet = {
    walletId: config.walletId,
    address0: ADDRESS,
    publicKey: PUBLIC_KEY,
  };
  it('validates wallet ownership and exact scope using the existing endpoints', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(wallet))
      .mockResolvedValueOnce(Response.json({ effective: true }));
    const authorize = createExternalAuthAuthorizer(config, fetcher);
    await expect(authorize('opaque-token', 'QCHAT_READ')).resolves.toEqual({
      address: ADDRESS,
      publicKey: PUBLIC_KEY,
    });
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      `${config.authUrl}/wallet/wallet-1`,
      `${config.authUrl}/permissions/status?walletId=wallet-1&scope=QCHAT_READ`,
    ]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer opaque-token' },
      redirect: 'error',
    });
  });
  it.each([401, 403, 404, 500])(
    'fails closed for upstream status %i',
    async (status) => {
      const authorize = createExternalAuthAuthorizer(
        config,
        vi.fn().mockResolvedValue(new Response('', { status }))
      );
      await expect(authorize('token', 'QCHAT_READ')).rejects.toMatchObject({
        status: status === 500 ? 503 : 403,
      });
    }
  );
  it('rejects another account and does not ask for permissions', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ ...wallet, address0: OTHER }));
    await expect(
      createExternalAuthAuthorizer(config, fetcher)('token', 'QCHAT_READ')
    ).rejects.toMatchObject({ code: 'account_mismatch' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects missing permissions and treats network failures as unavailable', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(wallet))
      .mockResolvedValueOnce(Response.json({ effective: false }));
    await expect(
      createExternalAuthAuthorizer(config, fetcher)('token', 'QCHAT_PUBLISH')
    ).rejects.toMatchObject({ code: 'scope_required' });
    await expect(
      createExternalAuthAuthorizer(
        config,
        vi.fn().mockRejectedValue(new Error('secret upstream URL'))
      )('token', 'QCHAT_READ')
    ).rejects.toMatchObject({ code: 'auth_unavailable' });
  });
});

describe('Hub Q-Chat HTTP API', () => {
  it('provides minimal liveness without exposing account data', async () => {
    const f = await fixture();
    const response = await fetch(`${f.base}/healthz`);
    expect(await response.json()).toEqual({
      service: 'qortal-hub-api',
      apiVersion: 1,
    });
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it('requires bearer authorization and rejects tokens in URLs', async () => {
    const f = await fixture();
    expect((await fetch(`${f.base}/v1/status`)).status).toBe(401);
    expect((await f.request('/v1/status?access_token=valid')).status).toBe(400);
    expect((await f.request('/v1/status', {}, 'invalid')).status).toBe(403);
  });

  it('binds proxied requests to the requested External Auth wallet', async () => {
    const f = await fixture();
    const response = await f.request('/v1/status', {
      headers: { 'X-Qortal-Hub-Wallet-Id': config.walletId },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).walletId).toBe(config.walletId);
    expect(
      (
        await f.request('/v1/groups/716/channels/general/events', {
          headers: { 'X-Qortal-Hub-Wallet-Id': 'other-wallet' },
        })
      ).status
    ).toBe(403);
    expect(f.manager.getHistory).not.toHaveBeenCalled();
  });
  it('applies an exact origin allowlist and supports browser preflight', async () => {
    const f = await fixture();
    expect(
      (
        await f.request('/v1/status', {
          headers: { Origin: 'https://evil.example' },
        })
      ).status
    ).toBe(403);
    const response = await fetch(`${f.base}/v1/status`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://hub.qortal.link' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://hub.qortal.link'
    );
  });
  it('requires the configured account to be active and fails closed on switches and logout', async () => {
    const f = await fixture();
    expect((await f.request('/v1/status')).status).toBe(200);
    for (const addresses of [[OTHER], [], [ADDRESS, OTHER]]) {
      f.switchAccount(addresses);
      expect(
        (await f.request('/v1/groups/716/channels/general/events')).status
      ).toBe(503);
    }
    expect(f.manager.getHistory).not.toHaveBeenCalled();
  });
  it('enforces group and channel access before reading any history', async () => {
    const f = await fixture();
    expect(
      (await f.request('/v1/groups/999/channels/general/events')).status
    ).toBe(403);
    expect(
      (await f.request('/v1/groups/716/channels/admin/events')).status
    ).toBe(403);
    expect(f.manager.getHistory).not.toHaveBeenCalled();
    const response = await f.request(
      '/v1/groups/716/channels/general/events?limit=10&beforeTimestamp=123&beforeEventId=cursor'
    );
    expect(response.status).toBe(200);
    expect(f.manager.getHistory).toHaveBeenCalledWith(716, 'general', 10, {
      beforeTimestamp: 123,
      beforeEventId: 'cursor',
    });
    expect(await response.json()).toEqual({
      events: [{ eventId: 'history-1', encryptedPayload: 'ciphertext' }],
    });
  });
  it.each([
    'limit=0',
    'limit=501',
    'limit=1.2',
    'beforeTimestamp=bad',
    'beforeEventId=',
  ])('validates history pagination: %s', async (query) => {
    const f = await fixture();
    expect(
      (await f.request(`/v1/groups/716/channels/general/events?${query}`))
        .status
    ).toBe(400);
    expect(f.manager.getHistory).not.toHaveBeenCalled();
  });
  it('uses separate permissions for reading and publishing', async () => {
    const f = await fixture();
    expect((await f.request('/v1/status', {}, 'read-only')).status).toBe(200);
    expect(
      (await f.post('/v1/groups/716/sequences', {}, 'read-only')).status
    ).toBe(403);
    expect(f.manager.reserveAuthorSequence).not.toHaveBeenCalled();
  });
  it('publishes through the native manager with a session-bound sequence lease', async () => {
    const f = await fixture();
    expect((await f.post('/v1/groups/716/events', event())).status).toBe(409);
    expect((await f.post('/v1/groups/716/sequences', {})).status).toBe(201);
    expect((await f.post('/v1/groups/716/sequences', {})).status).toBe(409);
    expect(
      (await f.post('/v1/groups/716/events', event(), 'second')).status
    ).toBe(409);
    expect(
      (await f.post('/v1/groups/716/events', event({ authorAddress: OTHER })))
        .status
    ).toBe(403);
    expect(
      (
        await f.post(
          '/v1/groups/716/events',
          event({ authorPublicKey: 'wrong' })
        )
      ).status
    ).toBe(403);
    const response = await f.post('/v1/groups/716/events', event());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      eventId: 'event-1',
    });
    expect(f.manager.publishEvent).toHaveBeenCalledWith(event());
    expect(f.manager.releaseAuthorSequence).toHaveBeenCalledWith(
      716,
      ADDRESS,
      'stream-1',
      1
    );
  });
  it('preserves native signature rejection and releases failed publish reservations', async () => {
    const f = await fixture();
    f.manager.publishEvent.mockResolvedValue({ ok: false });
    await f.post('/v1/groups/716/sequences', {});
    const response = await f.post(
      '/v1/groups/716/events',
      event({ signature: 'invalid' })
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'event_rejected' });
    expect((await f.post('/v1/groups/716/sequences', {})).status).toBe(201);
  });

  it('lets only the reservation owner release the exact reserved sequence', async () => {
    const f = await fixture();
    await f.post('/v1/groups/716/sequences', {});
    const sequence = { authorStreamId: 'stream-1', authorSeq: 1 };
    expect(
      (await f.post('/v1/groups/716/sequences/release', sequence, 'second'))
        .status
    ).toBe(409);
    expect(
      (
        await f.post('/v1/groups/716/sequences/release', {
          ...sequence,
          authorSeq: 2,
        })
      ).status
    ).toBe(409);
    expect(f.manager.releaseAuthorSequence).not.toHaveBeenCalled();
    const response = await f.post('/v1/groups/716/sequences/release', sequence);
    expect(await response.json()).toEqual({ released: true });
    expect(f.manager.releaseAuthorSequence).toHaveBeenCalledOnce();
    expect(
      (await f.post('/v1/groups/716/sequences/release', sequence)).status
    ).toBe(200);
    expect((await f.post('/v1/groups/716/sequences', {})).status).toBe(201);
  });
  it('releases sequences if an account switches during reservation', async () => {
    const f = await fixture();
    f.manager.reserveAuthorSequence.mockImplementation(async () => {
      f.switchAccount([OTHER]);
      return { authorStreamId: 'stream-1', authorSeq: 1 };
    });
    expect((await f.post('/v1/groups/716/sequences', {})).status).toBe(503);
    expect(f.manager.releaseAuthorSequence).toHaveBeenCalledOnce();
  });
  it('rejects oversized bodies and unsupported metadata events', async () => {
    const f = await fixture();
    expect(
      (
        await f.post(
          '/v1/groups/716/events',
          event({ eventType: 'channel_update' })
        )
      ).status
    ).toBe(400);
    const response = await f.post('/v1/groups/716/events', {
      data: 'x'.repeat(300_000),
    });
    expect(response.status).toBe(413);
  });
  it('streams scoped invalidations without transmitting message contents, then cleans up', async () => {
    const f = await fixture();
    const response = await f.request('/v1/groups/716/channels/general/stream');
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      'event: ready'
    );
    f.manager.emit('event', {
      event: event({ encryptedPayload: 'private-message' }),
    });
    const changed = new TextDecoder().decode((await reader.read()).value);
    expect(changed).toContain('event: changed');
    expect(changed).not.toContain('private-message');
    expect(changed).toContain('"groupId":716');
    f.switchAccount([OTHER]);
    f.manager.emit('event', { event: event() });
    expect((await reader.read()).done).toBe(true);
    expect(f.manager.listenerCount('event')).toBe(0);
  });
  it('closes the listener and releases outstanding leases on shutdown', async () => {
    const f = await fixture();
    await f.post('/v1/groups/716/sequences', {});
    await f.api.close();
    running.splice(running.indexOf(f.api), 1);
    expect(f.manager.releaseAuthorSequence).toHaveBeenCalledOnce();
    expect(f.api.server.listening).toBe(false);
  });
});
