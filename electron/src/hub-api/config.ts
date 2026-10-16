export interface HubApiConfig {
  host: '127.0.0.1' | '::1';
  port: number;
  authUrl: string;
  walletId: string;
  address: string;
  groupIds: number[];
  origins: string[];
}

/** Disabled unless explicitly enabled. Never infer public access from Hub settings. */
export function readHubApiConfig(
  env: NodeJS.ProcessEnv = process.env
): HubApiConfig | null {
  if (env.QORTAL_HUB_API_ENABLED !== '1') return null;
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Hub API requires ${key}`);
    return value;
  };
  const host = env.QORTAL_HUB_API_HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('Hub API must bind to loopback; use a TLS reverse proxy');
  }
  const port = Number(env.QORTAL_HUB_API_PORT || '3192');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid QORTAL_HUB_API_PORT');
  }
  const authUrl = new URL(required('QORTAL_HUB_API_AUTH_URL'));
  if (
    !['http:', 'https:'].includes(authUrl.protocol) ||
    authUrl.username ||
    authUrl.password ||
    authUrl.search ||
    authUrl.hash ||
    authUrl.pathname !== '/'
  ) {
    throw new Error('QORTAL_HUB_API_AUTH_URL must be an HTTP(S) origin');
  }
  const address = required('QORTAL_HUB_API_ADDRESS');
  if (!/^Q[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    throw new Error('Invalid QORTAL_HUB_API_ADDRESS');
  }
  const groups = required('QORTAL_HUB_API_GROUP_IDS').split(',');
  const groupIds = groups.map((value) => Number(value.trim()));
  if (groupIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('QORTAL_HUB_API_GROUP_IDS must list positive group IDs');
  }
  const origins = (env.QORTAL_HUB_API_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== origin
    ) {
      throw new Error('QORTAL_HUB_API_ORIGINS must list exact HTTP(S) origins');
    }
  }
  return {
    host,
    port,
    authUrl: authUrl.origin,
    walletId: required('QORTAL_HUB_API_WALLET_ID'),
    address,
    groupIds: [...new Set(groupIds)],
    origins,
  };
}
