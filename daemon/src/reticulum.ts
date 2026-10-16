import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  copyFileSync,
  unlinkSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_RETICULUM_HUBS } from '../../electron/src/reticulum-hubs';
import type { DaemonConfig } from './config';

async function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(200, () => done(false));
  });
}

export function lockDataDirectory(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'daemon.pid');
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') alive = false;
    }
    if (alive || !Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Daemon data directory is already locked');
    unlinkSync(file);
  }
  writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  return () => {
    try {
      unlinkSync(file);
    } catch {
      // Another shutdown path may already have removed the lock.
    }
  };
}

export async function startReticulum(config: DaemonConfig, onExit: () => void) {
  if (!existsSync(config.python))
    throw new Error(
      'Python runtime missing: run npm run setup:reticulum in daemon/'
    );
  const directory = path.join(config.dataDir, 'rns');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const configPath = path.join(directory, 'config');
  if (!config.customRnsConfig) {
    const identity = path.join(directory, 'mesh-network.identity');
    if (!existsSync(identity))
      copyFileSync(
        path.join(config.resourcesDir, 'mesh-network.identity'),
        identity
      );
    const keyPath = path.join(directory, 'rpc-key');
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
    const hubs = DEFAULT_RETICULUM_HUBS.map((hub) => {
      const type =
        process.platform === 'linux' ? hub.interfaceType : 'TCPClientInterface';
      return `  [[${hub.name}]]\n  type = ${type}\n  enabled = yes\n  ${type === 'BackboneInterface' ? 'remote' : 'target_host'} = ${hub.host}\n  target_port = ${hub.port}\n  network_name = ${hub.networkName}`;
    }).join('\n\n');
    writeFileSync(
      configPath,
      `# Managed by qortal-hub-daemon. Set QORTAL_HUB_CUSTOM_RNS_CONFIG=1 to manage this file.\n[reticulum]\nenable_transport = False\nshare_instance = Yes\nshared_instance_type = tcp\ninstance_name = qortal-hub-daemon\nshared_instance_port = ${config.rnsPort}\ninstance_control_port = ${config.controlPort}\nrpc_key = ${readFileSync(keyPath, 'utf8').trim()}\nnetwork_identity = ${identity}\ndiscover_interfaces = Yes\nautoconnect_discovered_interfaces = 6\n\n[logging]\nloglevel = 3\n\n[interfaces]\n${hubs}\n`,
      { mode: 0o600 }
    );
  } else if (!existsSync(configPath)) {
    throw new Error(`Custom Reticulum configuration missing: ${configPath}`);
  }
  if (await listening(config.rnsPort))
    throw new Error(`Reticulum shared port ${config.rnsPort} already in use`);
  const log = openSync(path.join(directory, 'rnsd.log'), 'a', 0o600);
  const child = spawn(
    config.python,
    [
      '-u',
      path.join(config.resourcesDir, 'hub_rnsd.py'),
      '--config',
      directory,
    ],
    {
      stdio: ['pipe', log, log],
      windowsHide: true,
    }
  );
  child.stdin.on('error', () => {});
  closeSync(log);
  let stopping = false;
  let failure: Error | undefined;
  child.once('error', (error) => {
    failure = error;
  });
  child.once('exit', () => {
    if (!stopping) onExit();
  });
  const stop = async () => {
    stopping = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
    });
  };
  try {
    const deadline = Date.now() + 20_000;
    while (!(await listening(config.rnsPort))) {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`rnsd exited; see ${directory}/rnsd.log`);
      if (Date.now() > deadline)
        throw new Error(
          `rnsd did not listen; custom config must use shared_instance_type=tcp and port ${config.rnsPort}`
        );
      await delay(100);
    }
    return { directory, stop, child };
  } catch (error) {
    await stop();
    throw error;
  }
}
