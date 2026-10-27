import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nuqloudAccount } from '../../../daemon/src/nuqloud';
import {
  uploadsFor,
  closeNuqloudUploads,
} from '../../../daemon/src/nuqloud-resources';
import { startHubApi } from './server';
import { HubApiError } from './auth';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'hub-ui-api-'));
  directories.push(directory);
  const manager = Object.assign(new EventEmitter(), {
    getMessageHistoryPage: () => ({
      events: [{ eventId: 'owned-history' }],
      hasMore: false,
    }),
    getChannelMetadataBundle: () => ({
      channels: [{ channelId: 'general' }],
      categories: [],
    }),
  });
  const state = { readable: true };
  const worker: any = {
    active: true,
    principal: { address: 'Q-owned', publicKey: 'owned-key' },
    groupIds: [716],
    manager,
    bridge: { getState: () => 'ready' },
    runtime: {
      assertAccount: () => {},
      assertChannel: (groupId: number, channel: string) => {
        if (!state.readable || groupId !== 716 || channel !== 'general')
          throw new Error('denied');
      },
    },
  };
  return {
    state,
    manager,
    worker,
    directory,
    api: nuqloudAccount(worker, directory),
  };
}
describe('NuQloud account-bound native chat transport', () => {
  it('uses the existing worker and refuses arbitrary RPC and foreign memberships', async () => {
    const f = fixture();
    expect(
      await f.api.request({
        method: 'getMessageHistoryPage',
        args: [716, 'general', 500],
      })
    ).toEqual({ events: [{ eventId: 'owned-history' }], hasMore: false });
    await expect(
      f.api.request({ method: 'publishEvent', args: [{}] })
    ).rejects.toThrow('chat_method_not_allowed');
    await expect(
      f.api.request({ method: 'getChannelMetadataBundle', args: [717] })
    ).rejects.toThrow('chat_operation_refused');
    await expect(
      f.api.request({ method: '__proto__', args: [] })
    ).rejects.toThrow('chat_method_not_allowed');
    await expect(
      f.api.request({
        method: 'getMessageHistoryPage',
        args: [716, 'private', 20],
      })
    ).rejects.toThrow('denied');
  });
  it('filters queued events against current channel access, including revocation', async () => {
    const f = fixture();
    f.manager.emit('event', {
      event: { eventId: 'allowed', groupId: 716, channelId: 'general' },
    });
    f.manager.emit('event', {
      event: { eventId: 'foreign', groupId: 717, channelId: 'general' },
    });
    const initial: any = await f.api.request({ method: 'poll', args: [0] });
    expect(
      initial.events.map((item: any) => item.payload.event.eventId)
    ).toEqual(['allowed']);
    f.state.readable = false;
    expect(
      ((await f.api.request({ method: 'poll', args: [0] })) as any).events
    ).toEqual([]);
    await expect(f.api.request({ method: 'poll', args: [-1] })).rejects.toThrow(
      'invalid_cursor'
    );
  });
  it('serves only bounded build assets and refuses traversal and symlink escapes', async () => {
    const f = fixture();
    writeFileSync(path.join(f.directory, 'index.html'), '<main>Q-Chat</main>');
    mkdirSync(path.join(f.directory, 'assets'));
    const asset: any = await f.api.asset('index.html');
    expect(Buffer.from(asset.data, 'base64').toString()).toBe(
      '<main>Q-Chat</main>'
    );
    expect(asset.contentType).toBe('text/html');
    await expect(f.api.asset('../index.html')).rejects.toThrow(
      'invalid_chat_asset'
    );
    await expect(f.api.asset('assets/source.js.map')).rejects.toThrow(
      'invalid_chat_asset'
    );
    symlinkSync('/etc/passwd', path.join(f.directory, 'assets/escape.js'));
    await expect(f.api.asset('assets/escape.js')).rejects.toThrow(
      'chat_ui_build_required'
    );
  });
  it('retains a bounded change queue and signals history repair after overflow', async () => {
    const f = fixture();
    for (let i = 0; i < 300; i++)
      f.manager.emit('event', {
        event: { eventId: String(i), groupId: 716, channelId: 'general' },
      });
    const page: any = await f.api.request({ method: 'poll', args: [0] });
    expect(page.resync).toBe(true);
    expect(page.events.length).toBe(256);
    expect(page.cursor).toBe(300);
  });
  it('does not trust a peer manifest ownerId as authority to read cached private bytes', async () => {
    const f = fixture();
    f.worker.resources = {
      getManifest: () => ({ ownerId: '716:Q-owned' }),
      listGroupReferences: () => [],
    };
    await expect(
      f.api.request({ method: 'resource:read', args: ['a'.repeat(64), 0, 64] })
    ).rejects.toThrow('resource_access_denied');
  });
  it('bounds concurrent uploads before filesystem awaits and cleans abandoned files on close', async () => {
    const f = fixture();
    f.worker.config = { dataDir: f.directory };
    const store = uploadsFor(f.worker);
    const meta = {
      size: 2,
      namespace: 'reticulum-group-resource',
      ownerId: '716:Q-owned',
      fileName: 'test.txt',
      mimeType: 'text/plain',
      metadata: { groupId: 716 },
    };
    const starts = await Promise.allSettled(
      Array.from({ length: 3 }, () => store.invoke('upload:begin', [meta]))
    );
    expect(starts.filter((item) => item.status === 'fulfilled')).toHaveLength(
      2
    );
    expect(starts.filter((item) => item.status === 'rejected')).toHaveLength(1);
    await expect(
      store.invoke('upload:begin', [{ ...meta, ownerId: '716:Q-other' }])
    ).rejects.toThrow('invalid_chat_upload');
    await closeNuqloudUploads(f.worker);
    await expect(store.invoke('upload:begin', [meta])).rejects.toThrow(
      'chat_upload_expired'
    );
  });
  it('requires publish scope for uploads even when the caller uses the read endpoint', async () => {
    const f = fixture();
    const config: any = {
      host: '127.0.0.1',
      port: 0,
      authUrl: 'http://auth.test',
      walletId: 'owned',
      address: 'Q-owned',
      groupIds: [716],
      origins: [],
    };
    const scopes: string[] = [];
    let calls = 0;
    const api = await startHubApi(
      config,
      async () => {
        throw new Error();
      },
      async () => f.worker.runtime,
      async (_token, _walletId, scope) => {
        scopes.push(scope);
        if (scope === 'QCHAT_PUBLISH')
          throw new HubApiError(403, 'scope_required');
        return {
          config,
          principal: f.worker.principal,
          runtime: f.worker.runtime,
          nuqloud: {
            available: true,
            asset: async () => ({}),
            request: async () => {
              calls++;
              return {};
            },
          },
        };
      }
    );
    try {
      const address: any = api.server.address();
      const request = (route: string, method: string) =>
        fetch(`http://127.0.0.1:${address.port}/v1/nuqloud/${route}`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-token',
            'X-Qortal-Hub-Wallet-Id': 'owned',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ method, args: [] }),
        });
      expect((await request('read', 'poll')).status).toBe(200);
      expect((await request('read', 'upload:begin')).status).toBe(403);
      expect((await request('write', 'upload:begin')).status).toBe(403);
      expect(calls).toBe(1);
      expect(scopes).toEqual(['QCHAT_READ', 'QCHAT_READ', 'QCHAT_PUBLISH']);
    } finally {
      await api.close();
    }
  });
});
