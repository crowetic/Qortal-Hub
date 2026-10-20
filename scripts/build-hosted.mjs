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
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateIceServers,
  writeHostedDeployment,
} from './hosted-deployment.mjs';

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
    '--daemon-url': 'daemonUrl',
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
  result.daemonUrl ||= `wss://${origin.hostname}/hub-ws`;
  const daemon = new URL(result.daemonUrl);
  if (
    daemon.protocol !== 'wss:' ||
    daemon.username ||
    daemon.password ||
    daemon.search ||
    daemon.hash ||
    daemon.port ||
    [...result.daemonUrl].some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127
    ) ||
    !/^[a-zA-Z0-9.-]+$/.test(daemon.hostname) ||
    !/^\/[a-zA-Z0-9/_-]*$/.test(daemon.pathname)
  )
    throw new Error(
      '--daemon-url must be a WSS URL on port 443 with a plain path and no credentials, query or fragment'
    );
  result.daemonUrl = daemon.href;
  if (daemon.hostname === origin.hostname && daemon.pathname === '/')
    throw new Error(
      'A combined host needs a separate WebSocket path, such as /hub-ws'
    );
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
  if (lstatSync(config.out, { throwIfNoEntry: false }))
    throw new Error(
      `Output already exists: ${config.out}. Choose a new --out directory.`
    );
  let iceServers = config.iceServers === undefined ? [] : config.iceServers;
  if (config.iceFile) {
    iceServers = JSON.parse(await readFile(config.iceFile, 'utf8'));
  }
  validateIceServers(iceServers);
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
          daemonUrl: config.daemonUrl,
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
    await writeHostedDeployment(temp, { ...config, iceServers });
    await rename(temp, config.out);
    console.log(
      `Hosted package ready: ${config.out}\nFrontend: copy only ${path.join(config.out, 'www')} to the website.\nOn the backend VM, after copying daemon/ and backend/ together:\n  ./backend/install-backend.sh --dry-run\n  sudo ./backend/install-backend.sh\nTLS, CyberPanel and rollback instructions: ${path.join(config.out, 'DEPLOY.md')}`
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
      'npm run build:hosted -- --origin https://hub.example.org [--daemon-url wss://daemon.example.org/hub-ws] [--out DIR] [--daemon-port 3193] [--api-port 3192] [--core-url http://127.0.0.1:12391] [--ice-servers FILE] [--skip-build]'
    );
  else await buildHosted(options(process.argv.slice(2)));
}
