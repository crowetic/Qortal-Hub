import type { HubApiConfig } from './config';

export class HubApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

export interface HubApiPrincipal {
  address: string;
  publicKey: string;
}

export type HubApiScope = 'QCHAT_READ' | 'QCHAT_PUBLISH';
export type HubApiAuthorize = (
  token: string,
  scope: HubApiScope
) => Promise<HubApiPrincipal>;

/** Uses the existing External Auth contract; no private keys or unlocks required. */
export function createExternalAuthAuthorizer(
  config: HubApiConfig,
  fetchImpl: typeof fetch = fetch
): HubApiAuthorize {
  return async (token, scope) => {
    const get = async (path: string): Promise<Record<string, unknown>> => {
      let response: Response;
      try {
        response = await fetchImpl(`${config.authUrl}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        throw new HubApiError(503, 'auth_unavailable');
      }
      if ([401, 403, 404].includes(response.status)) {
        throw new HubApiError(403, 'access_denied');
      }
      if (!response.ok) throw new HubApiError(503, 'auth_unavailable');
      try {
        return await response.json();
      } catch {
        throw new HubApiError(503, 'auth_unavailable');
      }
    };
    // GET /wallet/:id checks session.appId against wallet.appId in External Auth.
    const wallet = await get(`/wallet/${encodeURIComponent(config.walletId)}`);
    if (
      wallet?.walletId !== config.walletId ||
      wallet.address0 !== config.address ||
      typeof wallet.publicKey !== 'string' ||
      !wallet.publicKey
    ) {
      throw new HubApiError(403, 'account_mismatch');
    }
    const permission = await get(
      `/permissions/status?walletId=${encodeURIComponent(config.walletId)}&scope=${scope}`
    );
    if (permission?.effective !== true) {
      throw new HubApiError(403, 'scope_required');
    }
    return { address: config.address, publicKey: wallet.publicKey };
  };
}
