const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const native = require('../dist/native.js');

test('ordinary Node verifies and persists native RCHAT with real SQLite', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-node-sqlite-'));
  native.configureNativeRuntimeEnvironment({
    path: () => directory,
    resources: () => path.resolve(__dirname, '../dist/resources'),
    packaged: () => false,
    ready: () => true,
  });
  const pair = generateKeyPairSync('ed25519');
  const publicKey = native.base58Encode(
    pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  );
  const address = native.deriveAddressFromPublicKey(publicKey);
  const options = {
    dbPath: path.join(directory, 'chat.db'),
    validateGroupMember: async (id, author) => id === 716 && author === address,
    hasGoodOverlayHealth: () => false,
  };
  let manager = new native.ReticulumChatManager(options);
  const setAccount = () => {
    manager.setLocalDmAddresses([address]);
    manager.setLocalGroupMemberships([{ groupId: 716, localAddress: address }]);
  };
  try {
    setAccount();
    const sequence = await manager.reserveAuthorSequence(716, address);
    const event = {
      eventId: 'node-sqlite-test',
      groupId: 716,
      channelId: 'general',
      authorAddress: address,
      authorPublicKey: publicKey,
      ...sequence,
      timestamp: Date.now(),
      eventType: 'message',
      encryptedPayload: 'native-event-payload',
      payloadHash: native.hashReticulumChatPayload('native-event-payload'),
      mentionAddressHashes: [],
      signature: '',
    };
    event.signature = native.base58Encode(
      sign(
        null,
        native.canonicalizeForSigning(
          native.buildReticulumChatSignedFields(event)
        ),
        pair.privateKey
      )
    );
    assert.equal(native.verifyReticulumChatEvent(event), true);
    assert.equal(
      (await manager.publishEvent({ ...event, encryptedPayload: 'tampered' }))
        .ok,
      false
    );
    assert.equal((await manager.publishEvent(event)).ok, true);
    manager.close();
    manager = new native.ReticulumChatManager(options);
    setAccount();
    assert.equal(
      manager.getHistory(716, 'general', 10)[0].eventId,
      event.eventId
    );
    const Database = require('better-sqlite3');
    const db = new Database(options.dbPath, { readonly: true });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
