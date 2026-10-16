import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import {
  ReticulumChatManager,
  verifyReticulumChatEvent,
} from '../reticulum-chat';
import { createExternalAuthAuthorizer } from './auth';
import { HubApiRuntime } from './runtime';
import { startHubApi } from './server';

const authRepo = process.env.QORTAL_EXTERNAL_AUTH_REPO;

async function availablePort(): Promise<number> {
  const socket = net.createServer();
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const bound = socket.address();
      if (!bound || typeof bound === 'string') {
        socket.close();
        reject(new Error('No test port'));
        return;
      }
      socket.close(() => resolve(bound.port));
    });
  });
}

// Opt in with the companion checkout: ordinary Hub tests never require another repository.
it.skipIf(!authRepo)(
  'External Auth signs and publishes through Hub with native validation and auth callbacks',
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hub-external-auth-')
    );
    const authPort = await availablePort();
    const hubPort = await availablePort();
    const authUrl = `http://127.0.0.1:${authPort}`;
    const daemon = spawn(
      process.execPath,
      [path.join(authRepo!, 'node_modules/tsx/dist/cli.mjs'), 'src/index.ts'],
      {
        cwd: path.join(authRepo!, 'packages/auth-daemon'),
        env: {
          ...process.env,
          QORTAL_AUTH_HOST: '127.0.0.1',
          QORTAL_AUTH_PORT: String(authPort),
          QORTAL_AUTH_DATA_DIR: path.join(directory, 'auth'),
          QORTAL_AUTH_NODE_URL: 'http://127.0.0.1:1',
          QORTAL_AUTH_HUB_ENABLED: '1',
          QORTAL_AUTH_HUB_URL: `http://127.0.0.1:${hubPort}`,
          QORTAL_AUTH_STORAGE_PASSPHRASE: '',
          QORTAL_AUTH_AUTO_FOREIGN_FEES: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let output = '';
    daemon.stdout.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-8000);
    });
    daemon.stderr.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-8000);
    });
    let api: Awaited<ReturnType<typeof startHubApi>> | undefined;
    let manager: ReticulumChatManager | undefined;
    try {
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (daemon.exitCode !== null) throw new Error(`Auth exited: ${output}`);
        try {
          if ((await fetch(`${authUrl}/health`)).ok) break;
        } catch {
          /* Starting. */
        }
        if (Date.now() > deadline)
          throw new Error(`Auth startup timeout: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const post = async (route: string, body: unknown, token?: string) => {
        const response = await fetch(`${authUrl}${route}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
      };
      const registration = await post('/apps/register', {
        name: 'Hub integration test',
      });
      expect(registration.status).toBe(200);
      const session = await post('/sessions', registration.data);
      const token = session.data.token as string;
      const password = 'test-wallet-password';
      const created = await post('/wallet/create', { password }, token);
      expect(created.status, JSON.stringify(created.data)).toBe(200);
      const wallet = created.data as {
        walletId: string;
        address0: string;
        publicKey: string;
      };

      manager = new ReticulumChatManager({
        dbPath: path.join(directory, 'chat.db'),
        hasGoodOverlayHealth: () => false,
        validateGroupMember: async (groupId, address) =>
          groupId === 716 && address === wallet.address0,
      });
      manager.setLocalDmAddresses([wallet.address0]);
      manager.setLocalGroupMemberships([
        { groupId: 716, localAddress: wallet.address0 },
      ]);
      const runtime = new HubApiRuntime(manager, wallet.address0, () => true);
      const config = {
        host: '127.0.0.1' as const,
        port: hubPort,
        authUrl,
        walletId: wallet.walletId,
        address: wallet.address0,
        groupIds: [716],
        origins: [],
      };
      api = await startHubApi(
        config,
        createExternalAuthAuthorizer(config),
        async () => runtime
      );

      const sendBody = {
        walletId: wallet.walletId,
        groupId: 716,
        message: 'Hello from External Auth 👋',
      };
      expect((await post('/hub/chat/send', sendBody)).status).toBe(401);
      expect((await post('/hub/chat/send', sendBody, token)).status).toBe(403);
      for (const scope of ['QCHAT_READ', 'QCHAT_PUBLISH']) {
        expect(
          (
            await post(
              '/permissions/set',
              {
                walletId: wallet.walletId,
                scope,
                mode: 'session',
                ttlSeconds: 120,
              },
              token
            )
          ).status
        ).toBe(200);
      }
      expect((await post('/hub/chat/send', sendBody, token)).data.error).toBe(
        'wallet_locked'
      );
      const unlocked = await post(
        '/wallet/unlock',
        { walletId: wallet.walletId, password, ttlSeconds: 120 },
        token
      );
      expect(unlocked.status, JSON.stringify(unlocked.data)).toBe(200);

      const sent = await post('/hub/chat/send', sendBody, token);
      expect(sent.status, JSON.stringify(sent.data)).toBe(202);
      expect(sent.data).toMatchObject({
        accepted: true,
        transport: 'hub',
        walletId: wallet.walletId,
      });
      const events = manager.getHistory(716, 'general', 10);
      expect(events).toHaveLength(1);
      expect(events[0].eventId).toBe(sent.data.eventId);
      expect(verifyReticulumChatEvent(events[0])).toBe(true);
      expect(
        JSON.parse(events[0].encryptedPayload).messageText.content[0].content[0]
          .text
      ).toBe(sendBody.message);

      const alias = await post(
        '/qortal/request',
        {
          requestType: 'SEND_CHAT_MESSAGE',
          payload: {
            ...sendBody,
            transport: 'hub',
            message: 'Optional transport selection',
          },
        },
        token
      );
      expect(alias.status, JSON.stringify(alias.data)).toBe(200);
      expect(alias.data.result.accepted).toBe(true);
      expect(manager.getHistory(716, 'general', 10)).toHaveLength(2);

      const history = await post(
        '/qortal/request',
        {
          requestType: 'GET_HUB_CHAT_HISTORY',
          payload: { walletId: wallet.walletId, groupId: 716 },
        },
        token
      );
      expect(history.status, JSON.stringify(history.data)).toBe(200);
      expect(history.data.result.events).toHaveLength(2);
      const status = await fetch(
        `${authUrl}/hub/status?walletId=${wallet.walletId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(status.status).toBe(200);
      expect((await status.json()).walletId).toBe(wallet.walletId);

      await post(
        '/permissions/set',
        { walletId: wallet.walletId, scope: 'QCHAT_PUBLISH', mode: 'ask' },
        token
      );
      expect((await post('/hub/chat/send', sendBody, token)).status).toBe(403);
      expect(manager.getHistory(716, 'general', 10)).toHaveLength(2);
    } finally {
      await api?.close();
      manager?.close();
      if (daemon.exitCode === null && !daemon.signalCode) {
        const stopped = new Promise<void>((resolve) =>
          daemon.once('exit', () => resolve())
        );
        daemon.kill('SIGTERM');
        const kill = setTimeout(() => daemon.kill('SIGKILL'), 3000);
        await stopped;
        clearTimeout(kill);
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  45_000
);
