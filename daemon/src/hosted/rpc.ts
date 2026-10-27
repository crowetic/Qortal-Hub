import { rm, readFile } from 'node:fs/promises';
import contract from '../../../src/hosted/rpc-contract.json';
import type { AccountWorker } from '../accounts';

const ownParameters = new Set([
  'authorAddress',
  'ownerAddress',
  'myAddress',
  'localAddress',
  'fromAddress',
]);
const success = { success: true };

export async function invokeHosted(
  worker: AccountWorker,
  channel: string,
  args: any[],
  emit: (channel: string, payload?: unknown) => void
): Promise<any> {
  if (!worker.active) throw new Error('account_closed');
  if (!Array.isArray(args) || args.length > 20) throw new Error('invalid_args');
  const address = worker.principal.address;
  const own = (value: unknown) => {
    if (value !== address) throw new Error('account_mismatch');
  };
  const group = (id: unknown) => {
    if (!Number.isSafeInteger(id) || !worker.groupIds.includes(Number(id)))
      throw new Error('group_membership_required');
  };
  const entry = Object.hasOwn(contract, channel) ? contract[channel] : null;
  if (channel === 'transport:destination')
    return { destinationHash: worker.bridge.getLocalDestinationHash() };
  if (channel === 'transport:identity')
    return {
      publicKeyBase64: await worker.bridge.getLocalIdentityPublicKeyBase64(),
    };
  if (channel === 'transport:status')
    return {
      running: worker.bridge.getState() === 'ready',
      ...worker.bridge.getConnectivitySnapshot(),
    };
  if (entry) {
    entry.params.forEach((key, i) => {
      if (ownParameters.has(key) && args[i] != null) own(args[i]);
      if (key === 'publicKey' && args[i] !== worker.principal.publicKey)
        throw new Error('account_mismatch');
      if (key === 'groupId' && args[i] != null) group(args[i]);
      if (['roomId', 'chatId'].includes(key)) {
        const match = /^(?:gcall-qortal-|group:)(\d+)/.exec(String(args[i]));
        if (match) group(Number(match[1]));
      }
    });
  }
  for (const arg of args) {
    if (
      arg &&
      typeof arg === 'object' &&
      !Array.isArray(arg) &&
      !(arg instanceof Uint8Array)
    ) {
      for (const key of [
        'authorAddress',
        'fromAddress',
        'ownerAddress',
        'localAddress',
      ])
        if (arg[key] !== undefined) own(arg[key]);
    }
  }
  if (channel.startsWith('presence:')) {
    const action = channel.slice(9);
    if (['announce', 'heartbeat', 'offline'].includes(action)) {
      const envelope = args[0];
      own(envelope?.senderAddress);
      own(envelope?.payload?.address);
      if (envelope?.payload?.publicKey !== worker.principal.publicKey)
        throw new Error('account_mismatch');
      if (
        envelope.type !==
        `PRESENCE_${action === 'announce' ? 'ANNOUNCE' : action.toUpperCase()}`
      )
        throw new Error('invalid_presence_type');
      if (!(await worker.presence.handleEnvelope(envelope, { kind: 'local' })))
        throw new Error('invalid_signature');
      return { success: await worker.bridge.publish(envelope) };
    }
    if (action === 'getStatus') return worker.presence.getStatus(args[0]);
    if (action === 'getOnlineAddresses')
      return worker.presence.getOnlineAddresses();
    if (action === 'getAllOnline') return worker.presence.getAllOnline();
    // The browser signs fresh heartbeats on demand; private keys never leave it.
    if (['heartbeatSchedulerStart', 'heartbeatSchedulerStop'].includes(action))
      return success;
  }
  if (channel === 'reticulumChat:isEnabled') return true;
  if (channel === 'reticulumChat:getReadinessStatus')
    return {
      state: worker.bridge.getState() === 'ready' ? 'ready' : 'starting',
      revision: 1,
    };
  if (channel === 'reticulumChat:clearLocalAccountState') {
    await worker.close();
    return success;
  }
  if (channel === 'reticulumChat:setLocalGroupMemberships') {
    // Never trust renderer supplied membership/admin flags.
    await worker.refreshMemberships();
    return success;
  }
  if (
    [
      'reticulumChat:setLocalDmAddresses',
      'call:setLocalAddresses',
      'gcall:setLocalAddresses',
    ].includes(channel)
  ) {
    if (!Array.isArray(args[0]) || args[0].some((a: unknown) => a !== address))
      throw new Error('account_mismatch');
    return success;
  }
  if (channel === 'reticulumChat:updateMentionBadge') return success;
  if (channel === 'gcall:setQortalGroupReticulumTargets') return success;
  if (channel === 'gcall:setWatchedQortalGroupIds')
    args[0] = (Array.isArray(args[0]) ? args[0] : []).filter((id: number) =>
      worker.groupIds.includes(id)
    );
  if (channel === 'gcall:getAudioDataPlaneSession')
    return { ok: false, reason: 'hosted_websocket_audio' };
  if (channel === 'gcall:request-key-replay') {
    worker.groupCalls.replayRetainedVerifiedKeyStatesTo({ send: emit });
    return success;
  }
  if (channel === 'gcall:join') {
    const [
      room,
      chat,
      local,
      signature,
      publicKey,
      timestamp,
      destination,
      generation,
      epoch,
      identity,
      rkSignature,
      role,
      takeover,
      peer,
      callId,
    ] = args;
    own(local);
    if (
      publicKey !== worker.principal.publicKey ||
      destination !== worker.bridge.getLocalDestinationHash()
    )
      throw new Error('account_mismatch');
    const match = /^gcall-qortal-(\d+)$/.exec(room);
    if (match) group(Number(match[1]));
    const direct =
      String(room).startsWith('dmv:') && String(chat).startsWith('direct:');
    const trusted = direct
      ? (worker.calls.getActiveMediaPeerDestinationHash(chat, local, callId) ??
        worker.manager.getActiveLandCallMediaPeerDestinationHash(
          chat,
          local,
          callId
        ))
      : null;
    if (direct && callId && !trusted)
      throw new Error('unverified_dm_voice_peer_destination');
    const session = worker.groupCalls.joinRoom(
      room,
      chat,
      local,
      signature,
      publicKey,
      timestamp,
      destination,
      generation,
      epoch,
      identity,
      rkSignature,
      role,
      takeover,
      trusted ?? peer,
      Boolean(trusted),
      trusted ? callId : undefined
    );
    return {
      success: true,
      callSessionId: session.callSessionId,
      mediaSessionGeneration: session.mediaSessionGeneration,
    };
  }
  if (channel.startsWith('resource:'))
    return resource(worker, channel.slice(9), args);
  if (!entry?.method) throw new Error('method_not_allowed');
  if (
    channel === 'reticulumChat:publishEvent' ||
    channel === 'reticulumChat:publishDirectEvent'
  ) {
    const direct = channel.endsWith(':publishDirectEvent');
    own(direct ? args[0]?.senderAddress : args[0]?.authorAddress);
    if (
      (direct ? args[0]?.senderPublicKey : args[0]?.authorPublicKey) !==
      worker.principal.publicKey
    )
      throw new Error('account_mismatch');
    if (!direct) group(args[0]?.groupId);
  }
  if (channel === 'reticulumChat:sendLandChat') {
    own(args[0]?.authorAddress);
    group(args[0]?.groupId);
  }
  if (channel === 'reticulumChat:markGroupsRead') args[0].forEach(group);
  if (channel === 'reticulumChat:search')
    args[1] = {
      ...args[1],
      groupIds: (args[1]?.groupIds ?? worker.groupIds).filter((id: number) =>
        worker.groupIds.includes(id)
      ),
    };
  if (channel === 'reticulumChat:setActiveDirectChat') {
    worker.manager.setActiveDirectChat(args[0], args[1], args[2] === true);
    return success;
  }
  if (channel === 'gcall:sendAudio' || channel === 'gcall:sendAudioBatch') {
    if (!(args[2] instanceof Uint8Array) || args[2].length > 12288)
      throw new Error('invalid_audio');
    args[2] = Buffer.from(args[2]);
    if (
      channel.endsWith('Batch') &&
      (!Array.isArray(args[1]) || args[1].length > 32)
    )
      throw new Error('invalid_targets');
  }
  const target = channel.startsWith('call:')
    ? worker.calls
    : channel.startsWith('gcall:')
      ? worker.groupCalls
      : worker.manager;
  const result = await target[entry.method](...args);
  if (channel === 'call:initiate')
    return result
      ? { success: true, callId: result }
      : { success: false, error: 'target_offline' };
  if (channel === 'call:accept') return { success: Boolean(result) };
  if (channel === 'gcall:getLinkStats') return { success: true, stats: result };
  if (channel === 'gcall:requestSessionBreak')
    return { success: result.ok, error: result.error };
  if (
    channel.endsWith(':getDirectExpiryPreference') ||
    channel.endsWith(':setDirectExpiryPreference')
  )
    return { success: Boolean(result), preference: result };
  if (channel.endsWith(':setSilence') || channel.endsWith(':clearSilence'))
    return { success: true, silence: result };
  if (result && typeof result.ok === 'boolean')
    return {
      ...result,
      success: result.ok,
      error: result.error ?? result.reason,
    };
  if (
    /:(applyChannelMetadata|indexSearchText|deleteSearchText|replaceMentions|deleteMentions)$/.test(
      channel
    )
  )
    return { success: result };
  return result === undefined ? success : result;
}

async function resource(worker: AccountWorker, action: string, args: any[]) {
  const store = worker.resources;
  if (action === 'import') {
    const payload = args[0];
    if (
      !(payload?.bytes instanceof Uint8Array) ||
      payload.bytes.length > 512 * 1024
    )
      throw new Error('invalid_upload');
    // Chunked uploads are assembled in the worker's own private temp directory.
    throw new Error('use_upload_chunks');
  }
  if (action === 'getStorageStatus')
    return { success: true, status: store.getStorageStatus() };
  if (action === 'cleanupStorage')
    return {
      success: true,
      result: await store.cleanupStorage('manual'),
      status: store.getStorageStatus(),
    };
  const hash = args[0];
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
    throw new Error('invalid_hash');
  const manifest = store.getManifest(hash);
  if (!manifest) throw new Error('resource_not_found');
  if (action === 'getStatus') {
    const complete = Boolean(store.getVerifiedAssembledPath(hash));
    const bytes = complete ? manifest.sizeBytes : store.getCompletedBytes(hash);
    return {
      success: true,
      manifest,
      complete,
      bytesTransferred: bytes,
      totalBytes: manifest.sizeBytes,
      progress: manifest.sizeBytes ? bytes / manifest.sizeBytes : 1,
      runtime: worker.manager.getResourceDownloadStatus(hash),
      checkedAt: Date.now(),
    };
  }
  if (action === 'read') {
    const length = args[2] ?? 512 * 1024;
    if (!Number.isSafeInteger(length) || length < 1 || length > 512 * 1024)
      throw new Error('invalid_range');
    const start = args[1],
      end = Math.min(manifest.sizeBytes, start + length);
    if (!Number.isSafeInteger(start) || start < 0 || start > manifest.sizeBytes)
      throw new Error('invalid_range');
    const range = await store.readByteRangeAsync(hash, start, end);
    try {
      return { manifest, bytes: await readFile(range.path) };
    } finally {
      await rm(range.path, { force: true });
    }
  }
  throw new Error('method_not_allowed');
}
