import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedClient } from './client';
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

beforeEach(() => {
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
    const client = new HostedClient('ws://localhost/realtime');
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
