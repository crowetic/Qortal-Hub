import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  HubApiError,
  type HubApiPrincipal,
  type HubApiScope,
} from '../../electron/src/hub-api/auth';
import { HubApiRuntime } from '../../electron/src/hub-api/runtime';
import type { HubAccountResolver } from '../../electron/src/hub-api/server';
import { ReticulumBridge } from '../../electron/src/reticulum-bridge';
import { ReticulumChatManager } from '../../electron/src/reticulum-chat';
import { ReticulumResourceStore } from '../../electron/src/reticulum-resource-store';
import {
  PresenceManager,
  deriveAddressFromPublicKey,
  type PresenceEnvelope,
  type PresenceRoute,
} from '../../electron/src/presence';
import type { DaemonConfig } from './config';
import { CallManager } from '../../electron/src/call';
import { GroupCallManager } from '../../electron/src/group-call';
import { nuqloudAccount } from './nuqloud';
import { closeNuqloudUploads } from './nuqloud-resources';

export type BrowserSigner = (
  kind: 'presence' | 'chat',
  fields: Record<string, unknown>
) => Promise<any>;

async function requestJson(
  url: string,
  token?: string,
  body?: unknown
): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
  } catch {
    throw new HubApiError(503, 'upstream_unavailable');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HubApiError(
      [401, 403, 404].includes(response.status) ? 403 : 503,
      token ? 'auth_access_denied' : 'core_unavailable'
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body!) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024)
      throw new HubApiError(503, 'upstream_response_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HubApiError(503, 'upstream_invalid_response');
  }
}

export class AccountRegistry {
  private workers = new Map<string, Promise<AccountWorker>>();
  private closed = false;
  private sweep: NodeJS.Timeout;
  constructor(readonly config: DaemonConfig) {
    this.sweep = setInterval(() => {
      for (const [id, pending] of this.workers) {
        void pending
          .then((worker) => {
            if (!worker.active || Date.now() - worker.lastUsed > config.idleMs)
              return this.remove(id, worker);
          })
          .catch(() => {});
      }
    }, 10_000);
  }
  private async remove(id: string, worker: AccountWorker) {
    const pending = this.workers.get(id);
    if ((await pending?.catch(() => null)) !== worker) return;
    // Keep the slot until all Python processes and SQLite handles have closed.
    await worker.close();
    if (this.workers.get(id) === pending) this.workers.delete(id);
  }
  resolve: HubAccountResolver = async (token, walletId, scope) => {
    if (this.closed) throw new HubApiError(503, 'shutting_down');
    const auth = this.config.api.authUrl;
    const wallet = await requestJson(
      `${auth}/wallet/${encodeURIComponent(walletId)}`,
      token
    );
    if (
      wallet.walletId !== walletId ||
      typeof wallet.publicKey !== 'string' ||
      deriveAddressFromPublicKey(wallet.publicKey) !== wallet.address0
    )
      throw new HubApiError(403, 'wallet_identity_invalid');
    const permission = await requestJson(
      `${auth}/permissions/status?walletId=${encodeURIComponent(walletId)}&scope=${scope}`,
      token
    );
    if (permission.effective !== true)
      throw new HubApiError(403, 'scope_required');
    if (this.closed) throw new HubApiError(503, 'shutting_down');
    const principal = { address: wallet.address0, publicKey: wallet.publicKey };
    let pending = this.workers.get(walletId);
    if (!pending) {
      if (this.workers.size >= this.config.maxAccounts)
        throw new HubApiError(429, 'account_limit');
      pending = AccountWorker.create(this.config, walletId, principal, token);
      this.workers.set(walletId, pending);
      void pending.catch(() => {
        if (this.workers.get(walletId) === pending)
          this.workers.delete(walletId);
      });
    }
    const worker = await pending;
    if (!worker.active) {
      await this.remove(walletId, worker);
      return this.resolve(token, walletId, scope);
    }
    if (
      worker.principal.address !== principal.address ||
      worker.principal.publicKey !== principal.publicKey
    )
      throw new HubApiError(403, 'account_mismatch');
    worker.token = token;
    worker.lastUsed = Date.now();
    await worker.refreshMemberships();
    return {
      config: {
        ...this.config.api,
        walletId,
        address: principal.address,
        groupIds: worker.groupIds,
      },
      principal,
      runtime: worker.runtime,
      nuqloud: nuqloudAccount(worker),
    };
  };
  async close() {
    this.closed = true;
    clearInterval(this.sweep);
    await Promise.allSettled(
      [...this.workers.values()].map(async (pending) => (await pending).close())
    );
    this.workers.clear();
  }
}

export class AccountWorker {
  active = true;
  lastUsed = Date.now();
  groupIds: number[] = [];
  readonly bridge: ReticulumBridge;
  readonly presence = new PresenceManager();
  readonly resources: ReticulumResourceStore;
  readonly manager: ReticulumChatManager;
  readonly calls: CallManager;
  readonly groupCalls: GroupCallManager;
  readonly runtime: HubApiRuntime;
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe: () => void;
  private sessionId = '';
  private membershipAt = 0;
  private members = new Map<number, { at: number; entries: any[] }>();
  private membershipPending?: Promise<void>;
  private closing?: Promise<void>;
  private syncing = false;
  private syncAgain = false;
  private constructor(
    readonly config: DaemonConfig,
    readonly walletId: string,
    readonly principal: HubApiPrincipal,
    public token: string,
    private browserSigner?: BrowserSigner
  ) {
    const id = createHash('sha256')
      .update(`${config.api.authUrl}\0${walletId}`)
      .digest('hex');
    const directory = path.join(config.dataDir, 'accounts', id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.bridge = new ReticulumBridge({
      configDir: () => path.join(config.dataDir, 'rns'),
      identityPath: () => path.join(directory, 'presence-bridge.identity'),
      instanceIndex: () => 0,
      logPath: () => path.join(directory, 'reticulum.log'),
      sourceEnvironment: () => ({}),
      launch: (script, args) => ({
        cmd: config.python,
        args: ['-u', script, ...args],
        cwd: config.resourcesDir,
        mode: 'venv',
      }),
      persistTransportState: () => {},
      presenceManager: () => this.presence,
    });
    this.resources = new ReticulumResourceStore({
      rootDir: path.join(directory, 'resources'),
      dbPath: path.join(directory, 'resources.db'),
      tempDir: path.join(directory, 'tmp'),
    });
    this.manager = new ReticulumChatManager({
      dbPath: path.join(directory, 'chat.db'),
      bridge: this.bridge,
      resourceStore: this.resources,
      signLocalFields: async (fields) => {
        if (!this.active) return null;
        try {
          return await this.sign('chat', fields);
        } catch (error) {
          // An unsupported optional protocol control does not terminate chat.
          if (error instanceof HubApiError && error.status === 403)
            void this.close();
          return null;
        }
      },
      validateGroupMember: async (group, address) =>
        (await this.getMembers(group)).some((m) => m.member === address),
      validateGroupAdmin: async (group, address) =>
        (await this.getMembers(group)).some(
          (m) => m.member === address && m.isAdmin === true
        ),
      getVerifiedReticulumPeers: () =>
        this.presence.getReticulumVerifiedTransportPeers(),
      getAccountEndpointLeases: () =>
        this.presence.getReticulumAccountEndpointLeases(),
      hasGoodOverlayHealth: () =>
        this.presence.getReticulumVerifiedTransportPeers().length > 0,
    });
    this.runtime = new HubApiRuntime(
      this.manager,
      principal.address,
      () => this.active && this.bridge.getState() === 'ready',
      'node',
      () => ({
        state: this.bridge.getState(),
        destinationHash: this.bridge.getLocalDestinationHash(),
        verifiedPeers:
          this.presence.getReticulumVerifiedTransportPeers().length,
      })
    );
    this.calls = new CallManager(this.presence, this.bridge);
    this.groupCalls = new GroupCallManager(this.presence, this.bridge);
    this.calls.setDmCallLinkControlSender((input) =>
      this.groupCalls.sendDmCallLinkControl(input)
    );
    this.calls.on('call:history', (update) => {
      void this.manager.recordDirectCallHistory(update).catch(() => {});
    });
    this.groupCalls.on('gcall:dm-call-control', (control) => {
      if (control.kind === 'hangup-ack')
        this.calls.acknowledgeDmCallLinkHangup(control);
      else
        void this.calls.handleDmCallLinkHangup(control, (ack) =>
          this.groupCalls.sendDmCallLinkControl(ack)
        );
    });
    this.unsubscribe = this.bridge.subscribe({
      onEnvelope: (envelope, route) => {
        void this.presence.handleEnvelope(envelope, route).catch(() => {});
      },
      onCandidatePeerDiscovered: ({ peerHash, source }) =>
        this.presence.noteReticulumCandidateDiscovered(
          peerHash,
          source || 'reticulum'
        ),
      onOverlayPeerAdmitted: ({ peerHash, source }) =>
        this.presence.noteReticulumOverlayPeerAdmitted(
          peerHash,
          source || 'reticulum'
        ),
      onOverlayLinkClosed: ({ peerHash, reason, lastActivityAgeMs }) =>
        this.presence.noteReticulumOverlayLinkClosed(
          peerHash,
          reason,
          Date.now(),
          { lastActivityAgeMs }
        ),
      onReady: () => {
        this.presence.setLocalReticulumDestinationHash(
          this.bridge.getLocalDestinationHash() || null
        );
        void this.syncOverlay();
        if (this.sessionId && !this.browserSigner)
          void this.publishPresence('PRESENCE_ANNOUNCE').catch(() =>
            this.close()
          );
      },
      onDegraded: () => {
        this.presence.setLocalReticulumDestinationHash(null);
        this.presence.invalidateTransportRoutes('reticulum');
      },
    });
    for (const event of [
      'reticulum-overlay-changed',
      'reticulum-account-endpoints-changed',
    ])
      this.presence.on(event, () => {
        void this.syncOverlay();
      });
    this.presence.on(
      'reticulum-candidate-failed',
      ({ destinationHash, reason }) => {
        if (this.active)
          void this.bridge
            .noteOverlayCandidateFailure(destinationHash, reason)
            .catch(() => {});
      }
    );
    this.presence.on(
      'reticulum-envelope-accepted',
      ({
        envelope,
        route,
      }: {
        envelope: PresenceEnvelope;
        route: PresenceRoute;
      }) => {
        if (
          this.active &&
          route.kind === 'reticulum' &&
          (route.overlayHopsRemaining || 0) > 0
        )
          void this.bridge
            .forwardPresence(
              envelope,
              route.overlayHopsRemaining! - 1,
              [route.viaDestinationHash || route.destinationHash],
              route.destinationHash
            )
            .catch(() => {});
      }
    );
  }
  static async create(
    config: DaemonConfig,
    walletId: string,
    principal: HubApiPrincipal,
    token: string,
    browserSigner?: BrowserSigner
  ) {
    const worker = new AccountWorker(
      config,
      walletId,
      principal,
      token,
      browserSigner
    );
    try {
      worker.presence.startVerifyPool();
      worker.presence.startCleanup();
      await worker.bridge.start();
      const destination = worker.bridge.getLocalDestinationHash();
      if (!destination)
        throw new HubApiError(503, 'reticulum_identity_unavailable');
      worker.sessionId = `P${Buffer.from(destination, 'hex').toString('base64url')}${randomBytes(10).toString('base64url').slice(0, 13)}`;
      // Prove External Auth can sign before subscribing or accepting traffic.
      if (!browserSigner) await worker.publishPresence('PRESENCE_ANNOUNCE');
      worker.manager.setLocalDmAddresses([principal.address]);
      worker.calls.setLocalAddresses([principal.address]);
      worker.groupCalls.setLocalAddresses([principal.address]);
      worker.calls.start();
      worker.groupCalls.start();
      await worker.refreshMemberships();
      worker.timers.push(
        setInterval(() => {
          if (!browserSigner)
            void worker
              .publishPresence('PRESENCE_HEARTBEAT')
              .catch(() => worker.close());
        }, 25_000)
      );
      worker.timers.push(
        setInterval(() => {
          void worker.refreshMemberships().catch(() => worker.close());
        }, 30_000)
      );
      return worker;
    } catch (error) {
      await worker.close();
      throw error;
    }
  }
  private sign(kind: 'presence' | 'chat', fields: Record<string, unknown>) {
    if (this.browserSigner) return this.browserSigner(kind, fields);
    return requestJson(
      `${this.config.api.authUrl}/hub/session/sign`,
      this.token,
      { walletId: this.walletId, kind, fields }
    );
  }
  private async publishPresence(
    type: 'PRESENCE_ANNOUNCE' | 'PRESENCE_HEARTBEAT'
  ) {
    if (!this.active) return;
    const timestamp = Date.now();
    const fields = {
      type,
      sessionId: this.sessionId,
      timestamp,
      status: 'online',
      ...(type === 'PRESENCE_ANNOUNCE' ? { clientVersion: '0.1.0' } : {}),
    };
    const signed = await this.sign('presence', fields);
    if (!this.active) return;
    const { type: _type, timestamp: _timestamp, ...payload } = fields;
    // Match createCompactWireId in the renderer: UUIDs exceed the presence MDU.
    const envelope = {
      id: randomBytes(12).toString('base64url'),
      type,
      senderAddress: this.principal.address,
      timestamp,
      payload: {
        ...payload,
        address: this.principal.address,
        publicKey: this.principal.publicKey,
      },
      signature: signed.signature,
    } as PresenceEnvelope;
    await this.presence.handleEnvelope(envelope, { kind: 'local' });
    if (!(await this.bridge.publish(envelope)))
      throw new HubApiError(503, 'presence_publish_failed');
  }
  private async syncOverlay() {
    if (!this.active || this.bridge.getState() !== 'ready') return;
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.syncAgain = false;
        const verified = this.presence.getReticulumVerifiedTransportPeers();
        await this.bridge.syncOverlayState(
          verified,
          this.presence.getReticulumActiveNeighborHashes(),
          this.presence.getReticulumAccountEndpointLeases()
        );
      } while (this.syncAgain && this.active);
    } catch {
      /* Bridge recovery triggers another synchronization. */
    } finally {
      this.syncing = false;
    }
  }
  private async getMembers(groupId: number) {
    const cached = this.members.get(groupId);
    if (cached && Date.now() - cached.at < 15_000) return cached.entries;
    const result = await requestJson(
      `${this.config.coreUrl}/groups/members/${groupId}?limit=0`
    );
    if (!Array.isArray(result.members))
      throw new HubApiError(503, 'core_invalid_members');
    this.members.set(groupId, { at: Date.now(), entries: result.members });
    return result.members as any[];
  }
  async groupCapabilities(groupId: number) {
    if (!this.groupIds.includes(groupId))
      throw new HubApiError(403, 'group_not_allowed');
    const local = (await this.getMembers(groupId)).find(
      (entry) => entry.member === this.principal.address
    );
    return { groupId, isAdmin: local?.isAdmin === true };
  }
  async refreshMemberships() {
    if (Date.now() - this.membershipAt < 15_000) return;
    if (this.membershipPending) return this.membershipPending;
    this.membershipPending = (async () => {
      try {
        const groups = await requestJson(
          `${this.config.coreUrl}/groups/member/${this.principal.address}?limit=0`
        );
        if (!Array.isArray(groups) || groups.length > 1000)
          throw new HubApiError(503, 'core_invalid_memberships');
        const memberships = [];
        for (const group of groups) {
          if (!Number.isSafeInteger(group.groupId) || group.groupId <= 0)
            continue;
          if (
            this.config.api.groupIds.length &&
            !this.config.api.groupIds.includes(group.groupId)
          )
            continue;
          const members = await this.getMembers(group.groupId);
          const local = members.find(
            (m) => m.member === this.principal.address
          );
          if (!local) continue;
          this.groupCalls.setQortalGroupReticulumTargets(
            `gcall-qortal-${group.groupId}`,
            members
              .map((entry) => entry.member)
              .filter((address) => typeof address === 'string')
          );
          memberships.push({
            groupId: group.groupId,
            localAddress: this.principal.address,
            isPrivate: group.isOpen !== true,
            isAdmin: local.isAdmin === true,
            adminStatusAuthoritative: true,
          });
        }
        if (!this.active) return;
        const nextIds = memberships.map((group) => group.groupId);
        if (this.groupIds.some((id) => !nextIds.includes(id))) {
          this.groupCalls.clearLocalAccountState();
          this.groupCalls.setLocalAddresses([this.principal.address]);
        }
        this.manager.setLocalGroupMemberships(memberships);
        this.groupIds = memberships.map((group) => group.groupId);
        for (const groupId of this.groupIds)
          this.manager.subscribeGroup(groupId);
        this.membershipAt = Date.now();
      } catch (error) {
        this.groupIds = [];
        if (this.active) this.manager.setLocalGroupMemberships([]);
        throw error;
      }
    })().finally(() => {
      this.membershipPending = undefined;
    });
    return this.membershipPending;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.active = false;
    this.token = '';
    for (const timer of this.timers) clearInterval(timer);
    this.unsubscribe();
    this.presence.stopCleanup();
    this.presence.stopVerifyPool();
    this.presence.clearLocalAccountState();
    this.presence.removeAllListeners();
    this.calls.stop();
    this.groupCalls.stop();
    this.closing = (async () => {
      await closeNuqloudUploads(this);
      this.manager.close();
      this.resources.close();
      await this.bridge.retireAndWait();
    })();
    return this.closing;
  }
}
