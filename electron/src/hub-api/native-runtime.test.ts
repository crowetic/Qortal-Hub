import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import nacl from 'tweetnacl';
import { expect, it } from 'vitest';
import {
  ReticulumChatManager,
  buildReticulumChatSignedFields,
  hashReticulumChatPayload,
  type ReticulumChatEvent,
} from '../reticulum-chat';
import {
  base58Encode,
  canonicalizeForSigning,
  deriveAddressFromPublicKey,
} from '../presence';
import { HubApiRuntime } from './runtime';
import { startHubApi } from './server';

it('round-trips a signed event through HTTP and the native RCHAT validator and history', async () => {
  // Test identity only. No Electron, Core, or live Reticulum peers are contacted.
  const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  const publicKey = base58Encode(key.publicKey);
  const address = deriveAddressFromPublicKey(publicKey);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-api-native-'));
  const manager = new ReticulumChatManager({
    dbPath: path.join(directory, 'chat.db'),
    hasGoodOverlayHealth: () => false,
    validateGroupMember: async (groupId, author) =>
      groupId === 716 && author === address,
  });
  manager.setLocalDmAddresses([address]);
  manager.setLocalGroupMemberships([{ groupId: 716, localAddress: address }]);
  const runtime = new HubApiRuntime(manager, address, () => true);
  const api = await startHubApi(
    {
      host: '127.0.0.1',
      port: 0,
      authUrl: 'http://127.0.0.1:3191',
      walletId: 'test-wallet',
      address,
      groupIds: [716],
      origins: [],
    },
    async () => ({ address, publicKey }),
    async () => runtime
  );
  try {
    const bound = api.server.address();
    if (!bound || typeof bound === 'string')
      throw new Error('Expected TCP server');
    const base = `http://127.0.0.1:${bound.port}`;
    const post = (route: string, body: unknown) =>
      fetch(`${base}${route}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const reserve = await post('/v1/groups/716/sequences', {});
    expect(reserve.status).toBe(201);
    const { authorStreamId, authorSeq } = await reserve.json();
    const event: ReticulumChatEvent = {
      eventId: 'api-native-event',
      groupId: 716,
      channelId: 'general',
      authorAddress: address,
      authorPublicKey: publicKey,
      authorStreamId,
      authorSeq,
      timestamp: Date.now(),
      eventType: 'message',
      encryptedPayload: 'ciphertext',
      payloadHash: hashReticulumChatPayload('ciphertext'),
      mentionAddressHashes: [],
      signature: '',
    };
    const sign = () => {
      event.signature = base58Encode(
        nacl.sign.detached(
          new Uint8Array(
            canonicalizeForSigning(buildReticulumChatSignedFields(event))
          ),
          key.secretKey
        )
      );
    };
    sign();
    const invalid = await post('/v1/groups/716/events', {
      ...event,
      encryptedPayload: 'tampered',
    });
    expect(invalid.status).toBe(422);
    expect(manager.getHistory(716, 'general', 10)).toEqual([]);

    const next = await post('/v1/groups/716/sequences', {});
    const nextSequence = await next.json();
    event.authorStreamId = nextSequence.authorStreamId;
    event.authorSeq = nextSequence.authorSeq;
    sign();
    const accepted = await post('/v1/groups/716/events', event);
    expect(accepted.status).toBe(202);
    const history = await fetch(
      `${base}/v1/groups/716/channels/general/events`,
      {
        headers: { Authorization: 'Bearer test' },
      }
    );
    expect((await history.json()).events).toEqual([
      expect.objectContaining(event),
    ]);

    // Mutating an API snapshot must not change the authenticated runtime account.
    manager.getLocalAccountAddresses().splice(0);
    expect(manager.getLocalAccountAddresses()).toEqual([address]);
    manager.setLocalDmAddresses([]);
    expect(
      (
        await fetch(`${base}/v1/status`, {
          headers: { Authorization: 'Bearer test' },
        })
      ).status
    ).toBe(503);
  } finally {
    await api.close();
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
