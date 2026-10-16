import os from 'node:os';
import path from 'node:path';
import type { HubApiConfig } from '../../electron/src/hub-api/config';

export interface DaemonConfig {
  api: HubApiConfig;
  dataDir: string;
  resourcesDir: string;
  python: string;
  coreUrl: string;
  maxAccounts: number;
  idleMs: number;
  rnsPort: number;
  controlPort: number;
  customRnsConfig: boolean;
}

export function readConfig(env = process.env): DaemonConfig {
  const origin = (key: string, fallback: string) => {
    const url = new URL(env[key] || fallback);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error(`${key} must be an HTTP(S) origin`);
    return url.origin;
  };
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(env[key] || fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const host = env.QORTAL_HUB_API_HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1')
    throw new Error('Hub API must bind to loopback; use a TLS reverse proxy');
  const origins = (env.QORTAL_HUB_API_ORIGINS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const value of origins) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value)
      throw new Error('Invalid API origin');
  }
  const groupIds = (env.QORTAL_HUB_API_GROUP_IDS || '')
    .split(',')
    .filter(Boolean)
    .map(Number);
  if (groupIds.some((n) => !Number.isSafeInteger(n) || n <= 0))
    throw new Error('Invalid group allowlist');
  return {
    api: {
      host,
      port: number('QORTAL_HUB_API_PORT', 3192, 1, 65535),
      authUrl: origin('QORTAL_HUB_API_AUTH_URL', 'http://127.0.0.1:3191'),
      walletId: '',
      address: '',
      groupIds,
      origins,
    },
    dataDir: path.resolve(
      env.QORTAL_HUB_DATA_DIR ||
        path.join(os.homedir(), '.local/share/qortal-hub-daemon')
    ),
    resourcesDir: path.join(__dirname, 'resources'),
    python: path.resolve(
      env.QORTAL_HUB_PYTHON ||
        path.join(
          __dirname,
          '../.venv',
          process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
        )
    ),
    coreUrl: origin('QORTAL_HUB_CORE_URL', 'http://127.0.0.1:12391'),
    maxAccounts: number('QORTAL_HUB_MAX_ACCOUNTS', 16, 1, 128),
    idleMs: number('QORTAL_HUB_ACCOUNT_IDLE_MS', 600_000, 30_000, 86_400_000),
    rnsPort: number('QORTAL_HUB_RNS_PORT', 37438, 1024, 65535),
    controlPort: number('QORTAL_HUB_RNS_CONTROL_PORT', 37439, 1024, 65535),
    customRnsConfig: env.QORTAL_HUB_CUSTOM_RNS_CONFIG === '1',
  };
}
