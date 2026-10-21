import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedClient } from './client';
import { HostedRequestError } from './errors';
import { encodeWire, decodeWire } from './wire';
import { validateHostedConfig } from './bootstrap';
import { sendMessageBackground } from '../messaging/MessagesToBackground';

vi.mock('../i18n/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('../messaging/MessagesToBackground', () => ({
  sendMessageBackground: vi.fn(),
}));

class Socket extends EventTarget {
  static OPEN = 1;
  static latest: Socket;
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  constructor(public url: string) {
    super();
    Socket.latest = this;
  }
  send(data: string) {
    this.sent.push(decodeWire(data));
  }
  receive(data: any) {
    this.dispatchEvent(new MessageEvent('message', { data: encodeWire(data) }));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const clients: HostedClient[] = [];
const makeClient = () => {
  const client = new HostedClient('ws://localhost/realtime');
  clients.push(client);
  return client;
};
async function authenticate(client: HostedClient) {
  const ready = client.connect();
  await tick();
  const socket = Socket.latest;
  socket.receive({
    type: 'challenge',
    origin: location.origin,
    nonce: 'a'.repeat(43),
  });
  await tick();
  socket.receive({ type: 'ready', address: 'Qwallet' });
  await ready;
  return socket;
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.disconnect());
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  Socket.latest = undefined;
  vi.stubGlobal('WebSocket', Socket);
  const storage = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  vi.mocked(sendMessageBackground).mockImplementation(async (action) =>
    action === 'userInfo'
      ? { address: 'Qwallet', publicKey: 'wallet-public-key' }
      : {
          signature: 'signed',
          authorAddress: 'Qwallet',
          authorPublicKey: 'wallet-public-key',
        }
  );
});

describe('hosted browser transport', () => {
  it('uses the normal background wallet for the origin-bound proof, RPC and restricted control signing', async () => {
    const client = makeClient();
    const result = client.rpc('reticulumChat:getSubscriptions');
    await tick();
    const socket = Socket.latest;
    socket.receive({
      type: 'challenge',
      origin: location.origin,
      nonce: 'a'.repeat(43),
    });
    await tick();
    expect(socket.sent[0]).toMatchObject({
      type: 'authenticate',
      address: 'Qwallet',
      signature: 'signed',
      origin: location.origin,
    });
    expect(sendMessageBackground).toHaveBeenCalledWith(
      'signPresenceMessage',
      expect.objectContaining({ type: 'HUB_BROWSER_SESSION' }),
      10000,
      false,
      undefined
    );
    socket.receive({ type: 'ready', address: 'Qwallet' });
    await tick();
    const request = socket.sent.find((item) => item.type === 'rpc');
    socket.receive({ type: 'result', id: request.id, result: [716] });
    expect(await result).toEqual([716]);
    socket.receive({
      type: 'sign',
      id: 'sync',
      kind: 'chat',
      fields: { type: 'RCHAT_DM_PROBE' },
    });
    await tick();
    expect(socket.sent[socket.sent.length - 1]).toMatchObject({
      type: 'signed',
      id: 'sync',
      result: { signature: 'signed' },
    });
    socket.receive({
      type: 'sign',
      id: 'transaction',
      kind: 'presence',
      fields: { type: 'PAYMENT' },
    });
    await tick();
    expect(socket.sent[socket.sent.length - 1]).toMatchObject({
      id: 'transaction',
      error: 'signing_failed',
    });
    client.disconnect();
    expect(client.state).toBe('idle');
  });
  it('queues a login burst larger than the former 128 request limit without exceeding daemon concurrency', async () => {
    const client = makeClient();
    const socket = await authenticate(client);
    const completed = Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        client.rpc('reticulumChat:getSummary', index)
      )
    );
    await tick();
    expect(socket.sent.filter((frame) => frame.type === 'rpc')).toHaveLength(
      16
    );
    for (let index = 0; index < 200; index++) {
      const frames = socket.sent.filter((frame) => frame.type === 'rpc');
      expect(frames.length - index).toBeLessThanOrEqual(16);
      expect(frames[index]).toBeDefined();
      socket.receive({ type: 'result', id: frames[index].id, result: index });
    }
    expect(await completed).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });
  it.each(['reticulumChat:sendTyping', 'reticulumChat:sendDirectTyping'])(
    'drops stale %s notifications without connecting or rejecting fire-and-forget callers',
    async (channel) => {
      const client = makeClient();
      const errors = vi.fn();
      client.on('request-error', errors);
      expect(
        await client.rpc(channel, 716, 'general', 'Qwallet', true)
      ).toEqual({ success: false });
      expect(Socket.latest).toBeUndefined();
      const socket = await authenticate(client);
      const results = Promise.all(
        Array.from({ length: 200 }, () =>
          client.rpc(channel, 716, 'general', 'Qwallet', true)
        )
      );
      await tick();
      expect(socket.sent.filter((frame) => frame.type === 'rpc')).toHaveLength(
        16
      );
      socket.close();
      expect((await results).every((result) => result.success === false)).toBe(
        true
      );
      expect(errors).not.toHaveBeenCalled();
    }
  );
  it('waits for the WebSocket send buffer to drain', async () => {
    const client = makeClient();
    const socket = await authenticate(client);
    vi.useFakeTimers();
    socket.bufferedAmount = 5 * 1024 * 1024;
    const result = client.rpc('reticulumChat:getSubscriptions');
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent.some((frame) => frame.type === 'rpc')).toBe(false);
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(25);
    const request = socket.sent.find((frame) => frame.type === 'rpc');
    socket.receive({ type: 'result', id: request.id, result: [716] });
    expect(await result).toEqual([716]);
  });
  it('keeps the waiting queue bounded and reports overload without flooding the daemon', async () => {
    const client = makeClient();
    const socket = await authenticate(client);
    const errors = vi.fn();
    client.on('request-error', errors);
    const results = Promise.allSettled(
      Array.from({ length: 513 }, () => client.rpc('reticulumChat:getHistory'))
    );
    await tick();
    expect(socket.sent.filter((frame) => frame.type === 'rpc')).toHaveLength(
      16
    );
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'busy' })
    );
    socket.close();
    const settled = await results;
    expect(
      settled.filter(
        (result) =>
          result.status === 'rejected' && result.reason.code === 'busy'
      )
    ).toHaveLength(1);
  });
  it('cancels an expired queued mutation instead of sending it later', async () => {
    const client = makeClient();
    const socket = await authenticate(client);
    vi.useFakeTimers();
    socket.bufferedAmount = 5 * 1024 * 1024;
    const result = client
      .rpc('reticulumChat:sendEvent', { eventId: 'unsent' })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await result).toMatchObject({ code: 'timeout' });
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.sent.some((frame) => frame.type === 'rpc')).toBe(false);
  });
  it('rejects queued and in-flight requests on disconnect without replaying mutations after reconnect', async () => {
    const client = makeClient();
    const socket = await authenticate(client);
    const results = Promise.allSettled(
      Array.from({ length: 20 }, (_, id) =>
        client.rpc('reticulumChat:sendEvent', { id })
      )
    );
    await tick();
    expect(socket.sent.filter((frame) => frame.type === 'rpc')).toHaveLength(
      16
    );
    socket.close();
    const failures = await results;
    expect(
      failures.every(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof HostedRequestError
      )
    ).toBe(true);
    const replacement = await authenticate(client);
    expect(replacement.sent.some((frame) => frame.type === 'rpc')).toBe(false);
  });
  it('surfaces operation failures separately from a dropped connection', async () => {
    const client = makeClient();
    const socket = await authenticate(client);
    const errors = vi.fn();
    client.on('request-error', errors);
    const result = client
      .rpc('reticulumChat:sendEvent', {})
      .catch((error) => error);
    await tick();
    const frame = socket.sent.find((frame) => frame.type === 'rpc');
    socket.receive({ type: 'result', id: frame.id, error: 'operation_failed' });
    expect(await result).toMatchObject({
      code: 'operation',
      channel: 'reticulumChat:sendEvent',
    });
    expect(errors).toHaveBeenCalledOnce();
    expect(client.state).toBe('connected');
  });
  it('does not let a pre-logout wallet lookup replace a new connection', async () => {
    const client = makeClient();
    let resolveOld: (value: any) => void;
    vi.mocked(sendMessageBackground).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    const old = client.connect().catch((error) => error);
    client.disconnect();
    const socket = await authenticate(client);
    resolveOld({ address: 'Qold', publicKey: 'old-key' });
    expect(await old).toBeInstanceOf(HostedRequestError);
    expect(Socket.latest).toBe(socket);
    expect(client.state).toBe('connected');
  });
  it('stays idle before wallet login and can authenticate when the wallet becomes available', async () => {
    const client = makeClient();
    vi.mocked(sendMessageBackground).mockResolvedValueOnce(undefined);
    await expect(client.connect()).rejects.toBeInstanceOf(HostedRequestError);
    await tick();
    expect(client.state).toBe('idle');
    expect(Socket.latest).toBeUndefined();
    await authenticate(client);
    expect(client.state).toBe('connected');
  });
  it('does not carry a request across logout into a replacement session', async () => {
    const client = makeClient();
    const oldSocket = await authenticate(client);
    const notices = vi.fn();
    client.on('request-error', notices);
    const oldRequest = client
      .rpc('reticulumChat:sendEvent', { authorAddress: 'Qwallet' })
      .catch((error) => error);
    client.disconnect();
    const newSocket = await authenticate(client);
    expect(await oldRequest).toBeInstanceOf(HostedRequestError);
    expect(oldSocket.sent.some((frame) => frame.type === 'rpc')).toBe(false);
    expect(newSocket.sent.some((frame) => frame.type === 'rpc')).toBe(false);
    expect(notices).not.toHaveBeenCalled();
  });
  it('preserves encrypted binary media and rejects prototype keys', () => {
    const data = new Uint8Array([0, 1, 128, 255]);
    expect(decodeWire(encodeWire({ data })).data).toEqual(data);
    expect([...decodeWire(encodeWire([undefined, null]))]).toEqual([
      undefined,
      null,
    ]);
    expect(() => decodeWire('{"__proto__":{}}')).toThrow();
  });
  it('rejects credentials, insecure mixed content, query tokens and malformed ICE config', () => {
    for (const daemonUrl of [
      'ws://hub.test/ws',
      'wss://secret:pass@hub.test/ws',
      'wss://hub.test/ws?token=secret',
    ])
      expect(() =>
        validateHostedConfig({ version: 1, daemonUrl }, 'https://hub.test')
      ).toThrow();
    expect(() =>
      validateHostedConfig(
        {
          version: 1,
          daemonUrl: 'wss://hub.test/ws',
          iceServers: [{ urls: 'https://bad' }],
        },
        'https://hub.test'
      )
    ).toThrow();
    expect(
      validateHostedConfig(
        { version: 1, daemonUrl: 'wss://hub.test/ws' },
        'https://hub.test'
      ).daemonUrl
    ).toBe('wss://hub.test/ws');
  });
});
