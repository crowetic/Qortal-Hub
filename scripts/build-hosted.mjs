#!/usr/bin/env node
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function options(argv) {
  const result = {
    out: path.join(root, '.artifacts/hosted-hub'),
    daemonPort: 3193,
    apiPort: 3192,
    coreUrl: 'http://127.0.0.1:12391',
    skipBuild: false,
  };
  const keys = {
    '--origin': 'origin',
    '--out': 'out',
    '--daemon-port': 'daemonPort',
    '--api-port': 'apiPort',
    '--core-url': 'coreUrl',
    '--ice-servers': 'iceFile',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-build') result.skipBuild = true;
    else if (keys[argv[i]] && argv[i + 1] && !argv[i + 1].startsWith('--'))
      result[keys[argv[i]]] = argv[++i];
    else throw new Error(`Unknown or incomplete option: ${argv[i]}`);
  }
  const origin = new URL(result.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== result.origin ||
    origin.username ||
    origin.password ||
    origin.port
  )
    throw new Error(
      '--origin must be an HTTPS origin on port 443, e.g. https://hub.example.org'
    );
  if (!/^[a-zA-Z0-9.-]+$/.test(origin.hostname))
    throw new Error('Invalid hosted hostname');
  const core = new URL(result.coreUrl);
  if (
    !['http:', 'https:'].includes(core.protocol) ||
    core.origin !== result.coreUrl ||
    core.username ||
    core.password
  )
    throw new Error('--core-url must be an HTTP(S) origin');
  for (const key of ['daemonPort', 'apiPort']) {
    result[key] = Number(result[key]);
    if (
      !Number.isSafeInteger(result[key]) ||
      result[key] < 1024 ||
      result[key] > 65535
    )
      throw new Error(`Invalid ${key}`);
  }
  if (result.daemonPort === result.apiPort)
    throw new Error('Daemon browser and REST ports must differ');
  result.out = path.resolve(result.out);
  if (
    result.out === root ||
    (!result.out.startsWith(root + path.sep) &&
      result.out === path.parse(result.out).root)
  )
    throw new Error('Unsafe output directory');
  return { ...result, hostname: origin.hostname };
}

function run(args, cwd = root) {
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    { cwd, stdio: 'inherit' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`npm ${args.join(' ')} failed (${result.status})`);
}

export async function buildHosted(config) {
  // Never remove an existing deployment or follow an output symlink.
  if (existsSync(config.out))
    throw new Error(
      `Output already exists: ${config.out}. Choose a new --out directory.`
    );
  let iceServers = [];
  if (config.iceFile) {
    iceServers = JSON.parse(await readFile(config.iceFile, 'utf8'));
    if (
      !Array.isArray(iceServers) ||
      iceServers.length > 16 ||
      iceServers.some(
        (entry) =>
          !entry ||
          !entry.urls ||
          (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some(
            (url) =>
              typeof url !== 'string' || !/^(stun|stuns|turn|turns):/.test(url)
          )
      )
    )
      throw new Error(
        '--ice-servers must contain a JSON array of RTCIceServer entries'
      );
  }
  if (!config.skipBuild) {
    run(['run', 'build']);
    const sidecar = spawnSync(
      process.execPath,
      ['electron/scripts/build-private-transport.mjs'],
      { cwd: root, stdio: 'inherit' }
    );
    if (sidecar.error) throw sidecar.error;
    if (sidecar.status !== 0)
      throw new Error(
        'Private transport build failed; install Go 1.26+ or Docker, or set QORTAL_GO_BINARY'
      );
    run(['run', 'build'], path.join(root, 'daemon'));
  }
  for (const file of ['dist/index.html', 'daemon/dist/index.js'])
    if (!(await stat(path.join(root, file))).isFile())
      throw new Error(`Missing build: ${file}`);
  const nativeBinary = path.join(
    root,
    'daemon/dist/resources/private-transport',
    `${process.platform}-${process.arch}`,
    `qortal-private-transport${process.platform === 'win32' ? '.exe' : ''}`
  );
  if (!existsSync(nativeBinary))
    throw new Error(
      'Private transport binary missing; run the full hosted build first'
    );
  await mkdir(path.dirname(config.out), { recursive: true });
  const temp = await mkdtemp(
    path.join(path.dirname(config.out), '.hosted-build-')
  );
  try {
    await cp(path.join(root, 'dist'), path.join(temp, 'www'), {
      recursive: true,
    });
    // Runtime configuration must never be in the service worker's immutable precache.
    await writeFile(
      path.join(temp, 'www/hub-config.json'),
      JSON.stringify(
        {
          version: 1,
          daemonUrl: `wss://${config.hostname}/hub-ws`,
          iceServers,
        },
        null,
        2
      ) + '\n'
    );
    await mkdir(path.join(temp, 'daemon/scripts'), { recursive: true });
    await cp(path.join(root, 'daemon/dist'), path.join(temp, 'daemon/dist'), {
      recursive: true,
    });
    for (const name of ['package.json', 'package-lock.json'])
      await cp(
        path.join(root, 'daemon', name),
        path.join(temp, 'daemon', name)
      );
    await cp(
      path.join(root, 'daemon/scripts/setup-reticulum.mjs'),
      path.join(temp, 'daemon/scripts/setup-reticulum.mjs')
    );
    const env = `QORTAL_HUB_BROWSER_ENABLED=1\nQORTAL_HUB_BROWSER_PORT=${config.daemonPort}\nQORTAL_HUB_API_PORT=${config.apiPort}\nQORTAL_HUB_API_ORIGINS=${config.origin}\nQORTAL_HUB_CORE_URL=${config.coreUrl}\n`;
    await writeFile(path.join(temp, 'daemon/hosted.env'), env, { mode: 0o600 });
    await writeFile(
      path.join(temp, 'nginx.conf'),
      `# Install inside nginx's http context. Adjust root and certificate paths.\nserver {\n  listen 443 ssl;\n  server_name ${config.hostname};\n  ssl_certificate /etc/letsencrypt/live/${config.hostname}/fullchain.pem;\n  ssl_certificate_key /etc/letsencrypt/live/${config.hostname}/privkey.pem;\n  root /srv/qortal-hub/www;\n  index index.html;\n  add_header Cross-Origin-Opener-Policy same-origin always;\n  add_header Cross-Origin-Embedder-Policy credentialless always;\n  add_header X-Content-Type-Options nosniff always;\n  add_header Referrer-Policy no-referrer always;\n  location = /hub-ws {\n    proxy_pass http://127.0.0.1:${config.daemonPort}/realtime;\n    proxy_http_version 1.1;\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";\n    proxy_set_header Host 127.0.0.1:${config.daemonPort};\n    proxy_set_header Origin $http_origin;\n    proxy_read_timeout 90s;\n    proxy_send_timeout 90s;\n    proxy_buffering off;\n    access_log off; # One-use Land transport tickets must not enter access logs.\n  }\n  location = /hub-config.json {\n    add_header Cache-Control "no-store";\n    try_files $uri =404;\n  }\n  location / { try_files $uri $uri/ /index.html; }\n}\n`
    );
    await writeFile(
      path.join(temp, 'qortal-hub-hosted.service'),
      `[Unit]\nDescription=Qortal Hub hosted real-time daemon\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=/srv/qortal-hub/daemon\nEnvironmentFile=/srv/qortal-hub/daemon/hosted.env\nExecStart=/usr/bin/env node /srv/qortal-hub/daemon/dist/index.js\nRestart=on-failure\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`
    );
    await writeFile(
      path.join(temp, 'DEPLOY.txt'),
      `Qortal Hub hosted access\n\nThis package uses the normal Hub login/wallet in the browser. External Auth is\noptional and is not needed by browser users. Private wallet keys stay in the\nbrowser. The daemon supplies real-time transport and per-wallet storage.\n\n1. Copy this directory to /srv/qortal-hub (or change paths in the templates).\n   Serve only www/ as the web root. Keep daemon/, hosted.env and storage private.\n2. Install Node >=22.12, Python >=3.9, python3-venv and Git. In daemon/ run:\n     npm ci --omit=dev\n     npm run setup:reticulum\n3. Review daemon/hosted.env. Core must be reachable from the daemon. The two\n   daemon ports bind only to loopback. Use different data directories and\n   Reticulum ports if running more than one daemon on the same machine.\n4. Start in the foreground to test:\n     cd /srv/qortal-hub/daemon\n     set -a\n     . ./hosted.env\n     set +a\n     npm start\n   Or install qortal-hub-hosted.service as a user service, adjust Node/PATH, then\n   run systemctl --user enable --now qortal-hub-hosted.service. Use loginctl\n   enable-linger for unattended user services. Do not start both instances.\n5. Adapt nginx.conf to your existing HTTPS server and certificate paths, run\n   nginx -t, then reload nginx. Preserve the Host rewrite, Origin, WebSocket\n   upgrades, no-store runtime config, and cross-origin isolation headers.\n6. Visit ${config.origin}, log in normally, and test between two wallets.\n\n${iceServers.length ? 'The public ICE configuration is included in www/hub-config.json.\n' : 'No ICE servers were specified. Add public STUN / short-lived TURN credentials\nto hub-config.json for WebRTC connections across NATs. Reticulum audio remains\navailable through the daemon. Never put an External Auth app secret here.\n'}\nSee docs/hosted-access.md in the source repository for architecture, feature\ncoverage, testing, scaling and browser constraints. No services were changed\nby the build script. Existing External Auth settings remain independent.\n`
    );
    await rename(temp, config.out);
    console.log(
      `Hosted package ready: ${config.out}\nWeb root: ${path.join(config.out, 'www')}\nRead DEPLOY.txt before deployment.`
    );
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes('--help'))
    console.log(
      'npm run build:hosted -- --origin https://hub.example.org [--out DIR] [--daemon-port 3193] [--api-port 3192] [--core-url http://127.0.0.1:12391] [--ice-servers FILE] [--skip-build]'
    );
  else await buildHosted(options(process.argv.slice(2)));
}
