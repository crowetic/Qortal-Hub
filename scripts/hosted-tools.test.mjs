import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { options, buildHosted } from './build-hosted.mjs';
import {
  checkBackend,
  checkHostedFrontend,
} from './hosted-backend/check-backend.mjs';
import { readSetup } from './configure-hosted.mjs';
import {
  writeHostedDeployment,
  validateIceServers,
} from './hosted-deployment.mjs';
import {
  installBackend,
  parseInstallArgs,
  mergeEnvironment,
} from './hosted-backend/install-backend.mjs';

const root = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-tools-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function buildOptions(extra = []) {
  return options([
    '--origin',
    'https://hub.test',
    '--daemon-url',
    'wss://daemon.test/chat',
    ...extra,
  ]);
}
async function packageFixture(directory, config = buildOptions()) {
  fs.mkdirSync(path.join(directory, 'daemon/dist'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'www'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'daemon/dist/index.js'),
    '// test runtime'
  );
  fs.writeFileSync(
    path.join(directory, 'daemon/package.json'),
    '{"name":"fixture"}\n'
  );
  const metadata = await writeHostedDeployment(directory, config);
  return { config, metadata };
}
function installerOptions(directory, extra = []) {
  return parseInstallArgs([
    '--install-dir',
    path.join(directory, 'install'),
    '--data-dir',
    path.join(directory, 'data'),
    '--env-file',
    path.join(directory, 'config/hosted.env'),
    ...extra,
  ]);
}
function fakeRuntime(directory, packageDir) {
  const calls = [],
    state = { active: false, enabled: false };
  const serviceDir = path.join(directory, 'units');
  return {
    packageDir,
    serviceDir,
    uid: () => 0,
    ready: async () => true,
    calls,
    run(command, args) {
      calls.push([command, ...args]);
      let stdout = '',
        status = 0;
      if (command === 'id')
        stdout = args[0] === '-u' ? '1001\n' : 'qortal-hub\n';
      if (command === 'systemctl') {
        if (args[0] === 'is-active') status = state.active ? 0 : 3;
        if (args[0] === 'is-enabled') status = state.enabled ? 0 : 1;
        if (args[0] === 'restart') state.active = true;
        if (args[0] === 'stop') state.active = false;
        if (args[0] === 'enable') state.enabled = true;
      }
      return { status, stdout };
    },
  };
}

test('split-host output preserves website Origin and uses the daemon hostname/path', async (t) => {
  const directory = fixture(t);
  const { config, metadata } = await packageFixture(directory);
  assert.equal(config.daemonUrl, 'wss://daemon.test/chat');
  assert.equal(
    options(['--origin', 'https://hub.test']).daemonUrl,
    'wss://hub.test/hub-ws'
  );
  const nginx = fs.readFileSync(
    path.join(directory, 'backend/nginx.conf'),
    'utf8'
  );
  assert.match(nginx, /server_name daemon\.test;/);
  assert.match(nginx, /location = \/chat/);
  assert.match(nginx, /Host 127\.0\.0\.1:3193/);
  assert.match(nginx, /Origin \$http_origin/);
  assert.match(nginx, /127\.0\.0\.1:3193\/realtime;/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(directory, 'frontend/nginx.conf'), 'utf8'),
    /proxy_pass/
  );
  assert.match(
    fs.readFileSync(path.join(directory, 'daemon/hosted.env'), 'utf8'),
    /API_ORIGINS=https:\/\/hub\.test/
  );
  assert.ok(metadata.files['daemon/dist/index.js']);
  assert.equal(
    fs.statSync(path.join(directory, 'backend/install-backend.sh')).mode &
      0o777,
    0o755
  );
  assert.match(
    fs.readFileSync(path.join(directory, 'DEPLOY.md'), 'utf8'),
    /sudo \.\/backend\/install-backend\.sh/
  );
});

test('public config refuses mixed content, tokens, injection and malformed ICE', () => {
  for (const url of [
    'ws://daemon.test/chat',
    'wss://user:secret@daemon.test/chat',
    'wss://daemon.test/chat?token=secret',
    'wss://daemon.test/chat#fragment',
    'wss://daemon.test:8443/chat',
    'wss://daemon.test/a;root/evil',
    'wss://daemon.test/\nchat',
  ])
    assert.throws(() => buildOptions(['--daemon-url', url]));
  assert.throws(() => validateIceServers([{ urls: 'https://evil.test' }]));
  assert.throws(() => validateIceServers({ secret: 'not-an-array' }));
  assert.throws(() => buildOptions(['--api-port', '3193']));
  assert.throws(() =>
    options(['--origin', 'https://hub.test', '--daemon-url', 'wss://hub.test/'])
  );
});

test('JSON settings are data, flags override settings, and unknown secret fields are refused', (t) => {
  const directory = fixture(t),
    file = path.join(directory, 'hosted-access.config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      origin: 'https://saved.test',
      daemonUrl: 'wss://saved.test/ws',
      iceServers: [],
    })
  );
  const setup = readSetup(
    ['--origin', 'https://override.test', '--skip-deps'],
    directory
  );
  assert.equal(setup.config.origin, 'https://override.test');
  assert.equal(setup.config.daemonUrl, 'wss://saved.test/ws');
  assert.ok(setup.flags.has('--skip-deps'));
  fs.writeFileSync(
    file,
    JSON.stringify({ applicationSecret: 'should-not-be-here' })
  );
  assert.throws(
    () => readSetup([], directory),
    /Unknown hosted configuration field/
  );
});

test('wrapper help works outside the repository without writing configuration', (t) => {
  const directory = fixture(t);
  const result = spawnSync(
    'bash',
    [path.join(root, 'build-hosted-access.sh'), '--help'],
    { cwd: directory, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--daemon-url/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('generated installer CLI handles --env-file as application data and dry-runs without writes', async (t) => {
  const directory = fixture(t),
    pkg = path.join(directory, 'package');
  await packageFixture(pkg);
  const install = path.join(directory, 'install');
  const envFile = path.join(directory, 'private.env');
  const result = spawnSync(
    'bash',
    [
      path.join(pkg, 'backend/install-backend.sh'),
      '--dry-run',
      '--install-dir',
      install,
      '--data-dir',
      path.join(directory, 'state'),
      '--env-file',
      envFile,
      '--service-name',
      'qortal-hub-fixture-only',
    ],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).envFile, envFile);
  assert.equal(fs.existsSync(install), false);
  assert.equal(fs.existsSync(envFile), false);
});

test('dry-run changes nothing and corrupted packages fail before commands', async (t) => {
  const directory = fixture(t),
    pkg = path.join(directory, 'package');
  await packageFixture(pkg);
  const opts = installerOptions(directory, ['--dry-run']),
    hooks = fakeRuntime(directory, pkg);
  assert.equal((await installBackend(opts, hooks)).action, 'install');
  assert.deepEqual(hooks.calls, []);
  assert.equal(fs.existsSync(opts.installDir), false);
  fs.appendFileSync(path.join(pkg, 'daemon/dist/index.js'), 'tampered');
  await assert.rejects(installBackend(opts, hooks), /checksum mismatch/);
  assert.deepEqual(hooks.calls, []);
});

test('installer preserves config/data and reruns without reinstalling or restarting', async (t) => {
  const directory = fixture(t),
    pkg = path.join(directory, 'package');
  const { metadata } = await packageFixture(pkg);
  const opts = installerOptions(directory),
    hooks = fakeRuntime(directory, pkg);
  const installed = await installBackend(opts, hooks);
  assert.equal(installed.action, 'installed');
  assert.equal(
    fs.realpathSync(path.join(opts.installDir, 'current')),
    path.join(opts.installDir, 'releases', metadata.releaseId)
  );
  fs.appendFileSync(
    opts.envFile,
    'QORTAL_HUB_API_AUTH_URL=http://existing-auth.test\n'
  );
  fs.writeFileSync(path.join(opts.dataDir, 'history.db'), 'persistent-data');
  const before = hooks.calls.length;
  assert.equal((await installBackend(opts, hooks)).action, 'unchanged');
  assert.equal(
    hooks.calls
      .slice(before)
      .some(
        (call) =>
          (call[0] === 'runuser' && call[1] === '-u') || call[1] === 'restart'
      ),
    false
  );
  assert.match(fs.readFileSync(opts.envFile, 'utf8'), /existing-auth\.test/);
  assert.equal(
    fs.readFileSync(path.join(opts.dataDir, 'history.db'), 'utf8'),
    'persistent-data'
  );
  assert.equal(fs.statSync(opts.dataDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(opts.envFile).mode & 0o777, 0o600);
});

test('config replacement is explicit and retains unrelated External Auth settings', () => {
  const original =
    'QORTAL_HUB_BROWSER_ENABLED=0\nQORTAL_HUB_API_AUTH_URL=http://auth.test\n';
  assert.throws(
    () => mergeEnvironment(original, 'QORTAL_HUB_BROWSER_ENABLED=1\n'),
    /--replace-config/
  );
  assert.equal(
    mergeEnvironment(original, 'QORTAL_HUB_BROWSER_ENABLED=1\n', true),
    'QORTAL_HUB_BROWSER_ENABLED=1\nQORTAL_HUB_API_AUTH_URL=http://auth.test\n'
  );
});

test('failed upgrade and manual rollback restore prior code/config and retain data', async (t) => {
  const directory = fixture(t),
    first = path.join(directory, 'first'),
    second = path.join(directory, 'second');
  await packageFixture(first);
  await packageFixture(
    second,
    buildOptions(['--core-url', 'http://new-core.test'])
  );
  const opts = installerOptions(directory),
    hooks = fakeRuntime(directory, first);
  const old = await installBackend(opts, hooks);
  fs.writeFileSync(path.join(opts.dataDir, 'history.db'), 'retained');
  const oldEnv = fs.readFileSync(opts.envFile, 'utf8');
  hooks.packageDir = second;
  const replace = { ...opts, replaceConfig: true };
  hooks.ready = async (target) => target === old.release;
  await assert.rejects(
    installBackend(replace, hooks),
    /previous managed release and config restored/
  );
  assert.equal(
    fs.realpathSync(path.join(opts.installDir, 'current')),
    old.release
  );
  assert.equal(fs.readFileSync(opts.envFile, 'utf8'), oldEnv);
  hooks.ready = async () => true;
  assert.equal((await installBackend(replace, hooks)).action, 'installed');
  assert.match(fs.readFileSync(opts.envFile, 'utf8'), /new-core\.test/);
  assert.equal(
    (await installBackend({ ...opts, rollback: true }, hooks)).action,
    'rolled-back'
  );
  assert.equal(
    fs.realpathSync(path.join(opts.installDir, 'current')),
    old.release
  );
  assert.equal(fs.readFileSync(opts.envFile, 'utf8'), oldEnv);
  assert.equal(
    fs.readFileSync(path.join(opts.dataDir, 'history.db'), 'utf8'),
    'retained'
  );
});

test('unmanaged services and unsafe paths are refused', async (t) => {
  for (const args of [
    ['--install-dir', '/'],
    ['--env-file', '/tmp/../etc/env'],
    ['--user', 'root'],
    ['--service-name', 'bad;command'],
  ])
    assert.throws(() => parseInstallArgs(args));
  const directory = fixture(t),
    pkg = path.join(directory, 'package');
  await packageFixture(pkg);
  const opts = installerOptions(directory),
    hooks = fakeRuntime(directory, pkg);
  fs.mkdirSync(hooks.serviceDir, { recursive: true });
  fs.writeFileSync(
    path.join(hooks.serviceDir, `${opts.serviceName}.service`),
    '# Existing external service\n'
  );
  await assert.rejects(installBackend(opts, hooks), /unmanaged/);
  assert.deepEqual(hooks.calls, []);
});

test('existing output symlinks are refused without changing their target', async (t) => {
  const directory = fixture(t),
    out = path.join(directory, 'package');
  fs.symlinkSync(path.join(directory, 'absent'), out);
  await assert.rejects(
    buildHosted(buildOptions(['--out', out, '--skip-build'])),
    /Output already exists/
  );
  assert.equal(fs.readlinkSync(out), path.join(directory, 'absent'));
});

test('unexpected existing state and disabled browser environments fail before commands', async (t) => {
  const directory = fixture(t),
    pkg = path.join(directory, 'package');
  await packageFixture(pkg);
  const opts = installerOptions(directory, ['--dry-run']),
    hooks = fakeRuntime(directory, pkg);
  fs.mkdirSync(opts.dataDir);
  fs.writeFileSync(
    path.join(opts.dataDir, 'existing-history.db'),
    'unmanaged-data'
  );
  await assert.rejects(installBackend(opts, hooks), /Existing data directory/);
  fs.rmSync(opts.dataDir, { recursive: true });
  const file = path.join(pkg, 'daemon/hosted.env');
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, 'utf8')
      .replace('BROWSER_ENABLED=1', 'BROWSER_ENABLED=0')
  );
  await assert.rejects(installBackend(opts, hooks), /package contract differ/);
  assert.deepEqual(hooks.calls, []);
});

test('public readiness rejects missing or mismatched hosted frontend configuration', async (t) => {
  let status = 404,
    body = '<html>Not found</html>';
  const frontend = http.createServer((_request, response) => {
    response.writeHead(status);
    response.end(body);
  });
  await new Promise((resolve) => frontend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => frontend.close(resolve)));
  const metadata = {
    origin: `http://127.0.0.1:${frontend.address().port}`,
    daemonUrl: 'wss://daemon.test/hub-ws',
  };
  const directory = fixture(t);
  await packageFixture(directory);
  fs.writeFileSync(
    path.join(directory, 'backend/deployment.json'),
    JSON.stringify(metadata)
  );
  // This is the live failure: the daemon can be up while its frontend config
  // is missing. Reject before even trying a WebSocket or loading its module.
  await assert.rejects(
    checkBackend({ directory }),
    /hub-config.json.*HTTP 404/
  );
  status = 200;
  await assert.rejects(checkHostedFrontend(metadata), /not valid JSON/);
  body = JSON.stringify({ version: 2, daemonUrl: metadata.daemonUrl });
  await assert.rejects(
    checkHostedFrontend(metadata),
    /configuration is invalid/
  );
  body = JSON.stringify({ version: 1, daemonUrl: 'not a websocket URL' });
  await assert.rejects(
    checkHostedFrontend(metadata),
    /daemonUrl does not match/
  );
  body = JSON.stringify({
    version: 1,
    daemonUrl: 'wss://secret:password@wrong.test/hub-ws',
  });
  await assert.rejects(checkHostedFrontend(metadata), (error) => {
    assert.match(error.message, /daemonUrl does not match/);
    assert.doesNotMatch(error.message, /secret|password/);
    return true;
  });
  body = JSON.stringify({ version: 1, daemonUrl: metadata.daemonUrl });
  assert.deepEqual(await checkHostedFrontend(metadata), {
    configUrl: `${metadata.origin}/hub-config.json`,
    daemonUrl: metadata.daemonUrl,
  });
});

test('readiness probe checks real HTTP identity and Origin-bound WebSocket challenge', async (t) => {
  const directory = fixture(t);
  const { WebSocketServer } = createRequire(
    path.join(root, 'daemon/package.json')
  )('ws');
  let healthy = true;
  const api = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({ service: healthy ? 'qortal-hub-api' : 'wrong-service' })
    );
  });
  const server = http.createServer();
  const ws = new WebSocketServer({
    server,
    verifyClient: (info, done) => done(info.origin === 'https://hub.test', 403),
  });
  ws.on('connection', (socket) =>
    socket.send(
      JSON.stringify({
        type: 'challenge',
        origin: 'https://hub.test',
        nonce: 'a'.repeat(43),
      })
    )
  );
  await Promise.all([
    new Promise((r) => api.listen(0, '127.0.0.1', r)),
    new Promise((r) => server.listen(0, '127.0.0.1', r)),
  ]);
  t.after(async () => {
    for (const client of ws.clients) client.terminate();
    await Promise.all([
      new Promise((r) => api.close(r)),
      new Promise((r) => ws.close(r)),
      new Promise((r) => server.close(r)),
    ]);
  });
  await packageFixture(
    directory,
    buildOptions([
      '--api-port',
      String(api.address().port),
      '--daemon-port',
      String(server.address().port),
    ])
  );
  fs.symlinkSync(
    path.join(root, 'daemon/node_modules'),
    path.join(directory, 'daemon/node_modules'),
    'dir'
  );
  assert.equal((await checkBackend({ directory, local: true })).ready, true);
  const publicMetadataFile = path.join(directory, 'backend/deployment.json');
  const publicMetadata = JSON.parse(
    fs.readFileSync(publicMetadataFile, 'utf8')
  );
  publicMetadata.daemonUrl = `ws://127.0.0.1:${server.address().port}/realtime`;
  fs.writeFileSync(publicMetadataFile, JSON.stringify(publicMetadata));
  assert.equal(
    (await checkBackend({ directory, backendOnly: true })).frontend,
    null
  );
  healthy = false;
  await assert.rejects(
    checkBackend({ directory, local: true }),
    /HTTP health check failed/
  );
  healthy = true;
  const file = path.join(directory, 'backend/deployment.json'),
    metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  metadata.origin = 'https://unapproved.test';
  fs.writeFileSync(file, JSON.stringify(metadata));
  await assert.rejects(checkBackend({ directory, local: true }), /HTTP 403/);
});
