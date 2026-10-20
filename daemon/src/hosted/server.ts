import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { AccountWorker } from '../accounts';
import type { DaemonConfig } from '../config';
import { deriveAddressFromPublicKey } from '../../../electron/src/presence';
import { runEd25519VerifySync } from '../../../electron/src/ed25519-verify-common';
import { encodeWire, decodeWire } from '../../../src/hosted/wire';
import { invokeHosted } from './rpc';
import { HostedFiles } from './files';
import { HostedQapps } from './qapps';

export async function startHostedServer(config: DaemonConfig) {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    perMessageDeflate: false,
  });
  const active = new Map<string, WebSocket>();
  const landTickets = new Map<
    string,
    { owner: WebSocket; worker: AccountWorker; expires: number }
  >();
  const workers = new Set<AccountWorker>();
  const starting = new Set<Promise<AccountWorker>>();
  const cleanupTasks = new Set<Promise<unknown>>();
  let closing = false;
  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    // Exact Origin and loopback authority, also when behind the supplied proxy.
    const authority = `${config.api.host === '::1' ? '[::1]' : config.api.host}:${config.browserPort}`;
    if (
      closing ||
      request.headers.host !== authority ||
      !origin ||
      !config.api.origins.includes(origin) ||
      wss.clients.size >= config.maxAccounts * 3
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname !== '/realtime') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', () => {});
      const land = url.searchParams.get('land');
      if (land) {
        const ticket = landTickets.get(land);
        landTickets.delete(land);
        const bootstrap =
          ticket?.worker.bridge.getQortalLandGameTransportBootstrap();
        if (
          !ticket ||
          ticket.owner.readyState !== WebSocket.OPEN ||
          ticket.expires < Date.now() ||
          !bootstrap
        ) {
          ws.close(1008);
          return;
        }
        proxyLand(ws, ticket.owner, bootstrap, land);
      } else void session(ws, origin).catch(() => ws.close(1011));
    });
  });

  async function session(ws: WebSocket, origin: string) {
    const nonce = randomBytes(32).toString('base64url');
    const signers = new Map<
      string,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();
    const removers: Array<() => void> = [];
    const uploads = new Map<
      string,
      {
        directory: string;
        handle: Awaited<ReturnType<typeof open>>;
        size: number;
        written: number;
        metadata: any;
      }
    >();
    let worker: AccountWorker | undefined,
      address = '',
      accountKey = '',
      authenticating = false,
      inFlight = 0;
    let files: HostedFiles | undefined;
    let qapps: HostedQapps | undefined;
    let pendingWorker: Promise<AccountWorker> | undefined;
    let heartbeat: NodeJS.Timeout | undefined,
      alive = true;
    let rateAt = Date.now(),
      rate = 0;
    const send = (value: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 8 * 1024 * 1024) {
        ws.close(1013);
        return;
      }
      ws.send(encodeWire(value));
    };
    const emit = (channel: string, payload?: unknown) =>
      send({ type: 'event', channel, payload });
    const authTimer = setTimeout(() => ws.close(1008), 15_000);
    const sweep = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
      if (worker && !worker.active) ws.close(1008);
    }, 30_000);
    ws.on('pong', () => {
      alive = true;
      if (worker) worker.lastUsed = Date.now();
    });
    ws.once('close', () => {
      clearTimeout(authTimer);
      clearInterval(sweep);
      clearInterval(heartbeat);
      for (const remove of removers) remove();
      for (const pending of signers.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('browser_disconnected'));
      }
      signers.clear();
      for (const upload of uploads.values())
        void upload.handle
          .close()
          .then(() => rm(upload.directory, { recursive: true, force: true }));
      uploads.clear();
      for (const [id, ticket] of landTickets)
        if (ticket.owner === ws) landTickets.delete(id);
      const cleanup = (async () => {
        const account = worker ?? (await pendingWorker?.catch(() => undefined));
        await qapps?.close();
        await account?.close();
        await files?.close();
        if (account) workers.delete(account);
        if (active.get(accountKey) === ws) active.delete(accountKey);
      })();
      cleanupTasks.add(cleanup);
      void cleanup.finally(() => cleanupTasks.delete(cleanup)).catch(() => {});
    });
    send({ type: 'challenge', nonce, origin });
    ws.on('message', (data, binary) => {
      if (binary) {
        ws.close(1008);
        return;
      }
      if (Date.now() - rateAt > 1000) {
        rateAt = Date.now();
        rate = 0;
      }
      if (++rate > 1000) {
        ws.close(1008);
        return;
      }
      void message(data.toString()).catch(() => ws.close(1008));
    });
    async function message(text: string) {
      const msg = decodeWire(text);
      if (!msg || typeof msg !== 'object') throw new Error('invalid_frame');
      if (msg.type === 'signed') {
        const pending = signers.get(msg.id);
        if (pending) {
          signers.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) pending.reject(new Error('signing_failed'));
          else pending.resolve(msg.result);
        }
        return;
      }
      if (!worker) {
        if (authenticating || msg.type !== 'authenticate')
          throw new Error('authentication_required');
        authenticating = true;
        const { publicKey, signature, timestamp, clientId } = msg;
        if (typeof clientId !== 'string' || !/^[a-f0-9]{32}$/.test(clientId))
          throw new Error('invalid_client_id');
        address = deriveAddressFromPublicKey(publicKey);
        if (
          typeof publicKey !== 'string' ||
          publicKey.length > 64 ||
          !address ||
          typeof signature !== 'string' ||
          signature.length > 100 ||
          !Number.isSafeInteger(timestamp) ||
          Math.abs(Date.now() - timestamp) > 30_000
        )
          throw new Error('invalid_identity');
        const fields = {
          type: 'HUB_BROWSER_SESSION',
          nonce,
          origin,
          clientId,
          address,
          publicKey,
          timestamp,
        };
        if (
          !runEd25519VerifySync({
            kind: 'presence',
            signedFields: fields,
            signature,
            publicKeyBase58: publicKey,
          })
        )
          throw new Error('invalid_signature');
        accountKey = `${address}:${clientId}`;
        if (active.has(accountKey) || active.size >= config.maxAccounts)
          throw new Error('account_limit');
        active.set(accountKey, ws);
        const signer = (
          kind: 'presence' | 'chat',
          fields: Record<string, unknown>
        ) =>
          new Promise<any>((resolve, reject) => {
            if (ws.readyState !== WebSocket.OPEN || signers.size >= 64) {
              reject(new Error('signer_unavailable'));
              return;
            }
            const id = randomBytes(12).toString('base64url');
            const timer = setTimeout(() => {
              signers.delete(id);
              reject(new Error('signing_timeout'));
            }, 10_000);
            signers.set(id, { resolve, reject, timer });
            send({ type: 'sign', id, kind, fields });
          });
        pendingWorker = AccountWorker.create(
          config,
          `browser:${accountKey}`,
          { address, publicKey },
          '',
          signer
        );
        starting.add(pendingWorker);
        let created: AccountWorker;
        try {
          created = await pendingWorker;
        } finally {
          starting.delete(pendingWorker);
        }
        if (ws.readyState !== WebSocket.OPEN || closing) {
          await created.close();
          return;
        }
        worker = created;
        workers.add(worker);
        clearTimeout(authTimer);
        files = new HostedFiles(worker, emit);
        qapps = new HostedQapps(worker, signer, emit);
        const bind = (
          source: NodeJS.EventEmitter,
          name: string,
          channel: string
        ) => {
          const listener = (payload: unknown) => emit(channel, payload);
          source.on(name, listener);
          removers.push(() => source.removeListener(name, listener));
        };
        for (const name of [
          'event',
          'typing',
          'landState',
          'landChat',
          'landAction',
          'landCall',
          'summaryChanged',
          'directEvent',
          'directCallHistory',
          'directTyping',
          'directSummaryChanged',
          'resource',
          'silenceChanged',
          'calendarChanged',
          'calendarReminderDue',
        ])
          bind(worker.manager, name, `reticulumChat:${name}`);
        for (const name of [
          'incoming',
          'accepted',
          'rejected',
          'hangup',
          'rtc-signal',
        ])
          bind(worker.calls, `call:${name}`, `call:${name}`);
        for (const name of [
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
          'qortal-group-call-activity',
        ])
          bind(worker.groupCalls, `gcall:${name}`, `gcall:${name}`);
        bind(worker.presence, 'presence-updated', 'presence:update');
        bind(
          worker.bridge,
          'qortalland-game-transport-restarted',
          'land:restarted'
        );
        heartbeat = setInterval(
          () => emit('presence:heartbeat-request'),
          25_000
        );
        send({
          type: 'ready',
          address,
          destinationHash: worker.bridge.getLocalDestinationHash(),
        });
        emit('presence:started');
        emit('reticulumChat:readiness', { state: 'ready', revision: 1 });
        return;
      }
      if (
        msg.type !== 'rpc' ||
        typeof msg.id !== 'string' ||
        msg.id.length > 64 ||
        typeof msg.channel !== 'string' ||
        !Array.isArray(msg.args)
      )
        throw new Error('invalid_rpc');
      if (inFlight >= 32) {
        send({ type: 'result', id: msg.id, error: 'busy' });
        return;
      }
      inFlight++;
      try {
        worker.lastUsed = Date.now();
        await worker.refreshMemberships();
        let result: unknown;
        if (msg.channel === 'land:bootstrap') {
          const bootstrap = worker.bridge.getQortalLandGameTransportBootstrap();
          if (!bootstrap) result = null;
          else {
            for (const [key, ticket] of landTickets)
              if (ticket.expires < Date.now()) landTickets.delete(key);
            if (landTickets.size >= config.maxAccounts * 4)
              throw new Error('ticket_limit');
            const token = randomBytes(32).toString('base64url');
            landTickets.set(token, {
              owner: ws,
              worker,
              expires: Date.now() + 30_000,
            });
            result = { token, instanceId: bootstrap.instanceId };
          }
        } else if (msg.channel.startsWith('upload:'))
          result = await upload(msg.channel, msg.args);
        else if (msg.channel.startsWith('files:'))
          result = await files!.invoke(msg.channel.slice(6), msg.args[0]);
        else if (msg.channel.startsWith('qapp:'))
          result = await qapps!.invoke(msg.channel, msg.args);
        else result = await invokeHosted(worker, msg.channel, msg.args, emit);
        send({ type: 'result', id: msg.id, result });
      } catch (error) {
        // Never leak filesystem paths, bearer values or upstream errors.
        console.warn(
          'Hosted operation failed',
          msg.channel,
          error instanceof Error ? error.message : 'unknown'
        );
        send({ type: 'result', id: msg.id, error: 'operation_failed' });
      } finally {
        inFlight--;
      }
    }
    async function upload(channel: string, args: any[]) {
      if (channel === 'upload:begin') {
        const meta = args[0];
        if (
          uploads.size >= 2 ||
          !Number.isSafeInteger(meta?.size) ||
          meta.size < 1 ||
          meta.size > 128 * 1024 * 1024 ||
          !['reticulum-group-resource', 'reticulum-dm-resource'].includes(
            meta.namespace
          )
        )
          throw new Error('invalid_upload');
        const id = randomBytes(16).toString('hex');
        const directory = await mkdtemp(path.join(config.dataDir, 'upload-'));
        uploads.set(id, {
          directory,
          handle: await open(path.join(directory, 'data'), 'wx', 0o600),
          size: meta.size,
          written: 0,
          metadata: meta,
        });
        return id;
      }
      const item = uploads.get(args[0]);
      if (!item) throw new Error('unknown_upload');
      if (channel === 'upload:chunk') {
        if (
          !(args[1] instanceof Uint8Array) ||
          args[1].length > 512 * 1024 ||
          args[2] !== item.written ||
          item.written + args[1].length > item.size
        )
          throw new Error('invalid_chunk');
        const { bytesWritten } = await item.handle.write(
          args[1],
          0,
          args[1].length,
          item.written
        );
        item.written += bytesWritten;
        return item.written;
      }
      if (channel === 'upload:finish') {
        if (item.written !== item.size) throw new Error('incomplete_upload');
        uploads.delete(args[0]);
        await item.handle.close();
        try {
          const {
            namespace,
            ownerId,
            fileName,
            mimeType,
            encrypted,
            metadata,
          } = item.metadata;
          const manifest = await worker!.resources.importLocalFileAsync({
            sourcePath: path.join(item.directory, 'data'),
            namespace,
            ownerId,
            fileName: path.basename(fileName || 'resource.bin'),
            mimeType,
            encrypted: encrypted === true,
            metadata,
          });
          return { success: true, manifest };
        } finally {
          await rm(item.directory, { recursive: true, force: true });
        }
      }
      throw new Error('method_not_allowed');
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.browserPort, config.api.host, resolve);
  });
  return {
    server,
    async close() {
      closing = true;
      for (const ws of wss.clients) ws.terminate();
      await Promise.allSettled([...starting]);
      await Promise.allSettled([...cleanupTasks]);
      await Promise.allSettled([...workers].map((worker) => worker.close()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function proxyLand(
  ws: WebSocket,
  owner: WebSocket,
  bootstrap: { url: string; token: string; instanceId: string },
  ticket: string
) {
  let upstream: WebSocket | undefined;
  const timeout = setTimeout(() => ws.close(1008), 10_000);
  const stop = () => {
    clearTimeout(timeout);
    upstream?.terminate();
    ws.close();
  };
  owner.once('close', stop);
  ws.once('close', () => {
    owner.removeListener('close', stop);
    clearTimeout(timeout);
    upstream?.terminate();
  });
  ws.once('message', (data, binary) => {
    let auth: any;
    try {
      auth = JSON.parse(data.toString());
    } catch {
      ws.close(1008);
      return;
    }
    if (
      binary ||
      auth.type !== 'AUTH' ||
      auth.token !== ticket ||
      auth.instanceId !== bootstrap.instanceId
    ) {
      ws.close(1008);
      return;
    }
    clearTimeout(timeout);
    upstream = new WebSocket(bootstrap.url, { maxPayload: 1024 * 1024 });
    upstream.on('error', () => ws.close(1011));
    upstream.once('open', () => {
      upstream!.send(
        JSON.stringify({
          type: 'AUTH',
          token: bootstrap.token,
          instanceId: bootstrap.instanceId,
        })
      );
      ws.on('message', (frame, isBinary) => {
        if (
          upstream?.readyState !== WebSocket.OPEN ||
          upstream.bufferedAmount > 4 * 1024 * 1024
        ) {
          ws.close(1013);
          return;
        }
        upstream.send(frame, { binary: isBinary });
      });
    });
    upstream.on('message', (frame, isBinary) => {
      if (
        ws.readyState === WebSocket.OPEN &&
        ws.bufferedAmount < 4 * 1024 * 1024
      )
        ws.send(frame, { binary: isBinary });
      else stop();
    });
    upstream.once('close', () => ws.close());
  });
}
