import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AccountWorker } from '../accounts';
import { runEd25519VerifySync } from '../../../electron/src/ed25519-verify-common';

/** Desktop file offers with opaque resource IDs in place of filesystem paths. */
export class HostedFiles {
  private outgoing = new Map<string, { recipient: string; expires: number }>();
  private incoming = new Map<
    string,
    {
      directory: string;
      path: string;
      size: number;
      sha256: string;
      name: string;
    }
  >();
  private unsubscribe: () => void;
  constructor(
    private worker: AccountWorker,
    private emit: (channel: string, payload: any) => void
  ) {
    const listener = (payload: any) => {
      void this.event(payload).catch(() => {
        emit('files:event', {
          transferId: payload?.transferId,
          status: 'failed',
          reason: 'transfer_failed',
        });
      });
    };
    worker.bridge.on('qchat-file-transfer', listener);
    this.unsubscribe = () => worker.bridge.off('qchat-file-transfer', listener);
  }
  async invoke(action: string, payload: any) {
    const address = this.worker.principal.address;
    if (
      !payload ||
      typeof payload.transferId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(payload.transferId) ||
      !Number.isSafeInteger(payload.size) ||
      payload.size < 1 ||
      payload.size > 128 * 1024 * 1024 ||
      typeof payload.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.sha256)
    )
      throw new Error('invalid_file_offer');
    if (action === 'send') {
      if (payload.senderAddress !== address || this.outgoing.size >= 32)
        throw new Error('invalid_sender');
      // A browser supplies only the hash of a file uploaded into its own store.
      const manifest = this.worker.resources.getManifest(payload.filePath);
      const filePath = this.worker.resources.getVerifiedAssembledPath(
        payload.filePath
      );
      if (
        !filePath ||
        !manifest ||
        manifest.fileHash !== payload.sha256 ||
        manifest.sizeBytes !== payload.size
      )
        throw new Error('invalid_file');
      const expires = Math.min(
        Number(payload.expiresAt) || Date.now() + 86400000,
        Date.now() + 7 * 86400000
      );
      this.outgoing.set(payload.transferId, {
        recipient: payload.recipientAddress,
        expires,
      });
      const result = await this.worker.bridge.sendQchatFileResource({
        transferId: payload.transferId,
        allowedRecipientAddress: payload.recipientAddress,
        filePath,
        fileName: manifest.fileName,
        size: manifest.sizeBytes,
        sha256: manifest.fileHash,
        expiresAt: expires,
      });
      return { ok: result.ok };
    }
    if (action === 'accept') {
      if (
        payload.recipientAddress !== address ||
        this.incoming.size >= 8 ||
        this.incoming.has(payload.transferId)
      )
        throw new Error('invalid_recipient');
      const auth = payload.authMessage;
      if (
        auth?.downloaderAddress !== address ||
        auth?.downloaderPublicKey !== this.worker.principal.publicKey ||
        auth?.downloaderReticulumDestinationHash !==
          this.worker.bridge.getLocalDestinationHash() ||
        auth?.senderAddress !== payload.senderAddress ||
        auth?.transferId !== payload.transferId
      )
        throw new Error('invalid_file_auth');
      const directory = await mkdtemp(
        path.join(this.worker.config.dataDir, 'qchat-')
      );
      const savePath = path.join(directory, 'data');
      this.incoming.set(payload.transferId, {
        directory,
        path: savePath,
        size: payload.size,
        sha256: payload.sha256,
        name: path.basename(payload.fileName || 'resource.bin'),
      });
      const result = await this.worker.bridge.acceptQchatFileResource({
        peerPresenceHash: payload.senderReticulumDestinationHash,
        reticulumIdentityPublicKeyBase64:
          payload.senderReticulumIdentityPublicKeyBase64,
        authMessage: auth,
        transferId: payload.transferId,
        savePath,
        fileName: path.basename(payload.fileName || 'resource.bin'),
        size: payload.size,
        sha256: payload.sha256,
      });
      if (!result.ok) await this.removeIncoming(payload.transferId);
      return { ok: result.ok };
    }
    throw new Error('method_not_allowed');
  }
  private async event(payload: any) {
    const transferId = String(payload?.transferId || '');
    if (payload?.status === 'auth') {
      const pending = this.outgoing.get(transferId),
        auth = payload.auth;
      const { signature, ...fields } = auth ?? {};
      const valid =
        pending &&
        pending.expires > Date.now() &&
        fields.type === 'QCHAT_FILE_LINK_AUTH' &&
        fields.transferId === transferId &&
        fields.senderAddress === this.worker.principal.address &&
        fields.downloaderAddress === pending.recipient &&
        Number.isSafeInteger(fields.timestamp) &&
        Math.abs(Date.now() - fields.timestamp) < 120_000 &&
        runEd25519VerifySync({
          kind: 'gc',
          fields,
          signature,
          fromPublicKey: fields.downloaderPublicKey,
          fromAddress: fields.downloaderAddress,
        });
      if (valid)
        await this.worker.bridge.authorizeQchatFileResource({
          transferId,
          linkId: payload.linkId,
        });
      else
        await this.worker.bridge.rejectQchatFileResource({
          transferId,
          linkId: payload.linkId,
          reason: 'invalid_file_auth',
        });
      return;
    }
    let resourceHash: string | undefined;
    if (payload.status === 'received') {
      const received = this.incoming.get(transferId);
      if (!received || (await stat(received.path)).size !== received.size)
        throw new Error('size_mismatch');
      try {
        const manifest = await this.worker.resources.importLocalFileAsync({
          sourcePath: received.path,
          namespace: 'reticulum-dm-resource',
          fileName: received.name,
        });
        if (manifest.fileHash !== received.sha256)
          throw new Error('hash_mismatch');
        resourceHash = manifest.fileHash;
      } finally {
        await this.removeIncoming(transferId);
      }
    }
    if (payload.status === 'sent') this.outgoing.delete(transferId);
    const clean: Record<string, unknown> = {};
    for (const key of [
      'transferId',
      'status',
      'progress',
      'bytesTransferred',
      'totalBytes',
      'size',
      'fileName',
      'sha256',
    ])
      if (payload[key] !== undefined) clean[key] = payload[key];
    this.emit('files:event', {
      ...clean,
      ...(resourceHash ? { resourceHash } : {}),
    });
  }
  private async removeIncoming(id: string) {
    const value = this.incoming.get(id);
    this.incoming.delete(id);
    if (value) await rm(value.directory, { recursive: true, force: true });
  }
  async close() {
    this.unsubscribe();
    this.outgoing.clear();
    await Promise.allSettled(
      [...this.incoming.keys()].map((id) => this.removeIncoming(id))
    );
  }
}
