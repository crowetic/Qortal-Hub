const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  generateKeyPairSync,
  sign,
  randomBytes,
  randomUUID,
} = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocket } = require('ws');
const native = require('../dist/native.js');
const root = path.resolve(__dirname, '..');
const origin = 'https://hub.test';
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
function wallet() {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = native.base58Encode(
    keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  );
  return {
    ...keys,
    publicKey,
    address: native.deriveAddressFromPublicKey(publicKey),
  };
}
function signature(w, fields) {
  return native.base58Encode(
    sign(null, native.canonicalizeForSigning(fields), w.privateKey)
  );
}
async function connect(
  url,
  w,
  altered = false,
  clientId = randomBytes(16).toString('hex')
) {
  const ws = new WebSocket(url, { origin });
  const pending = new Map(),
    events = [];
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('session startup timed out')),
      25000
    );
    ws.on('error', reject);
    ws.once('close', () => {
      clearTimeout(timeout);
      reject(new Error('session closed'));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString(), (_key, value) =>
        value?.$hubBinary ? Buffer.from(value.$hubBinary, 'base64') : value
      );
      if (msg.type === 'challenge') {
        const fields = {
          type: 'HUB_BROWSER_SESSION',
          nonce: msg.nonce,
          clientId,
          origin: msg.origin,
          address: w.address,
          publicKey: w.publicKey,
          timestamp: Date.now(),
        };
        ws.send(
          JSON.stringify({
            ...fields,
            type: 'authenticate',
            signature: signature(w, {
              ...fields,
              nonce: altered ? 'x' : fields.nonce,
            }),
          })
        );
      }
      if (msg.type === 'ready') {
        clearTimeout(timeout);
        resolve(msg);
      }
      if (msg.type === 'event') events.push(msg);
      if (msg.type === 'result') {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (p) {
          clearTimeout(p.timer);
          msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
        }
      }
      if (msg.type === 'sign') {
        const fields = {
          ...msg.fields,
          authorAddress: w.address,
          authorPublicKey: w.publicKey,
        };
        ws.send(
          JSON.stringify({
            type: 'signed',
            id: msg.id,
            result: {
              authorAddress: w.address,
              authorPublicKey: w.publicKey,
              signature: signature(w, fields),
            },
          })
        );
      }
    });
  });
  const info = await ready;
  return {
    ws,
    info,
    events,
    wallet: w,
    clientId,
    rpc(channel, ...args) {
      return new Promise((resolve, reject) => {
        const id = randomUUID(),
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('rpc timeout ' + channel));
          }, 20000);
        pending.set(id, { resolve, reject, timer });
        ws.send(
          JSON.stringify({ type: 'rpc', id, channel, args }, (_key, value) =>
            Buffer.isBuffer(value)
              ? { $hubBinary: value.toString('base64') }
              : value?.type === 'Buffer'
                ? { $hubBinary: Buffer.from(value.data).toString('base64') }
                : value
          )
        );
      });
    },
  };
}
async function until(fn, message, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    assert.ok(Date.now() < deadline, message);
    await delay(150);
  }
}

test(
  'browser wallet proof works without External Auth: real Reticulum chat, DM, calls, resources and isolation',
  { timeout: 150000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hosted-'));
    const wallets = [wallet(), wallet()];
    let output = '',
      hub;
    const clients = [];
    const ports = await Promise.all([port(), port(), port(), port()]);
    const [api, browser, rns, control] = ports;
    const core = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/groups/member/'))
        res.end(JSON.stringify([{ groupId: 716, isOpen: true }]));
      else if (req.url.startsWith('/groups/members/716'))
        res.end(
          JSON.stringify({
            members: wallets.map((w) => ({
              member: w.address,
              isAdmin: false,
            })),
          })
        );
      else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise((r) => core.listen(0, '127.0.0.1', r));
    fs.mkdirSync(path.join(directory, 'rns'), { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'rns/config'),
      `[reticulum]\nenable_transport = False\nshare_instance = Yes\nshared_instance_type = tcp\nshared_instance_port = ${rns}\ninstance_control_port = ${control}\ninstance_name = hosted-test-${process.pid}\n[logging]\nloglevel = 4\n[interfaces]\n`
    );
    const env = {
      ...process.env,
      DISPLAY: '',
      WAYLAND_DISPLAY: '',
      QORTAL_HUB_DATA_DIR: directory,
      QORTAL_HUB_API_PORT: String(api),
      QORTAL_HUB_BROWSER_PORT: String(browser),
      QORTAL_HUB_BROWSER_ENABLED: '1',
      QORTAL_HUB_API_ORIGINS: origin,
      QORTAL_HUB_API_AUTH_URL: 'http://127.0.0.1:1',
      QORTAL_HUB_CORE_URL: `http://127.0.0.1:${core.address().port}`,
      QORTAL_HUB_RNS_PORT: String(rns),
      QORTAL_HUB_RNS_CONTROL_PORT: String(control),
      QORTAL_HUB_CUSTOM_RNS_CONFIG: '1',
    };
    try {
      hub = spawn(process.execPath, [path.join(root, 'dist/index.js')], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [hub.stdout, hub.stderr])
        stream.on('data', (b) => (output = (output + b).slice(-100000)));
      await until(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${api}/healthz`)).ok;
        } catch {
          return false;
        }
      }, 'daemon startup');
      const url = `ws://127.0.0.1:${browser}/realtime`;
      await assert.rejects(connect(url, wallets[0], true));
      const rejectedOrigin = new WebSocket(url, {
        origin: 'https://evil.test',
      });
      await new Promise((resolve) => {
        rejectedOrigin.once('error', resolve);
      });
      for (const w of wallets) clients.push(await connect(url, w));
      const [a, b] = clients;
      for (const c of clients) {
        const timestamp = Date.now();
        const sessionId = `P${Buffer.from(c.info.destinationHash, 'hex').toString('base64url')}${randomBytes(10).toString('base64url').slice(0, 13)}`;
        const fields = {
          type: 'PRESENCE_ANNOUNCE',
          address: c.wallet.address,
          publicKey: c.wallet.publicKey,
          sessionId,
          status: 'online',
          clientVersion: '1.0.0',
          timestamp,
        };
        assert.equal(
          (
            await c.rpc('presence:announce', {
              id: randomBytes(12).toString('base64url'),
              type: fields.type,
              senderAddress: fields.address,
              timestamp,
              payload: Object.fromEntries(
                Object.entries(fields).filter(
                  ([k]) => !['type', 'timestamp'].includes(k)
                )
              ),
              signature: signature(c.wallet, fields),
            })
          ).success,
          true
        );
      }
      await delay(2000);
      await until(async () => {
        for (const c of clients) {
          const timestamp = Date.now();
          const sessionId = `P${Buffer.from(c.info.destinationHash, 'hex').toString('base64url')}${'a'.repeat(13)}`;
          const fields = {
            type: 'PRESENCE_ANNOUNCE',
            address: c.wallet.address,
            publicKey: c.wallet.publicKey,
            sessionId,
            status: 'online',
            clientVersion: '1.0.0',
            timestamp,
          };
          const { type, timestamp: ts, ...payload } = fields;
          await c.rpc('presence:announce', {
            id: randomBytes(12).toString('base64url'),
            type,
            senderAddress: c.wallet.address,
            timestamp: ts,
            payload,
            signature: signature(c.wallet, fields),
          });
        }
        return (await a.rpc('presence:getOnlineAddresses')).includes(
          b.wallet.address
        );
      }, 'verified presence');
      await assert.rejects(
        a.rpc(
          'reticulumChat:getDirectHistory',
          b.wallet.address,
          a.wallet.address,
          10
        )
      );
      await assert.rejects(a.rpc('reticulumChat:subscribeGroup', 717));
      await assert.rejects(a.rpc('reticulumChat:constructor'));
      const seq = await a.rpc(
        'reticulumChat:reserveAuthorSequence',
        716,
        a.wallet.address
      );
      const event = {
        eventId: randomUUID(),
        groupId: 716,
        channelId: 'general',
        authorAddress: a.wallet.address,
        authorPublicKey: a.wallet.publicKey,
        ...seq,
        timestamp: Date.now(),
        eventType: 'message',
        encryptedPayload: 'hosted-group-payload',
        payloadHash: native.hashReticulumChatPayload('hosted-group-payload'),
        mentionAddressHashes: [],
      };
      event.signature = signature(
        a.wallet,
        native.buildReticulumChatSignedFields(event)
      );
      assert.equal(
        (await a.rpc('reticulumChat:publishEvent', event)).success,
        true
      );
      await until(
        async () =>
          (await b.rpc('reticulumChat:getHistory', 716, 'general', 10)).some(
            (e) => e.eventId === event.eventId
          ),
        'real group delivery'
      );
      const dm = {
        eventId: randomUUID(),
        conversationId: require('node:crypto')
          .createHash('sha256')
          .update(
            'rchat-dm-v1:' +
              [a.wallet.address, b.wallet.address].sort().join(':')
          )
          .digest('hex'),
        senderAddress: a.wallet.address,
        recipientAddress: b.wallet.address,
        senderPublicKey: a.wallet.publicKey,
        senderStreamId: await a.rpc(
          'reticulumChat:getDirectAuthorStreamId',
          a.wallet.address
        ),
        senderSeq: 1,
        timestamp: Date.now(),
        eventType: 'message',
        payload: 'hosted-dm-payload',
        payloadHash: native.hashReticulumChatPayload('hosted-dm-payload'),
      };
      dm.signature = signature(
        a.wallet,
        native.buildReticulumDmSignedFields(dm)
      );
      dm.legacySignature = signature(
        a.wallet,
        native.buildReticulumDmSignedFields({
          ...dm,
          senderStreamId: undefined,
        })
      );
      assert.equal(
        (await a.rpc('reticulumChat:publishDirectEvent', dm)).success,
        true
      );
      await until(
        async () =>
          (
            await b.rpc(
              'reticulumChat:getDirectHistory',
              b.wallet.address,
              a.wallet.address,
              10
            )
          ).some((e) => e.eventId === dm.eventId),
        'real DM delivery'
      );
      const bytes = Buffer.from('hosted file bytes');
      const upload = await a.rpc('upload:begin', {
        size: bytes.length,
        namespace: 'reticulum-dm-resource',
        fileName: 'test.txt',
        mimeType: 'text/plain',
      });
      await a.rpc('upload:chunk', upload, bytes, 0);
      const imported = await a.rpc('upload:finish', upload);
      assert.equal(imported.success, true);
      const downloaded = await a.rpc(
        'resource:read',
        imported.manifest.fileHash,
        0
      );
      assert.deepEqual(downloaded.bytes, bytes);
      await assert.rejects(
        b.rpc('resource:read', imported.manifest.fileHash, 0)
      );
      const callId = randomUUID(),
        timestamp = Date.now(),
        chatId = `direct:${[a.wallet.address, b.wallet.address].sort().join(':')}`;
      const callFields = {
        type: 'CALL_REQUEST',
        callId,
        chatId,
        fromAddress: a.wallet.address,
        fromPublicKey: a.wallet.publicKey,
        timestamp,
      };
      const initiated = await a.rpc(
        'call:initiate',
        b.wallet.address,
        chatId,
        a.wallet.address,
        signature(a.wallet, callFields),
        a.wallet.publicKey,
        callId,
        timestamp
      );
      assert.equal(initiated.success, true);
      await until(
        () =>
          b.events.some(
            (e) => e.channel === 'call:incoming' && e.payload.callId === callId
          ),
        'incoming call notification'
      );
      const acceptedAt = Date.now();
      assert.equal(
        (
          await b.rpc(
            'call:accept',
            callId,
            signature(b.wallet, {
              type: 'CALL_ACCEPT',
              callId,
              timestamp: acceptedAt,
            }),
            b.wallet.publicKey,
            acceptedAt
          )
        ).success,
        true
      );
      await until(
        () =>
          a.events.some(
            (e) => e.channel === 'call:accepted' && e.payload.callId === callId
          ),
        'accepted call'
      );
      const rtcPayload = JSON.stringify({
        kind: 'capability',
        audio: 'native-track',
        version: 1,
      });
      const rtc = {
        callId,
        generation: 'hostedrtc1',
        signalId: randomBytes(12).toString('base64url'),
        signalType: 'capability',
        payloadHash: native.hashReticulumChatPayload(rtcPayload),
        timestamp: Date.now(),
      };
      assert.equal(
        (
          await a.rpc('call:rtc-signal', {
            ...rtc,
            payload: rtcPayload,
            signature: signature(a.wallet, { ...rtc, type: 'CALL_RTC_SIGNAL' }),
            publicKey: a.wallet.publicKey,
          })
        ).success,
        true
      );
      await until(
        () =>
          b.events.some(
            (e) =>
              e.channel === 'call:rtc-signal' &&
              e.payload.callId === callId &&
              e.payload.generation === rtc.generation
          ),
        'authenticated RTC signaling'
      );
      const roomId = 'gcall-qortal-716';
      for (const c of clients) {
        const { publicKeyBase64 } = await c.rpc('transport:identity');
        const fields = {
          type: 'GC_JOIN',
          roomId,
          chatId: 'group:716',
          fromAddress: c.wallet.address,
          fromPublicKey: c.wallet.publicKey,
          timestamp: Date.now(),
          reticulumDestinationHash: c.info.destinationHash,
          joinGeneration: 1,
        };
        const rk = {
          ...fields,
          type: 'GC_JOIN_RK',
          reticulumIdentityPublicKeyBase64: publicKeyBase64,
        };
        assert.equal(
          (
            await c.rpc(
              'gcall:join',
              roomId,
              fields.chatId,
              fields.fromAddress,
              signature(c.wallet, fields),
              c.wallet.publicKey,
              fields.timestamp,
              c.info.destinationHash,
              1,
              0,
              publicKeyBase64,
              signature(c.wallet, rk)
            )
          ).success,
          true
        );
      }
      await until(
        async () =>
          (await a.rpc('gcall:getRoomParticipants', roomId)).length === 2 &&
          (await b.rpc('gcall:getRoomParticipants', roomId)).length === 2,
        'group call participants'
      );
      // File offers use the same native RNS transfer protocol as desktop peers.
      const transferId = 'qft-' + randomUUID();
      assert.equal(
        (
          await a.rpc('files:send', {
            transferId,
            senderAddress: a.wallet.address,
            recipientAddress: b.wallet.address,
            filePath: imported.manifest.fileHash,
            fileName: 'test.txt',
            size: bytes.length,
            sha256: imported.manifest.fileHash,
            expiresAt: Date.now() + 60000,
          })
        ).ok,
        true
      );
      const bIdentity = await b.rpc('transport:identity');
      const authFields = {
        type: 'QCHAT_FILE_LINK_AUTH',
        transferId,
        senderAddress: a.wallet.address,
        downloaderAddress: b.wallet.address,
        downloaderPublicKey: b.wallet.publicKey,
        downloaderReticulumDestinationHash: b.info.destinationHash,
        downloaderReticulumIdentityPublicKeyBase64: bIdentity.publicKeyBase64,
        timestamp: Date.now(),
      };
      const aIdentity = await a.rpc('transport:identity');
      assert.equal(
        (
          await b.rpc('files:accept', {
            transferId,
            senderAddress: a.wallet.address,
            recipientAddress: b.wallet.address,
            authMessage: {
              ...authFields,
              signature: signature(b.wallet, authFields),
            },
            senderReticulumDestinationHash: a.info.destinationHash,
            senderReticulumIdentityPublicKeyBase64: aIdentity.publicKeyBase64,
            fileName: 'test.txt',
            size: bytes.length,
            sha256: imported.manifest.fileHash,
          })
        ).ok,
        true
      );
      await until(
        () =>
          b.events.some(
            (e) =>
              e.channel === 'files:event' &&
              e.payload.status === 'received' &&
              e.payload.resourceHash === imported.manifest.fileHash
          ),
        'native direct file transfer'
      );
      assert.deepEqual(
        (await b.rpc('resource:read', imported.manifest.fileHash, 0)).bytes,
        bytes
      );
      assert.ok(!output.includes('auth_access_denied'));
      assert.equal(fs.readdirSync(path.join(directory, 'accounts')).length, 2);
      a.ws.close();
      let resumed;
      await until(async () => {
        try {
          resumed = await connect(url, a.wallet, false, a.clientId);
          return true;
        } catch {
          return false;
        }
      }, 'browser session reconnect');
      clients.push(resumed);
      assert.equal(resumed.info.destinationHash, a.info.destinationHash);
      assert.ok(
        (
          await resumed.rpc('reticulumChat:getHistory', 716, 'general', 10)
        ).some((entry) => entry.eventId === event.eventId)
      );
    } catch (error) {
      fs.writeFileSync(path.join(directory, 'test.log'), output);
      console.error('Hosted diagnostics:', directory, output.slice(-5000));
      throw error;
    } finally {
      for (const c of clients) c.ws.close();
      if (hub && hub.exitCode === null) {
        const done = new Promise((r) => hub.once('exit', r));
        hub.kill('SIGTERM');
        const timeout = setTimeout(() => hub.kill('SIGKILL'), 10000);
        await done;
        clearTimeout(timeout);
      }
      await new Promise((r) => core.close(r));
      if (!fs.existsSync(path.join(directory, 'test.log')))
        fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);
