#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const marker = '# Managed by Qortal Hub hosted installer';
const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
export const help = `Usage: sudo ./backend/install-backend.sh [options]
  --dry-run              Validate package/config and print the plan; change nothing
  --replace-config       Back up/update managed env keys; preserve unrelated keys
  --rollback             Restore the prior managed release and configuration
  --install-dir PATH     Default /srv/qortal-hub
  --data-dir PATH        Default /var/lib/qortal-hub-daemon
  --env-file PATH        Default /etc/qortal-hub/hosted.env
  --service-name NAME    Default qortal-hub-daemon (without .service)
  --user NAME            Default qortal-hub
  --help                 Show this help

Requires Linux/systemd, Node >=22.12/npm, Python >=3.9 with venv/pip, Git,
runuser and useradd. Does not install OS packages or alter DNS/TLS/firewalls.
Never point a second daemon at an existing account data directory.
`;

export function parseInstallArgs(argv) {
  const options = {
    installDir: '/srv/qortal-hub',
    dataDir: '/var/lib/qortal-hub-daemon',
    envFile: '/etc/qortal-hub/hosted.env',
    serviceName: 'qortal-hub-daemon',
    user: 'qortal-hub',
  };
  const keys = {
    '--install-dir': 'installDir',
    '--data-dir': 'dataDir',
    '--env-file': 'envFile',
    '--service-name': 'serviceName',
    '--user': 'user',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') options.dryRun = true;
    else if (argv[i] === '--replace-config') options.replaceConfig = true;
    else if (argv[i] === '--rollback') options.rollback = true;
    else if (keys[argv[i]] && argv[i + 1] && !argv[i + 1].startsWith('--'))
      options[keys[argv[i]]] = argv[++i];
    else throw new Error(`Unknown or incomplete option: ${argv[i]}`);
  }
  for (const key of ['installDir', 'dataDir', 'envFile']) {
    const value = options[key];
    if (
      !/^\/[a-zA-Z0-9_./-]+$/.test(value) ||
      value.split('/').includes('..') ||
      path.resolve(value) === '/'
    )
      throw new Error(`Unsafe ${key}`);
    options[key] = path.resolve(value);
  }
  if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(options.user) || options.user === 'root')
    throw new Error('Invalid unprivileged service user');
  if (!/^[a-zA-Z0-9_-]+$/.test(options.serviceName))
    throw new Error('Invalid service name');
  for (const candidate of [options.dataDir, options.envFile])
    if (
      candidate === options.installDir ||
      ['current', 'releases', 'rollback'].some(
        (part) =>
          candidate === path.join(options.installDir, part) ||
          candidate.startsWith(path.join(options.installDir, part) + path.sep)
      )
    )
      throw new Error(
        'Keep environment and persistent data outside managed release paths'
      );
  return options;
}

function parseEnv(text) {
  return new Map(
    text.split('\n').flatMap((line) => {
      const match = /^([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$/.exec(line);
      return match
        ? [[match[1], match[2].trim().replace(/^(["'])(.*)\1$/, '$2')]]
        : [];
    })
  );
}

export function mergeEnvironment(existing, desired, replace = false) {
  const wanted = parseEnv(desired),
    current = parseEnv(existing);
  if (existing && !replace) {
    const mismatched = [...wanted]
      .filter(([key, value]) =>
        key === 'QORTAL_HUB_API_ORIGINS'
          ? !value.split(',').every((origin) =>
              (current.get(key) || '')
                .split(',')
                .map((v) => v.trim())
                .includes(origin)
            )
          : current.get(key) !== value
      )
      .map(([key]) => key);
    if (mismatched.length)
      throw new Error(
        `Existing config differs for ${mismatched.join(', ')}; review it or use --replace-config`
      );
    return existing;
  }
  const seen = new Set();
  const lines = existing
    ? existing
        .trimEnd()
        .split('\n')
        .map((line) => {
          const key = /^([a-zA-Z_][a-zA-Z0-9_]*)=/.exec(line)?.[1];
          if (!wanted.has(key)) return line;
          seen.add(key);
          return `${key}=${wanted.get(key)}`;
        })
    : [];
  for (const [key, value] of wanted)
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  return lines.join('\n') + '\n';
}

function atomicWrite(file, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, contents, { mode, flag: 'wx' });
  fs.renameSync(temp, file);
}

function linkRelease(file, target) {
  if (fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink())
    throw new Error(`Refusing to replace non-symlink ${file}`);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.symlinkSync(target, temp);
  fs.renameSync(temp, file);
}

function verifyFiles(directory, metadata) {
  if (metadata.version !== 1 || !/^[a-zA-Z0-9_-]+$/.test(metadata.releaseId))
    throw new Error('Invalid deployment metadata');
  if (!metadata.files || !Object.keys(metadata.files).length)
    throw new Error('Missing runtime checksums');
  for (const [name, digest] of Object.entries(metadata.files)) {
    if (
      !name.startsWith('daemon/') ||
      name.split('/').includes('..') ||
      !/^[a-zA-Z0-9_./-]+$/.test(name)
    )
      throw new Error('Unsafe checksum path');
    const file = path.join(directory, name);
    if (
      !fs.lstatSync(file).isFile() ||
      createHash('sha256').update(fs.readFileSync(file)).digest('hex') !==
        digest
    )
      throw new Error(`Runtime checksum mismatch: ${name}`);
  }
}

export function serviceUnit(options, group, node = process.execPath) {
  return `${marker}
[Unit]
Description=Qortal Hub hosted real-time daemon
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${options.user}
Group=${group}
WorkingDirectory=${options.installDir}/current/daemon
EnvironmentFile=${options.envFile}
ExecStart=${node} ${options.installDir}/current/daemon/dist/index.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`;
}

export async function installBackend(options, hooks = {}) {
  const directory = hooks.packageDir || packageDir;
  const run = (
    command,
    args,
    { quiet = false, allowFailure = false, cwd } = {}
  ) => {
    const result = (hooks.run || spawnSync)(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: quiet ? 'pipe' : 'inherit',
    });
    if (result.error) throw result.error;
    if (!allowFailure && result.status !== 0)
      throw new Error(`${command} failed (exit ${result.status})`);
    return result;
  };
  const read = (file) =>
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const metadata = JSON.parse(
    fs.readFileSync(path.join(directory, 'backend/deployment.json'), 'utf8')
  );
  const unitFile = path.join(
    hooks.serviceDir || '/etc/systemd/system',
    `${options.serviceName}.service`
  );
  const unit = read(unitFile);
  if (unit && !unit.startsWith(marker))
    throw new Error(
      `Existing unit is unmanaged: ${unitFile}; migrate it or select a different service name`
    );
  const current = path.join(options.installDir, 'current');
  if (fs.existsSync(current) && !fs.lstatSync(current).isSymbolicLink())
    throw new Error('Existing current path is not a managed release symlink');
  const oldRelease = fs.existsSync(current) ? fs.realpathSync(current) : null;
  const releases = path.join(options.installDir, 'releases');
  if (oldRelease && !oldRelease.startsWith(releases + path.sep))
    throw new Error('Existing release is outside the managed installation');
  const release = path.join(releases, metadata.releaseId);
  const rollbackDir = path.join(
    options.installDir,
    'rollback',
    path.basename(oldRelease || release)
  );
  if (options.rollback) {
    const stateFile = path.join(rollbackDir, 'state.json');
    if (!fs.existsSync(stateFile))
      throw new Error('No previous managed release snapshot exists');
    if (options.dryRun) return { action: 'rollback', snapshot: stateFile };
  } else {
    verifyFiles(directory, metadata);
    if (
      process.platform !== 'linux' ||
      metadata.platform !== process.platform ||
      metadata.arch !== process.arch
    )
      throw new Error(
        `Package requires ${metadata.platform}-${metadata.arch}; backend installer requires a matching Linux VM`
      );
  }
  const oldEnv = read(options.envFile);
  const dataMarker = path.join(options.dataDir, '.hosted-install.json');
  const ownership = {
    installDir: options.installDir,
    serviceName: options.serviceName,
    user: options.user,
  };
  if (
    !options.rollback &&
    fs.existsSync(options.dataDir) &&
    fs.readdirSync(options.dataDir).length
  ) {
    if (
      !fs.existsSync(dataMarker) ||
      JSON.stringify(JSON.parse(fs.readFileSync(dataMarker, 'utf8'))) !==
        JSON.stringify(ownership)
    )
      throw new Error(
        'Existing data directory is not managed by this installation; migrate it explicitly or choose an empty data directory'
      );
  }
  const desired = options.rollback
    ? null
    : fs
        .readFileSync(path.join(directory, 'daemon/hosted.env'), 'utf8')
        .replace(
          /^QORTAL_HUB_DATA_DIR=.*$/m,
          `QORTAL_HUB_DATA_DIR=${options.dataDir}`
        );
  if (desired !== null) {
    const env = parseEnv(desired);
    for (const [key, value] of Object.entries({
      QORTAL_HUB_API_HOST: '127.0.0.1',
      QORTAL_HUB_BROWSER_ENABLED: '1',
      QORTAL_HUB_BROWSER_PORT: String(metadata.daemonPort),
      QORTAL_HUB_API_PORT: String(metadata.apiPort),
    }))
      if (env.get(key) !== value)
        throw new Error(
          `Backend environment and package contract differ for ${key}; rebuild with the desired settings`
        );
    if (
      !(env.get('QORTAL_HUB_API_ORIGINS') || '')
        .split(',')
        .map((v) => v.trim())
        .includes(metadata.origin)
    )
      throw new Error(
        'Backend allowed origins must include the generated frontend origin'
      );
  }
  const nextEnv = options.rollback
    ? null
    : mergeEnvironment(oldEnv || '', desired, options.replaceConfig);
  if (options.dryRun)
    return {
      action: 'install',
      release,
      envFile: options.envFile,
      dataDir: options.dataDir,
      service: `${options.serviceName}.service`,
      origin: metadata.origin,
      daemonUrl: metadata.daemonUrl,
      replacesConfig: Boolean(oldEnv && nextEnv !== oldEnv),
    };
  if ((hooks.uid || (() => process.getuid?.()))() !== 0)
    throw new Error('Run with sudo/root, or use --dry-run to inspect the plan');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12))
    throw new Error('Node >=22.12 is required');
  for (const [command, args] of [
    ['npm', ['--version']],
    ['python3', ['-c', 'import sys, venv; assert sys.version_info >= (3, 9)']],
    ['git', ['--version']],
    ['systemctl', ['--version']],
    ['runuser', ['--version']],
  ])
    run(command, args, { quiet: true });
  const fragment = run(
    'systemctl',
    [
      'show',
      '--property=FragmentPath',
      '--value',
      `${options.serviceName}.service`,
    ],
    { quiet: true, allowFailure: true }
  ).stdout?.trim();
  if (fragment && fragment !== unitFile)
    throw new Error(`Service is already defined elsewhere: ${fragment}`);
  const ready = async (target) => {
    if (hooks.ready) return hooks.ready(target);
    for (let i = 0; i < 20; i++) {
      if (
        run(
          process.execPath,
          [
            path.join(target, 'backend/check-backend.mjs'),
            '--local',
            '--timeout',
            '1500',
          ],
          { quiet: true, allowFailure: true }
        ).status === 0
      )
        return true;
      await delay(1000);
    }
    return false;
  };
  const restore = async (snapshot) => {
    const state = JSON.parse(
      fs.readFileSync(path.join(snapshot, 'state.json'), 'utf8')
    );
    if (
      !state.release?.startsWith(releases + path.sep) ||
      !fs.existsSync(state.release)
    )
      throw new Error('Previous release is unavailable');
    if (state.envFile !== options.envFile || state.unitFile !== unitFile)
      throw new Error(
        'Use the same env/service path options as the original installation'
      );
    if (state.env !== null) atomicWrite(options.envFile, state.env);
    else fs.rmSync(options.envFile, { force: true });
    if (state.unit !== null) atomicWrite(unitFile, state.unit, 0o644);
    else fs.rmSync(unitFile, { force: true });
    linkRelease(current, state.release);
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['restart', `${options.serviceName}.service`]);
    if (!(await ready(state.release)))
      throw new Error(
        'Previous release restored but readiness failed; inspect the service journal'
      );
    return { action: 'rolled-back', release: state.release };
  };
  if (options.rollback) return restore(rollbackDir);
  const userInfo = run('id', ['-u', options.user], {
    quiet: true,
    allowFailure: true,
  });
  if (userInfo.status !== 0)
    run('useradd', [
      '--system',
      '--user-group',
      '--no-create-home',
      '--home-dir',
      options.dataDir,
      '--shell',
      '/usr/sbin/nologin',
      options.user,
    ]);
  else if (Number(userInfo.stdout?.trim()) === 0)
    throw new Error('Service account must not be root');
  const group = run('id', ['-gn', options.user], { quiet: true }).stdout.trim();
  if (!/^[a-z_][a-z0-9_-]*$/.test(group))
    throw new Error('Invalid service group');
  fs.mkdirSync(releases, { recursive: true, mode: 0o755 });
  fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(options.dataDir, 0o700);
  if (!fs.existsSync(dataMarker))
    atomicWrite(dataMarker, JSON.stringify(ownership));
  run('chown', [`${options.user}:${group}`, options.dataDir]);
  if (!fs.existsSync(release)) {
    fs.mkdirSync(release, { mode: 0o755 });
    for (const name of ['daemon', 'backend'])
      fs.cpSync(path.join(directory, name), path.join(release, name), {
        recursive: true,
        dereference: false,
        force: false,
        errorOnExist: true,
      });
  }
  verifyFiles(release, metadata);
  if (!fs.existsSync(path.join(release, '.ready'))) {
    run('runuser', ['-u', options.user, '--', process.execPath, '--version'], {
      quiet: true,
    });
    run('chown', ['-R', '-h', `${options.user}:${group}`, release]);
    const cwd = path.join(release, 'daemon');
    run('runuser', ['-u', options.user, '--', 'npm', 'ci', '--omit=dev'], {
      cwd,
    });
    run(
      'runuser',
      ['-u', options.user, '--', 'npm', 'run', 'setup:reticulum'],
      { cwd }
    );
    // The service can write account data, but must not modify code later run as root.
    run('chown', ['-R', '-h', `root:${group}`, release]);
    run('chmod', ['-R', 'u+rwX,go+rX', release]);
    fs.chmodSync(path.join(release, 'daemon/hosted.env'), 0o600);
    atomicWrite(path.join(release, '.ready'), metadata.releaseId + '\n', 0o644);
  }
  const nextUnit = serviceUnit(options, group);
  const changed =
    oldRelease !== release || oldEnv !== nextEnv || unit !== nextUnit;
  const snapshot = path.join(
    options.installDir,
    'rollback',
    metadata.releaseId
  );
  if (changed && !fs.existsSync(path.join(snapshot, 'state.json'))) {
    fs.mkdirSync(snapshot, { recursive: true, mode: 0o700 });
    atomicWrite(
      path.join(snapshot, 'state.json'),
      JSON.stringify({
        release: oldRelease,
        env: oldEnv,
        unit,
        envFile: options.envFile,
        unitFile,
      }) + '\n'
    );
  }
  try {
    if (oldEnv !== nextEnv) atomicWrite(options.envFile, nextEnv);
    if (unit !== nextUnit) atomicWrite(unitFile, nextUnit, 0o644);
    if (oldRelease !== release) {
      if (oldRelease)
        linkRelease(path.join(options.installDir, 'previous'), oldRelease);
      linkRelease(current, release);
    }
    if (changed) run('systemctl', ['daemon-reload']);
    if (
      run(
        'systemctl',
        ['is-enabled', '--quiet', `${options.serviceName}.service`],
        { quiet: true, allowFailure: true }
      ).status !== 0
    )
      run('systemctl', ['enable', `${options.serviceName}.service`]);
    if (
      changed ||
      run(
        'systemctl',
        ['is-active', '--quiet', `${options.serviceName}.service`],
        { quiet: true, allowFailure: true }
      ).status !== 0
    )
      run('systemctl', ['restart', `${options.serviceName}.service`]);
    if (!(await ready(release)))
      throw new Error(
        'New backend failed its local HTTP/WebSocket readiness checks'
      );
  } catch (error) {
    if (oldRelease && changed) {
      await restore(snapshot);
      throw new Error(
        `${error.message}; previous managed release and config restored`
      );
    }
    if (!oldRelease)
      run('systemctl', ['stop', `${options.serviceName}.service`], {
        allowFailure: true,
      });
    throw error;
  }
  return {
    action: changed ? 'installed' : 'unchanged',
    release,
    envFile: options.envFile,
    service: `${options.serviceName}.service`,
    publicDaemonUrl: metadata.daemonUrl,
    next: 'Configure the generated TLS proxy, then run check-backend.mjs without --local',
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.includes('--help')) console.log(help);
    else
      console.log(
        JSON.stringify(
          await installBackend(parseInstallArgs(process.argv.slice(2))),
          null,
          2
        )
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
