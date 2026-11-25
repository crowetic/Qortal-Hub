import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { HostedQapps } from '../../daemon/src/hosted/qapps';

const owner = { tabId: '1', name: 'incident-operations', service: 'APP' };
function fixture() {
  const bridge = Object.assign(new EventEmitter(), {
    invokeQAppReticulum: vi.fn(async () => ({ ok: true, payload: {} })),
  });
  const emit = vi.fn();
  const qapps = new HostedQapps(
    {
      bridge,
      config: { resourcesDir: '/unused-test-resources' },
    } as any,
    vi.fn(),
    emit
  );
  return { qapps, bridge, emit };
}

describe('Hosted daemon Q-App lifecycle', () => {
  it.each(['degraded', 'stopped'])(
    'revokes quiet logical IDs on Python %s and cleans dependent transports',
    async (state) => {
      const { qapps, bridge, emit } = fixture();
      const privateCleanup = vi.spyOn(
        qapps.privateChannels,
        'cleanupRnsConnection'
      );
      const moqCleanup = vi.spyOn(qapps.moq, 'cleanupRnsConnection');
      const connection = await qapps.invoke('qapp:rns:connect', [
        owner,
        'ab'.repeat(16),
      ]);
      bridge.emit(state);
      expect(
        qapps.rns.connectionOwnership(owner, connection.connectionId)
      ).toBe('missing');
      expect(emit).toHaveBeenCalledWith('qapp:rns', {
        ownerKey: '1\u0000APP\u0000incident-operations',
        connectionId: connection.connectionId,
        action: 'RNS_CONNECTION_STATE',
        state: 'CLOSED',
        reason: 'RNS_TRANSPORT_RESET',
      });
      expect(privateCleanup).toHaveBeenCalledWith(
        owner,
        connection.connectionId
      );
      expect(moqCleanup).toHaveBeenCalledWith(owner, connection.connectionId);
      await expect(
        qapps.invoke('qapp:rns:send', [owner, connection.connectionId, {}])
      ).rejects.toMatchObject({ code: 'RNS_INVALID_CONNECTION' });
      const replacement = await qapps.invoke('qapp:rns:connect', [
        owner,
        'ab'.repeat(16),
      ]);
      expect(replacement.connectionId).not.toBe(connection.connectionId);
      await qapps.close();
      for (const event of ['qapp-rns', 'stopped', 'degraded'])
        expect(bridge.listenerCount(event)).toBe(0);
    }
  );

  it('rejects control characters that could collide with owner or destination isolation keys', async () => {
    const { qapps, bridge } = fixture();
    for (const field of ['tabId', 'name', 'service']) {
      await expect(
        qapps.invoke('qapp:rns:connect', [
          { ...owner, [field]: 'one\u0000two' },
          'ab'.repeat(16),
        ])
      ).rejects.toThrow('invalid_qapp_owner');
    }
    expect(bridge.invokeQAppReticulum).not.toHaveBeenCalled();
    await qapps.close();
  });
});
