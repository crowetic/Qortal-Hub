const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '..');
const authRepo = process.env.QORTAL_EXTERNAL_AUTH_REPO;
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const n = s.address().port;
  await new Promise((r) => s.close(r));
  return n;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await done;
  clearTimeout(timer);
}
async function ready(child, url, output) {
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Process exited: ${output()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    if (Date.now() > deadline)
      throw new Error(`Startup timed out: ${output()}`);
    await delay(100);
  }
}

test(
  'headless Hub uses real SQLite, External Auth and Python Reticulum to deliver between two accounts',
  { skip: !authRepo, timeout: 180_000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qortal-headless-')
    );
    const authPort = await port(),
      hubPort = await port(),
      rnsPort = await port(),
      controlPort = await port();
    const authUrl = `http://127.0.0.1:${authPort}`,
      hubUrl = `http://127.0.0.1:${hubPort}`;
    const wallets = [];
    const core = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname.startsWith('/groups/member/'))
        res.end(JSON.stringify([{ groupId: 716, isOpen: true }]));
      else if (url.pathname === '/groups/members/716')
        res.end(
          JSON.stringify({
            members: wallets.map((w) => ({
              member: w.address0,
              isAdmin: false,
            })),
          })
        );
      else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise((r) => core.listen(0, '127.0.0.1', r));
    let auth,
      hub,
      authOutput = '',
      hubOutput = '';
    const env = {
      ...process.env,
      DISPLAY: '',
      WAYLAND_DISPLAY: '',
      ELECTRON_RUN_AS_NODE: '',
      QORTAL_HUB_DATA_DIR: path.join(directory, 'hub'),
      QORTAL_HUB_API_PORT: String(hubPort),
      QORTAL_HUB_API_AUTH_URL: authUrl,
      QORTAL_HUB_CORE_URL: `http://127.0.0.1:${core.address().port}`,
      QORTAL_HUB_RNS_PORT: String(rnsPort),
      QORTAL_HUB_RNS_CONTROL_PORT: String(controlPort),
      QORTAL_HUB_CUSTOM_RNS_CONFIG: '1',
    };
    const rnsDir = path.join(env.QORTAL_HUB_DATA_DIR, 'rns');
    fs.mkdirSync(rnsDir, { recursive: true });
    // No public interfaces or discovery: fixture traffic stays on this host.
    fs.writeFileSync(
      path.join(rnsDir, 'config'),
      `[reticulum]\nenable_transport = False\nshare_instance = Yes\nshared_instance_type = tcp\nshared_instance_port = ${rnsPort}\ninstance_control_port = ${controlPort}\ninstance_name = headless-test-${process.pid}\n\n[logging]\nloglevel = 4\n\n[interfaces]\n`
    );
    // Fail immediately if any native dependency tries to load Electron.
    const guard = path.join(directory, 'no-electron.cjs');
    fs.writeFileSync(
      guard,
      `const M=require('node:module'); const load=M._load; M._load=function(id,...args){if(id==='electron')throw new Error('Electron must never load in headless Hub');return load.call(this,id,...args)};`
    );
    const launchHub = () => {
      const child = spawn(
        process.execPath,
        ['--require', guard, path.join(root, 'dist/index.js')],
        { env, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      child.stdout.on('data', (b) => {
        hubOutput = (hubOutput + b).slice(-100_000);
      });
      child.stderr.on('data', (b) => {
        hubOutput = (hubOutput + b).slice(-100_000);
      });
      return child;
    };
    try {
      auth = spawn(
        process.execPath,
        [path.join(authRepo, 'packages/auth-daemon/dist/index.js')],
        {
          cwd: path.join(authRepo, 'packages/auth-daemon'),
          env: {
            ...process.env,
            QORTAL_AUTH_HOST: '127.0.0.1',
            QORTAL_AUTH_PORT: String(authPort),
            QORTAL_AUTH_DATA_DIR: path.join(directory, 'auth'),
            QORTAL_AUTH_NODE_URL: 'http://127.0.0.1:1',
            QORTAL_AUTH_HUB_ENABLED: '1',
            QORTAL_AUTH_HUB_URL: hubUrl,
            QORTAL_AUTH_HUB_TIMEOUT_MS: '20000',
            QORTAL_AUTH_STORAGE_PASSPHRASE: '',
            QORTAL_AUTH_AUTO_FOREIGN_FEES: 'false',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      auth.stdout.on('data', (b) => {
        authOutput = (authOutput + b).slice(-8000);
      });
      auth.stderr.on('data', (b) => {
        authOutput = (authOutput + b).slice(-8000);
      });
      await ready(auth, `${authUrl}/health`, () => authOutput);
      const post = async (route, body, token) => {
        const res = await fetch(`${authUrl}${route}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const data = await res.json();
        assert.ok(
          res.ok,
          `${route} ${res.status}: ${JSON.stringify(data)}\n${hubOutput}`
        );
        return data;
      };
      const app = await post('/apps/register', {
        name: 'Headless integration',
      });
      const { token } = await post('/sessions', app);
      for (let i = 0; i < 2; i++) {
        const wallet = await post(
          '/wallet/create',
          { password: 'headless-test-password' },
          token
        );
        wallets.push(wallet);
        for (const scope of ['QCHAT_READ', 'QCHAT_PUBLISH'])
          await post(
            '/permissions/set',
            {
              walletId: wallet.walletId,
              scope,
              mode: 'session',
              ttlSeconds: 600,
            },
            token
          );
        await post(
          '/wallet/unlock',
          {
            walletId: wallet.walletId,
            password: 'headless-test-password',
            ttlSeconds: 600,
          },
          token
        );
      }
      hub = launchHub();
      await ready(hub, `${hubUrl}/healthz`, () => hubOutput);
      const get = async (route, wallet) => {
        const res = await fetch(
          `${authUrl}${route}${route.includes('?') ? '&' : '?'}walletId=${wallet.walletId}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30_000),
          }
        );
        const data = await res.json();
        assert.ok(
          res.ok,
          `${route} ${res.status}: ${JSON.stringify(data)}\n${hubOutput}`
        );
        return data;
      };
      for (const wallet of wallets) {
        const status = await get('/hub/status', wallet);
        assert.equal(status.backend, 'node');
        assert.equal(status.address, wallet.address0);
        assert.deepEqual(status.groupIds, [716]);
        assert.equal(status.reticulum.state, 'ready');
      }
      let deadline = Date.now() + 45_000;
      for (;;) {
        const statuses = await Promise.all(
          wallets.map((w) => get('/hub/status', w))
        );
        if (statuses.every((s) => s.reticulum.verifiedPeers > 0)) break;
        if (Date.now() > deadline)
          throw new Error(`No verified Reticulum peer\n${hubOutput}`);
        await delay(500);
      }
      const sent = await post(
        '/hub/chat/send',
        {
          walletId: wallets[0].walletId,
          groupId: 716,
          message: 'real headless Reticulum delivery',
        },
        token
      );
      deadline = Date.now() + 45_000;
      for (;;) {
        const history = await get('/hub/chat/history?groupId=716', wallets[1]);
        if (history.events.some((e) => e.eventId === sent.eventId)) break;
        if (Date.now() > deadline)
          throw new Error(`Message did not reach second account\n${hubOutput}`);
        await delay(500);
      }
      // Independent files prove receipt did not come from a shared local chat DB.
      const accounts = fs.readdirSync(
        path.join(env.QORTAL_HUB_DATA_DIR, 'accounts')
      );
      assert.equal(accounts.length, 2);
      for (const id of accounts)
        assert.ok(
          fs.existsSync(
            path.join(env.QORTAL_HUB_DATA_DIR, 'accounts', id, 'chat.db')
          )
        );
      await stop(hub);
      assert.equal(hub.exitCode, 0);
      hub = launchHub();
      await ready(hub, `${hubUrl}/healthz`, () => hubOutput);
      const persisted = await get('/hub/chat/history?groupId=716', wallets[1]);
      assert.ok(persisted.events.some((e) => e.eventId === sent.eventId));
      await post(
        '/permissions/set',
        { walletId: wallets[1].walletId, scope: 'QCHAT_READ', mode: 'ask' },
        token
      );
      const revoked = await fetch(`${hubUrl}/v1/status`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Qortal-Hub-Wallet-Id': wallets[1].walletId,
        },
      });
      assert.equal(revoked.status, 403);
      // Abrupt owner death must not leave the shared RNS listener orphaned.
      const exited = new Promise((resolve) => hub.once('exit', resolve));
      hub.kill('SIGKILL');
      await exited;
      const isListening = () =>
        new Promise((resolve) => {
          const socket = net.createConnection({
            host: '127.0.0.1',
            port: rnsPort,
          });
          socket.once('connect', () => {
            socket.destroy();
            resolve(true);
          });
          socket.once('error', () => {
            socket.destroy();
            resolve(false);
          });
        });
      deadline = Date.now() + 5000;
      while (await isListening()) {
        assert.ok(
          Date.now() < deadline,
          'Orphan rnsd still listening after owner death'
        );
        await delay(100);
      }
      hub = launchHub();
      await ready(hub, `${hubUrl}/healthz`, () => hubOutput);
    } catch (error) {
      fs.writeFileSync(path.join(directory, 'hub-test.log'), hubOutput);
      console.error(`Headless test diagnostics retained at ${directory}`);
      throw error;
    } finally {
      await stop(hub);
      await stop(auth);
      await new Promise((r) => core.close(r));
      if (!fs.existsSync(path.join(directory, 'hub-test.log')))
        fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);
