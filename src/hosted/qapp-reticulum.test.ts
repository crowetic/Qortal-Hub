import { describe, expect, it, vi } from 'vitest';
import { installHostedQappReticulum } from './qapp-reticulum';

vi.mock('../i18n/i18n', () => ({ default: { t: (key: string) => key } }));

const first = { tabId: '1', service: 'APP', name: 'incident-operations' };
const second = { ...first, tabId: '2' };
const key = (owner: typeof first) =>
  `${owner.tabId}\u0000${owner.service}\u0000${owner.name}`;

function fixture() {
  const handlers = new Map<string, (payload: any) => void>();
  let next = 0;
  const client = {
    state: 'connected' as any,
    on: vi.fn((channel, callback) => {
      handlers.set(channel, callback);
      return () => handlers.delete(channel);
    }),
    rpc: vi.fn(async (channel) =>
      channel === 'qapp:rns:connect'
        ? { connectionId: `rns-${++next}`, state: 'CONNECTED' }
        : { messageId: 'message-1' }
    ),
  };
  const api: Record<string, any> = {};
  installHostedQappReticulum(client, api);
  const event = vi.fn();
  api.onQAppReticulumEvent(event);
  const state = (value: string) => {
    client.state = value;
    handlers.get('state')(value);
  };
  return { api, client, handlers, event, state };
}

describe('Hosted Access Q-App Reticulum lifecycle', () => {
  it('closes every owned logical connection once on socket loss and requires a new connect', async () => {
    const { api, client, event, state } = fixture();
    const a = await api.qappReticulumConnect(first, 'ab'.repeat(16));
    const b = await api.qappReticulumConnect(second, 'ab'.repeat(16));
    state('disconnected');
    state('connecting');
    state('disconnected');
    expect(event).toHaveBeenCalledTimes(2);
    for (const [owner, connection] of [
      [first, a],
      [second, b],
    ])
      expect(event).toHaveBeenCalledWith({
        ownerKey: key(owner),
        connectionId: connection.connectionId,
        action: 'RNS_CONNECTION_STATE',
        state: 'CLOSED',
        reason: 'RNS_TRANSPORT_RESET',
      });
    state('connected');
    // Restoring the hosted socket never silently replays application auth/data.
    expect(client.rpc).toHaveBeenCalledTimes(2);
    const replacement = await api.qappReticulumConnect(first, 'ab'.repeat(16));
    expect(replacement.connectionId).not.toBe(a.connectionId);
    state('idle');
    expect(event).toHaveBeenCalledTimes(3);
  });

  it('does not close a connection already closed remotely or released by its owner', async () => {
    const { api, handlers, event, state } = fixture();
    const a = await api.qappReticulumConnect(first, 'ab'.repeat(16));
    await api.qappReticulumConnect(second, 'ab'.repeat(16));
    handlers.get('qapp:rns')({
      ownerKey: key(first),
      connectionId: a.connectionId,
      action: 'RNS_CONNECTION_STATE',
      state: 'CLOSED',
      reason: 'RNS_PEER_CLOSED',
    });
    await api.qappGuestRelease(second);
    event.mockClear();
    state('idle');
    expect(event).not.toHaveBeenCalled();
  });

  it('rejects a connect reply from a destroyed browser session', async () => {
    const { api, client, state } = fixture();
    let finish: (value: any) => void;
    client.rpc.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const connecting = api.qappReticulumConnect(first, 'ab'.repeat(16));
    const rejected = expect(connecting).rejects.toMatchObject({
      code: 'connection',
    });
    state('disconnected');
    state('connected');
    finish({ connectionId: 'rns-obsolete', state: 'CONNECTED' });
    await rejected;
  });

  it('rejects a connect closed by the peer before its RPC reply arrives', async () => {
    const { api, client, handlers } = fixture();
    client.rpc.mockImplementationOnce(async () => {
      handlers.get('qapp:rns')({
        connectionId: 'rns-closed',
        ownerKey: key(first),
        action: 'RNS_CONNECTION_STATE',
        state: 'CLOSED',
      });
      return { connectionId: 'rns-closed', state: 'CONNECTED' };
    });
    await expect(
      api.qappReticulumConnect(first, 'ab'.repeat(16))
    ).rejects.toMatchObject({
      code: 'connection',
    });
  });

  it('keeps another owner tracked when a forged close fails and isolates listener failures', async () => {
    const { api, event, state, client } = fixture();
    api.onQAppReticulumEvent(() => {
      throw new Error('stale view');
    });
    const a = await api.qappReticulumConnect(first, 'ab'.repeat(16));
    client.rpc.mockRejectedValueOnce(new Error('operation_failed'));
    await expect(
      api.qappReticulumClose(second, a.connectionId)
    ).rejects.toThrow();
    state('disconnected');
    expect(event).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: a.connectionId })
    );
  });

  it('supports an initial lazy socket connection and forwards RPC and message events unchanged', async () => {
    const { api, client, handlers, event, state } = fixture();
    client.state = 'idle';
    client.rpc.mockImplementationOnce(async () => {
      state('connecting');
      state('connected');
      return { connectionId: 'rns-initial', state: 'CONNECTED' };
    });
    await expect(
      api.qappReticulumConnect(first, 'ab'.repeat(16))
    ).resolves.toMatchObject({ connectionId: 'rns-initial' });
    const message = {
      action: 'RNS_MESSAGE',
      ownerKey: key(first),
      connectionId: 'rns-initial',
      payload: { revision: 7 },
    };
    handlers.get('qapp:rns')(message);
    expect(event).toHaveBeenCalledWith(message);
    await api.qappReticulumRequest(first, {
      destination: 'ab'.repeat(16),
      path: '/sync',
    });
    expect(client.rpc).toHaveBeenLastCalledWith('qapp:rns:request', first, {
      destination: 'ab'.repeat(16),
      path: '/sync',
    });
  });
});
