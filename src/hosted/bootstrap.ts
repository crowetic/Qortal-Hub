import { installResources } from './resources';
import contract from './browser-contract.json';
import { HostedClient } from './client';
import i18n from '../i18n/i18n';

export interface HostedConfig {
  version: 1;
  daemonUrl: string;
  iceServers?: RTCIceServer[];
}
export let hostedClient: HostedClient | undefined;

export function validateHostedConfig(
  config: any,
  origin = location.origin
): HostedConfig {
  if (config?.version !== 1 || typeof config.daemonUrl !== 'string')
    throw new Error(i18n.t('reticulum:hosted.invalid_config'));
  const url = new URL(config.daemonUrl, origin);
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (new URL(origin).protocol === 'https:' && url.protocol !== 'wss:')
  )
    throw new Error(i18n.t('reticulum:hosted.invalid_config'));
  if (
    config.iceServers !== undefined &&
    (!Array.isArray(config.iceServers) ||
      config.iceServers.length > 16 ||
      config.iceServers.some(
        (server: RTCIceServer) =>
          !server ||
          !server.urls ||
          (Array.isArray(server.urls) ? server.urls : [server.urls]).some(
            (url) =>
              typeof url !== 'string' || !/^(stun|stuns|turn|turns):/.test(url)
          )
      ))
  )
    throw new Error(i18n.t('reticulum:hosted.invalid_config'));
  return {
    version: 1,
    daemonUrl: url.href,
    iceServers: config.iceServers ?? [],
  };
}

export async function initializeHosted() {
  if (window.coreSetup) return;
  const response = await fetch('/hub-config.json', {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(i18n.t('reticulum:hosted.invalid_config'));
  const text = await response.text();
  // Normal Vite/SPA servers return index.html for absent optional files.
  if (text.trimStart().startsWith('<')) return;
  if (text.length > 16384)
    throw new Error(i18n.t('reticulum:hosted.invalid_config'));
  installHosted(validateHostedConfig(JSON.parse(text)));
}

export function installHosted(config: HostedConfig) {
  const client = new HostedClient(config.daemonUrl);
  hostedClient = client;
  const rpc = (channel: string, ...args: unknown[]) =>
    client.rpc(channel, ...args);
  const hostWindow = window as any;
  hostWindow.hubHosted = true;
  for (const [name, surface] of Object.entries(contract)) {
    const api: Record<string, any> = {};
    for (const [key, channel] of Object.entries(surface.methods))
      api[key] = (...args: unknown[]) => {
        if (
          [
            'setLocalAddresses',
            'setLocalDmAddresses',
            'setLocalGroupMemberships',
            'setWatchedQortalGroupIds',
          ].includes(key) &&
          Array.isArray(args[0]) &&
          !args[0].length
        )
          return Promise.resolve({ success: true });
        if (client.state === 'idle' && ['offline', 'leave'].includes(key))
          return Promise.resolve({ success: true });
        return rpc(channel, ...args);
      };
    for (const [key, channel] of Object.entries(surface.events))
      api[key] = (callback: (payload: unknown) => void) =>
        client.on(channel, callback);
    hostWindow[name] = api;
  }
  hostWindow.reticulumChat.isEnabled = async () => true;
  hostWindow.reticulumChat.getReadinessStatus = async () => ({
    state: client.state === 'connected' ? 'ready' : 'idle',
    revision: 1,
  });
  hostWindow.reticulumChat.onReadinessChanged = (callback: any) =>
    client.on('reticulumChat:readiness', callback);
  hostWindow.reticulumChat.clearLocalAccountState = async () => {
    client.disconnect();
    return { success: true };
  };
  const allEvents = (prefix: string, callback: any) => {
    const channels =
      prefix === 'call'
        ? ['incoming', 'accepted', 'rejected', 'hangup', 'rtc-signal']
        : [
            'participant-joined',
            'participant-left',
            'local-session-taken-over',
            'topology',
            'cluster-heartbeat',
            'heartbeat',
            'audio',
            'key',
            'key-request',
            'session-updated',
            'rtc-signal',
          ];
    const unsubscribe = channels.map((name) =>
      client.on(`${prefix}:${name}`, (payload) =>
        callback(`${prefix}:${name}`, payload)
      )
    );
    return () => unsubscribe.forEach((remove) => remove());
  };
  hostWindow.call.onEvent = (callback: any) => allEvents('call', callback);
  hostWindow.groupCall.onEvent = (callback: any) =>
    allEvents('gcall', callback);
  hostWindow.groupCall.onQortalGroupCallActivity = (callback: any) =>
    client.on('gcall:qortal-group-call-activity', callback);
  hostWindow.groupCall.join = (...args: unknown[]) =>
    rpc('gcall:join', ...args);
  hostWindow.groupCall.leaveSync = (...args: unknown[]) => {
    void rpc('gcall:leave', ...args).catch(() => {});
    return { success: true };
  };
  hostWindow.groupCall.requestRetainedKeyReplay = () => {
    void rpc('gcall:request-key-replay').catch(() => {});
  };
  hostWindow.presence.onUpdate = (callback: any) =>
    client.on('presence:update', callback);
  hostWindow.presence.getAllOnline = () =>
    client.state === 'idle'
      ? Promise.resolve([])
      : rpc('presence:getAllOnline');
  hostWindow.presence.getOnlineAddresses = () =>
    client.state === 'idle'
      ? Promise.resolve([])
      : rpc('presence:getOnlineAddresses');
  hostWindow.presence.onUpdateBatch = (callback: any) =>
    client.on('presence:update', (payload) => callback([payload]));
  // Only the transport methods used by the renderer are present. In particular,
  // no coreSetup/electron marker, filesystem API, or daemon settings editor.
  hostWindow.electronAPI = {
    reticulumGetLocalDestinationHash: () => rpc('transport:destination'),
    reticulumGetLocalIdentityPublicKeyBase64: () => rpc('transport:identity'),
    reticulumGetStatus: () =>
      client.state === 'idle'
        ? Promise.resolve({ running: false })
        : rpc('transport:status'),
    getSystemCallReadiness: async () => ({
      status: 'unknown',
      reasons: [],
      cpuLoad: null,
      memoryPressure: 0,
      eventLoopLagMs: 0,
      measuredAt: Date.now(),
    }),
    listScreenShareSources: async () => ({
      success: true,
      sources: [
        {
          id: 'browser',
          name: i18n.t('reticulum:hosted.choose_screen'),
          thumbnail: '',
          appIcon: '',
        },
      ],
    }),
  };
  hostWindow.hub = { getIceServers: async () => config.iceServers ?? [] };
  const qappMethods = {
    qappReticulumRequest: 'qapp:rns:request',
    qappReticulumConnect: 'qapp:rns:connect',
    qappReticulumSend: 'qapp:rns:send',
    qappReticulumClose: 'qapp:rns:close',
    qappReticulumCleanupOwner: 'qapp:cleanup',
    privateChannelOpen: 'qapp:private:open',
    privateChannelSend: 'qapp:private:send',
    privateChannelStatus: 'qapp:private:status',
    privateChannelClose: 'qapp:private:close',
    privateChannelCleanupOwner: 'qapp:cleanup',
    qappMoqOpen: 'qapp:moq:open',
    qappMoqSubscribe: 'qapp:moq:subscribe',
    qappMoqPublish: 'qapp:moq:publish',
    qappMoqMetrics: 'qapp:moq:metrics',
    qappMoqClose: 'qapp:moq:close',
    qappMoqCleanupOwner: 'qapp:cleanup',
    qappGuestRelease: 'qapp:cleanup',
  };
  for (const [name, channel] of Object.entries(qappMethods))
    hostWindow.electronAPI[name] = (...args: unknown[]) =>
      rpc(channel, ...args);
  hostWindow.electronAPI.onQAppReticulumEvent = (callback: any) =>
    client.on('qapp:rns', callback);
  hostWindow.electronAPI.onPrivateChannelEvent = (callback: any) =>
    client.on('qapp:private', callback);
  hostWindow.electronAPI.onQAppMoqEvent = (callback: any) =>
    client.on('qapp:moq', callback);
  hostWindow.qortalLandRealtime = hostWindow.qortalLandGames = {
    getTransportBootstrap: async () => {
      const bootstrap = await rpc('land:bootstrap');
      if (!bootstrap) return null;
      const url = new URL(config.daemonUrl);
      url.searchParams.set('land', bootstrap.token);
      return { ...bootstrap, url: url.href };
    },
    onTransportRestarted: (callback: any) =>
      client.on('land:restarted', callback),
  };
  installResources(client);
  installFileOffers(client);
  let engine:
    | Promise<
        import('../lib/group-call/groupCallAudioEngineRuntime').GroupCallAudioEngineRuntime
      >
    | undefined;
  const audioListeners = new Set<(event: any) => void>();
  const getEngine = () =>
    (engine ??= import('../lib/group-call/groupCallAudioEngineRuntime').then(
      ({ GroupCallAudioEngineRuntime }) => {
        const runtime = new GroupCallAudioEngineRuntime();
        runtime.onEvent((event) =>
          audioListeners.forEach((callback) => callback(event))
        );
        runtime.start();
        return runtime;
      }
    ));
  hostWindow.audioSurface = {
    isReady: async () => Boolean(engine),
    ensureReady: async () => {
      await getEngine();
      return { success: true };
    },
    sendCommand: async (command: any) =>
      (await getEngine()).handleCommand(command),
    onEvent: (callback: any) => {
      audioListeners.add(callback);
      return () => audioListeners.delete(callback);
    },
    getWindowRole: async () => 'main',
  };
  window.addEventListener('message', (event) => {
    if (
      event.source === window &&
      event.origin === location.origin &&
      event.data?.type === 'backgroundMessage' &&
      event.data.action === 'logout'
    ) {
      client.disconnect();
      void engine?.then((runtime) =>
        runtime.handleCommand({ type: 'logout-cleanup' })
      );
    }
  });
  window.addEventListener('pagehide', () => {
    client.disconnect();
    void engine?.then((runtime) => runtime.dispose());
  });
}

function installFileOffers(client: HostedClient) {
  const api = (window as any).electronAPI;
  const selected = new Map<string, File>();
  const download = new Map<string, string>();
  api.qchatFileSelect = () =>
    new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.addEventListener(
        'cancel',
        () => resolve({ ok: false, canceled: true }),
        { once: true }
      );
      input.addEventListener(
        'change',
        async () => {
          const file = input.files?.[0];
          if (!file) {
            resolve({ ok: false, canceled: true });
            return;
          }
          if (file.size > 128 * 1024 * 1024) {
            resolve({
              ok: false,
              error: i18n.t('core:message.error.file_too_large', {
                filename: file.name,
                size: 128,
              }),
            });
            return;
          }
          const id = crypto.randomUUID();
          selected.set(id, file);
          const sha256 = Array.from(
            new Uint8Array(
              await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
            ),
            (b) => b.toString(16).padStart(2, '0')
          ).join('');
          resolve({
            ok: true,
            file: { path: id, name: file.name, size: file.size, sha256 },
          });
        },
        { once: true }
      );
      input.click();
    });
  api.qchatFileSend = async (payload: any) => {
    const file = selected.get(payload.filePath);
    if (!file) throw new Error(i18n.t('reticulum:hosted.connection_failed'));
    const id = await client.rpc('upload:begin', {
      size: file.size,
      namespace: 'reticulum-dm-resource',
      fileName: file.name,
      mimeType: file.type,
    });
    for (let offset = 0; offset < file.size; offset += 512 * 1024)
      await client.rpc(
        'upload:chunk',
        id,
        new Uint8Array(
          await file.slice(offset, offset + 512 * 1024).arrayBuffer()
        ),
        offset
      );
    const { manifest } = await client.rpc('upload:finish', id);
    selected.delete(payload.filePath);
    return client.rpc('files:send', {
      ...payload,
      filePath: manifest.fileHash,
    });
  };
  api.qchatFileChooseSavePath = async (name: string) => {
    const id = crypto.randomUUID();
    download.set(id, name);
    return { ok: true, path: id };
  };
  api.qchatFileAccept = async (payload: any) => {
    const name = download.get(payload.savePath);
    if (name) download.set(payload.transferId, name);
    return client.rpc('files:accept', payload);
  };
  api.onQchatFileTransferEvent = (callback: any) =>
    client.on('files:event', async (payload) => {
      callback(payload);
      if (payload.status === 'received' && payload.resourceHash) {
        const name = download.get(payload.transferId);
        download.delete(payload.transferId);
        await (window as any).reticulumResources.saveAs(
          payload.resourceHash,
          name
        );
      }
    });
  client.on('presence:cleared', () => {
    selected.clear();
    download.clear();
  });
}
