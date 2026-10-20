#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { buildHosted, options } from './build-hosted.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const help = `Usage: ./build-hosted-access.sh [options]
  --config FILE          Saved JSON settings (default: hosted-access.config.json)
  --origin HTTPS_URL     Public frontend origin
  --daemon-url WSS_URL   Public daemon endpoint, including /hub-ws
  --core-url HTTP_URL    Core API reachable from the daemon VM
  --daemon-port PORT     Private browser listener (default: 3193)
  --api-port PORT        Private REST listener (default: 3192)
  --ice-servers FILE     Public RTCIceServer JSON array
  --out DIR              New package directory; never overwrites an existing one
  --non-interactive      Use config/flags without prompts; origin is required
  --skip-deps            Reuse installed npm dependencies
  --skip-build           Package existing builds; also skips npm installation
  --help                 Show this help

Without --non-interactive, a terminal prompts for the frontend, daemon and Core.
Settings are saved as JSON. Each run defaults to a fresh timestamped package.
The build never connects to a VM, installs services or changes a web server.
`;

export function readSetup(argv, directory = root) {
  const flags = new Map();
  const booleans = new Set([
    '--non-interactive',
    '--skip-deps',
    '--skip-build',
  ]);
  const values = new Set([
    '--config',
    '--origin',
    '--daemon-url',
    '--core-url',
    '--daemon-port',
    '--api-port',
    '--ice-servers',
    '--out',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (booleans.has(name)) flags.set(name, true);
    else if (values.has(name) && argv[i + 1] && !argv[i + 1].startsWith('--'))
      flags.set(name, argv[++i]);
    else throw new Error(`Unknown or incomplete option: ${name}`);
  }
  const configFile = path.resolve(
    directory,
    flags.get('--config') || 'hosted-access.config.json'
  );
  const config = existsSync(configFile)
    ? JSON.parse(readFileSync(configFile, 'utf8'))
    : {};
  const known = new Set([
    'origin',
    'daemonUrl',
    'coreUrl',
    'daemonPort',
    'apiPort',
    'outputRoot',
    'iceServers',
  ]);
  if (!config || Array.isArray(config) || typeof config !== 'object')
    throw new Error('Hosted configuration must be a JSON object');
  for (const key of Object.keys(config))
    if (!known.has(key))
      throw new Error(`Unknown hosted configuration field: ${key}`);
  for (const [flag, key] of [
    ['--origin', 'origin'],
    ['--daemon-url', 'daemonUrl'],
    ['--core-url', 'coreUrl'],
    ['--daemon-port', 'daemonPort'],
    ['--api-port', 'apiPort'],
  ])
    if (flags.has(flag)) config[key] = flags.get(flag);
  if (flags.has('--ice-servers'))
    config.iceServers = JSON.parse(
      readFileSync(path.resolve(directory, flags.get('--ice-servers')), 'utf8')
    );
  return { config, configFile, flags };
}

export async function configure(argv) {
  if (argv.includes('--help')) return console.log(help);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12))
    throw new Error('Node.js >=22.12 is required');
  const { config, configFile, flags } = readSetup(argv);
  if (!flags.has('--non-interactive') && process.stdin.isTTY) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      for (const [key, label, fallback] of [
        ['origin', 'Frontend HTTPS origin', 'https://hub.qortal.link'],
        ['daemonUrl', 'Daemon WSS URL', 'wss://hub-daemon.qortal.link/hub-ws'],
        [
          'coreUrl',
          'Core API reachable from the daemon VM',
          'http://127.0.0.1:12391',
        ],
      ]) {
        if (
          flags.has(
            {
              origin: '--origin',
              daemonUrl: '--daemon-url',
              coreUrl: '--core-url',
            }[key]
          )
        )
          continue;
        const current = config[key] || fallback;
        config[key] =
          (await prompt.question(`${label} [${current}]: `)).trim() || current;
      }
    } finally {
      prompt.close();
    }
  }
  if (!config.origin)
    throw new Error(
      'Supply --origin or configure origin in the JSON file (see --help)'
    );
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const out =
    flags.get('--out') ||
    path.resolve(
      root,
      config.outputRoot || '.artifacts/hosted-access',
      `${stamp}-${randomBytes(3).toString('hex')}`
    );
  const args = ['--origin', config.origin, '--out', out];
  for (const [key, flag] of [
    ['daemonUrl', '--daemon-url'],
    ['coreUrl', '--core-url'],
    ['daemonPort', '--daemon-port'],
    ['apiPort', '--api-port'],
  ])
    if (config[key] !== undefined) args.push(flag, String(config[key]));
  if (flags.has('--skip-build')) args.push('--skip-build');
  const build = {
    ...options(args),
    iceServers: config.iceServers === undefined ? [] : config.iceServers,
  };
  // Validate everything before saving settings or installing dependencies.
  const { validateIceServers } = await import('./hosted-deployment.mjs');
  validateIceServers(build.iceServers);
  if (lstatSync(build.out, { throwIfNoEntry: false }))
    throw new Error(`Output already exists: ${build.out}`);
  const saved = {
    origin: build.origin,
    daemonUrl: build.daemonUrl,
    coreUrl: build.coreUrl,
    daemonPort: build.daemonPort,
    apiPort: build.apiPort,
    outputRoot: config.outputRoot || '.artifacts/hosted-access',
    iceServers: build.iceServers,
  };
  const temp = `${configFile}.${process.pid}.tmp`;
  mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  writeFileSync(temp, JSON.stringify(saved, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(temp, configFile);
  console.log(
    `Saved build settings: ${configFile}\nFrontend: ${build.origin}\nDaemon: ${build.daemonUrl}\nOutput: ${build.out}`
  );
  if (!flags.has('--skip-deps') && !build.skipBuild) {
    for (const directory of [root, path.join(root, 'daemon')]) {
      const result = spawnSync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['ci'],
        { cwd: directory, stdio: 'inherit' }
      );
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`npm ci failed in ${directory}`);
    }
  }
  await buildHosted(build);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  configure(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
