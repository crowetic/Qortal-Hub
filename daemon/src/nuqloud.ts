import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AccountWorker } from './accounts';
import { invokeHosted } from './hosted/rpc';
import { HubApiError } from '../../electron/src/hub-api/auth';
import { encodeWire, decodeWire } from '../../src/hosted/wire';
import { uploadsFor, ownsNuqloudUpload } from './nuqloud-resources';

// Deliberately smaller than the wallet-authenticated hosted browser contract.
// Publications use the existing leased /groups/:id/events endpoint, not RPC.
const methods = new Set([
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
  'requestResource',
  'cancelResource',
]);
type QueuedEvent = {
  cursor: number;
  channel: string;
  payload: any;
  bytes: number;
};
const queues = new WeakMap<
  AccountWorker,
  {
    cursor: number;
    droppedThrough: number;
    bytes: number;
    events: QueuedEvent[];
  }
>();

function queueFor(worker: AccountWorker) {
  let queue = queues.get(worker);
  if (queue) return queue;
  queue = { cursor: 0, droppedThrough: 0, bytes: 0, events: [] };
  queues.set(worker, queue);
  const append = (channel: string, payload: unknown) => {
    const bytes = Buffer.byteLength(JSON.stringify(payload ?? null));
    const item = { cursor: ++queue!.cursor, channel, payload, bytes };
    if (bytes > 1024 * 1024) {
      queue!.droppedThrough = item.cursor;
      return;
    }
    queue!.events.push(item);
    queue!.bytes += bytes;
    while (queue!.events.length > 256 || queue!.bytes > 2 * 1024 * 1024) {
      const removed = queue!.events.shift()!;
      queue!.droppedThrough = removed.cursor;
      queue!.bytes -= removed.bytes;
    }
  };
  worker.manager.on('event', (payload) => append('onEvent', payload));
  worker.manager.on('summaryChanged', (payload) =>
    append('onSummaryChanged', payload)
  );
  worker.manager.on('silenceChanged', (payload) =>
    append('onSilenceChanged', payload)
  );
  worker.manager.on('resource', (payload) => append('onResource', payload));
  worker.presence?.on('presence-updated', (payload) =>
    append('onPresenceUpdate', payload)
  );
  return queue;
}

function readable(worker: AccountWorker, payload: any): boolean {
  if (payload?.fileHash && payload?.eventId) {
    return (
      worker.groupIds.includes(Number(payload.groupId)) &&
      worker.manager.canReadGroupResourceReference(
        Number(payload.groupId),
        payload.eventId,
        payload.fileHash
      )
    );
  }
  const event = payload?.event ?? payload?.lastEvent ?? payload;
  if (event?.groupId == null) return false;
  try {
    worker.runtime.assertChannel(
      Number(event.groupId),
      event.channelId || 'general'
    );
    return worker.groupIds.includes(Number(event.groupId));
  } catch {
    return false;
  }
}

export function nuqloudAccount(
  worker: AccountWorker,
  uiRoot = path.resolve(__dirname, 'nuqloud-ui')
) {
  const queue = queueFor(worker);
  return {
    available: existsSync(path.join(uiRoot, 'index.html')),
    async request(body: Record<string, any>) {
      const { method } = body;
      let args: any[];
      try {
        args = decodeWire(JSON.stringify(body.args));
      } catch {
        throw new HubApiError(400, 'invalid_chat_request');
      }
      if (
        Object.keys(body).some((key) => !['method', 'args'].includes(key)) ||
        typeof method !== 'string' ||
        !Array.isArray(args) ||
        args.length > 8
      )
        throw new HubApiError(400, 'invalid_chat_request');
      worker.runtime.assertAccount();
      if (
        [
          'presence:getStatus',
          'presence:getAllOnline',
          'presence:getOnlineAddresses',
        ].includes(method)
      )
        return invokeHosted(worker, method, args, () => {});
      if (method === 'getGroupCapabilities') {
        if (!Number.isSafeInteger(args[0]))
          throw new HubApiError(400, 'invalid_group_id');
        return worker.groupCapabilities(args[0]);
      }
      if (['upload:begin', 'upload:chunk', 'upload:finish'].includes(method)) {
        const result = await uploadsFor(worker).invoke(method, args);
        return JSON.parse(encodeWire(result));
      }
      if (
        [
          'resource:getStatus',
          'resource:read',
          'resource:getStorageStatus',
        ].includes(method)
      ) {
        if (method !== 'resource:getStorageStatus') {
          const hash = args[0];
          if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
            throw new HubApiError(400, 'invalid_resource_hash');
          // A peer's manifest ownerId is metadata, not proof of local authorship.
          const authored = ownsNuqloudUpload(worker, hash);
          const referenced = worker.resources
            .listReferences(hash)
            .some(
              (ref) =>
                ref.scopeType === 'group' &&
                worker.groupIds.includes(Number(ref.scopeId)) &&
                !!ref.eventId &&
                worker.manager.canReadGroupResourceReference(
                  Number(ref.scopeId),
                  ref.eventId,
                  hash
                )
            );
          if (!authored && !referenced)
            throw new HubApiError(403, 'resource_access_denied');
        }
        if (method === 'resource:read')
          args[2] = Math.min(Number(args[2]) || 65536, 65536);
        return JSON.parse(
          encodeWire(await invokeHosted(worker, method, args, () => {}))
        );
      }
      if (method === 'poll') {
        const cursor = args[0] ?? 0;
        if (!Number.isSafeInteger(cursor) || cursor < 0)
          throw new HubApiError(400, 'invalid_cursor');
        let bytes = 0;
        const events = [];
        let next = Math.min(cursor, queue.cursor);
        let more = false;
        for (const item of queue.events) {
          if (item.cursor <= cursor) continue;
          if (bytes + item.bytes > 1024 * 1024) {
            more = true;
            break;
          }
          next = item.cursor;
          if (
            item.channel !== 'onPresenceUpdate' &&
            !readable(worker, item.payload)
          )
            continue;
          events.push({ channel: item.channel, payload: item.payload });
          bytes += item.bytes;
        }
        if (!more) next = queue.cursor;
        return {
          cursor: next,
          events,
          resync: cursor > queue.cursor || cursor < queue.droppedThrough,
        };
      }
      if (!methods.has(method))
        throw new HubApiError(400, 'chat_method_not_allowed');
      if (
        /^(getHistory|getMessageHistory|getMessageHistoryPage)$/.test(method)
      ) {
        if (typeof args[1] !== 'string')
          throw new HubApiError(400, 'channel_required');
        worker.runtime.assertChannel(args[0], args[1]);
        args[2] = Math.min(20, Math.max(1, Number(args[2]) || 20));
      }
      if (/^(getDiscussion|getMessageWindow)/.test(method))
        worker.runtime.assertChannel(args[0], args[1]);
      if (
        method === 'requestResource' &&
        !worker.manager.canReadGroupResourceReference(
          args[0],
          args[2],
          args[1]?.fileHash
        )
      )
        throw new HubApiError(403, 'resource_access_denied');
      try {
        let result = await invokeHosted(
          worker,
          `reticulumChat:${method}`,
          args,
          () => {}
        );
        if (Buffer.byteLength(JSON.stringify(result ?? null)) > 2800000)
          throw new HubApiError(413, 'chat_response_too_large');
        return result ?? null;
      } catch (error) {
        if (error instanceof HubApiError) throw error;
        throw new HubApiError(403, 'chat_operation_refused');
      }
    },
    async asset(name: string) {
      // Assets are built with the daemon; there is no caller-selected filesystem root.
      if (
        !/^(?:index\.html|build-info\.json|assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|ttf|png|webp|svg|gif))$/.test(
          name
        )
      )
        throw new HubApiError(400, 'invalid_chat_asset');
      const root = uiRoot;
      let filename: string;
      try {
        filename = await realpath(path.join(root, name));
        if (!filename.startsWith(`${await realpath(root)}${path.sep}`))
          throw new Error();
        if ((await stat(filename)).size > 12 * 1024 * 1024) throw new Error();
      } catch {
        throw new HubApiError(404, 'chat_ui_build_required');
      }
      const bytes = await readFile(filename);
      const types = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.gif': 'image/gif',
      };
      return {
        contractVersion: 1,
        contentType: types[path.extname(name)],
        data: bytes.toString('base64'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    },
  };
}
