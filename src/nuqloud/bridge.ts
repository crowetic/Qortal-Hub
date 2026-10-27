import i18n from '../i18n/i18n';
import { encodeWire, decodeWire } from '../hosted/wire';
import { installResources } from '../hosted/resources';

export type ChatConfiguration = {
  contractVersion: 1;
  context: string;
  account: { walletId: string; address: string; name: string };
  expiresAt: number;
  coreUrl: string;
  requestToken: string;
  language: string;
  theme: 'dark' | 'light';
  groups: { groupId: number; groupName: string }[];
};
export let configuration: ChatConfiguration;
const pending = new Map<
  string,
  {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const listeners = new Map<string, Set<(payload: any) => void>>();
const subscriptions = new Map<string, [number, string]>();
let cursor = 0;
let stopped = false;
let timer: ReturnType<typeof setTimeout>;
let onInvalidate = () => {};

export function onChatEvent(channel: string, callback: (payload: any) => void) {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel)!.add(callback);
  return () => {
    listeners.get(channel)?.delete(callback);
  };
}
function emit(channel: string, payload: any) {
  for (const callback of listeners.get(channel) ?? []) {
    try {
      Promise.resolve(callback(payload)).catch((error) =>
        console.warn('Chat event callback failed', error)
      );
    } catch (error) {
      console.warn('Chat event callback failed', error);
    }
  }
}
export function invalidateChat() {
  stopped = true;
  clearTimeout(timer);
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error(i18n.t('reticulum:nuqloud.session_ended')));
  }
  pending.clear();
  emit('presence:cleared', undefined);
  listeners.clear();
  subscriptions.clear();
  onInvalidate();
}
export function parentRequest(
  kind: string,
  payload: unknown = {}
): Promise<any> {
  if (stopped || !configuration || configuration.expiresAt <= Date.now())
    return Promise.reject(new Error(i18n.t('reticulum:nuqloud.session_ended')));
  if (pending.size >= 32)
    return Promise.reject(
      new Error(i18n.t('reticulum:nuqloud.request_failed'))
    );
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(i18n.t('reticulum:nuqloud.request_failed')));
    }, 55000);
    pending.set(id, { resolve, reject, timer: timeout });
    parent.postMessage(
      {
        type: 'nuqloud-chat-request',
        context: configuration.context,
        id,
        kind,
        payload,
      },
      location.origin
    );
  });
}
export const rpc = async (method: string, args: unknown[] = []) => {
  if (method === 'subscribeChannel')
    subscriptions.set(`${args[0]}:${args[1]}`, [
      Number(args[0]),
      String(args[1]),
    ]);
  if (method === 'unsubscribeChannel')
    subscriptions.delete(`${args[0]}:${args[1]}`);
  const response = await parentRequest('rpc', {
    method,
    args: JSON.parse(encodeWire(args)),
  });
  if (response?.contractVersion !== 1)
    throw new Error(i18n.t('reticulum:nuqloud.request_failed'));
  return decodeWire(JSON.stringify(response.result));
};

async function poll() {
  if (stopped) return;
  try {
    const result = await rpc('poll', [cursor]);
    if (stopped) return;
    cursor = result.cursor;
    for (const event of result.events ?? []) emit(event.channel, event.payload);
    if (result.resync) {
      for (const [groupId, channelId] of subscriptions.values()) {
        const page = await rpc('getMessageHistoryPage', [
          groupId,
          channelId,
          20,
        ]);
        if (!stopped)
          for (const event of page.events ?? []) emit('onEvent', { event });
        if (!stopped) emit('onSummaryChanged', { groupId, channelId });
      }
    }
  } catch (error) {
    if (!stopped) emit('onConnectionError', error);
  } finally {
    if (!stopped) timer = setTimeout(poll, document.hidden ? 10000 : 2000);
  }
}

export function initializeBridge(
  invalidate: () => void
): Promise<ChatConfiguration> {
  onInvalidate = invalidate;
  return new Promise((resolve) => {
    window.addEventListener('message', (event) => {
      if (event.source !== parent || event.origin !== location.origin) return;
      const message = event.data;
      if (message?.type === 'nuqloud-chat-config' && !configuration) {
        const next = message.configuration;
        if (
          next?.contractVersion !== 1 ||
          !next.context ||
          !next.account?.walletId ||
          !next.account?.address ||
          !Number.isFinite(next.expiresAt) ||
          next.expiresAt <= Date.now()
        )
          return;
        const core = new URL(next.coreUrl, location.href);
        if (core.origin !== location.origin) return;
        configuration = { ...next, coreUrl: core.href.replace(/\/$/, '') };
        stopped = false;
        void i18n.changeLanguage(next.language || 'en');
        const api: Record<string, any> = {};
        const methods = [
          'getReadinessStatus',
          'getChannelMetadataBundle',
          'getChannels',
          'getCategories',
          'getHistory',
          'getMessageHistory',
          'getMessageHistoryPage',
          'getMessageWindowAroundEvent',
          'getMessageWindowPageAroundEvent',
          'getDiscussionIndex',
          'getDiscussionMessages',
          'getChannelMetadataHistory',
          'getSyncState',
          'getSummaries',
          'getSubscriptions',
          'subscribeGroup',
          'unsubscribeGroup',
          'subscribeChannel',
          'unsubscribeChannel',
          'markRead',
          'markGroupsRead',
          'search',
          'indexSearchText',
          'deleteSearchText',
          'replaceMentions',
          'deleteMentions',
          'getSilence',
          'listSilences',
          'setSilence',
          'clearSilence',
          'reserveAuthorSequence',
          'releaseAuthorSequence',
          'publishEvent',
          'requestResource',
          'cancelResource',
          'getGroupCapabilities',
        ];
        for (const method of methods)
          api[method] = (...args: any[]) => rpc(method, args);
        for (const name of [
          'onEvent',
          'onSummaryChanged',
          'onTyping',
          'onSilenceChanged',
          'onReadinessChanged',
          'onResource',
        ])
          api[name] = (callback: (payload: any) => void) =>
            onChatEvent(name, callback);
        api.isEnabled = async () => true;
        api.sendTyping = async () => ({ success: false });
        api.updateMentionBadge = async () => ({ success: true });
        // Native publication has already applied metadata to the authoritative worker.
        api.applyChannelMetadata = async () => ({ success: true });
        api.getCalendarEvents = async () => [];
        api.getCalendarReminder = async () => null;
        api.onCalendarChanged = () => () => {};
        api.onCalendarReminderDue = () => () => {};
        (window as any).reticulumChat = api;
        (window as any).presence = {
          getStatus: (address: string) => rpc('presence:getStatus', [address]),
          getAllOnline: () => rpc('presence:getAllOnline'),
          getOnlineAddresses: () => rpc('presence:getOnlineAddresses'),
          onUpdate: (callback: (payload: any) => void) =>
            onChatEvent('onPresenceUpdate', callback),
          onUpdateBatch: (callback: (payload: any[]) => void) =>
            onChatEvent('onPresenceUpdate', (payload) => callback([payload])),
          onCleared: (callback: () => void) =>
            onChatEvent('presence:cleared', callback),
        };
        installResources(
          { rpc: (channel, ...args) => rpc(channel, args), on: onChatEvent },
          8 * 1024 * 1024,
          65536,
          true
        );
        (window as any).hubHosted = true;
        (window as any).nuqloudChat = true;
        void poll();
        resolve(configuration);
      } else if (
        message?.context === configuration?.context &&
        message.type === 'nuqloud-chat-invalidated'
      ) {
        invalidateChat();
      } else if (
        message?.context === configuration?.context &&
        message.type === 'nuqloud-chat-response'
      ) {
        const item = pending.get(message.id);
        if (!item) return;
        clearTimeout(item.timer);
        pending.delete(message.id);
        if (message.error)
          item.reject(new Error(i18n.t('reticulum:nuqloud.request_failed')));
        else item.resolve(message.result);
      }
    });
    parent.postMessage({ type: 'nuqloud-chat-ready' }, location.origin);
  });
}
