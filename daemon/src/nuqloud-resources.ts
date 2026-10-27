import { randomBytes } from 'node:crypto';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { AccountWorker } from './accounts';
import { HubApiError } from '../../electron/src/hub-api/auth';

type Upload = {
  directory: string;
  handle: FileHandle;
  size: number;
  written: number;
  metadata: any;
  expiresAt: number;
  busy: boolean;
};
const stores = new WeakMap<AccountWorker, NuqloudUploads>();
export async function closeNuqloudUploads(worker: AccountWorker) {
  const store = stores.get(worker);
  if (store) {
    stores.delete(worker);
    await store.close();
  }
}
export function ownsNuqloudUpload(
  worker: AccountWorker,
  hash: string
): boolean {
  return stores.get(worker)?.owns(hash) === true;
}
export function uploadsFor(worker: AccountWorker) {
  let store = stores.get(worker);
  if (!store) {
    store = new NuqloudUploads(worker);
    stores.set(worker, store);
  }
  return store;
}
class NuqloudUploads {
  private uploads = new Map<string, Upload>();
  private starting = 0;
  private operations = new Set<Promise<unknown>>();
  private authored = new Map<string, number>();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private worker: AccountWorker) {
    this.timer = setInterval(() => {
      for (const [id, item] of this.uploads)
        if (!item.busy && (!worker.active || item.expiresAt < Date.now()))
          void this.remove(id, item);
      if (!worker.active) clearInterval(this.timer);
    }, 30000);
    this.timer.unref();
  }
  private async remove(id: string, item: Upload) {
    this.uploads.delete(id);
    await item.handle.close().catch(() => {});
    await rm(item.directory, { recursive: true, force: true });
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.operations]);
    await Promise.allSettled(
      [...this.uploads].map(([id, item]) => this.remove(id, item))
    );
    this.authored.clear();
  }
  owns(hash: string): boolean {
    return this.worker.groupIds.includes(this.authored.get(hash)!);
  }
  async invoke(method: string, args: any[]) {
    if (this.closed) throw new HubApiError(409, 'chat_upload_expired');
    const operation = this.perform(method, args);
    this.operations.add(operation);
    try {
      return await operation;
    } finally {
      this.operations.delete(operation);
    }
  }
  private async perform(method: string, args: any[]) {
    if (method === 'upload:begin') {
      const meta = args[0];
      const groupId = Number(meta?.metadata?.groupId);
      if (
        this.uploads.size + this.starting >= 2 ||
        !Number.isSafeInteger(meta?.size) ||
        meta.size < 1 ||
        meta.size > 8 * 1024 * 1024 ||
        meta.namespace !== 'reticulum-group-resource' ||
        !this.worker.groupIds.includes(groupId) ||
        meta.ownerId !== `${groupId}:${this.worker.principal.address}` ||
        typeof meta.fileName !== 'string' ||
        meta.fileName.length > 255 ||
        typeof meta.mimeType !== 'string' ||
        meta.mimeType.length > 128
      )
        throw new HubApiError(400, 'invalid_chat_upload');
      this.starting++;
      let directory: string | undefined;
      try {
        directory = await mkdtemp(
          path.join(this.worker.config.dataDir, 'nuqloud-upload-')
        );
        const id = randomBytes(16).toString('hex');
        this.uploads.set(id, {
          directory,
          handle: await open(path.join(directory, 'data'), 'wx', 0o600),
          size: meta.size,
          written: 0,
          metadata: meta,
          expiresAt: Date.now() + 120000,
          busy: false,
        });
        return id;
      } catch (error) {
        if (directory) await rm(directory, { recursive: true, force: true });
        throw error;
      } finally {
        this.starting--;
      }
    }
    const item = this.uploads.get(args[0]);
    if (!item || item.busy || item.expiresAt < Date.now())
      throw new HubApiError(409, 'chat_upload_expired');
    if (
      !this.worker.groupIds.includes(Number(item.metadata.metadata.groupId))
    ) {
      await this.remove(args[0], item);
      throw new HubApiError(403, 'group_not_allowed');
    }
    item.busy = true;
    try {
      if (method === 'upload:chunk') {
        if (
          !(args[1] instanceof Uint8Array) ||
          args[1].length < 1 ||
          args[1].length > 65536 ||
          args[2] !== item.written ||
          item.written + args[1].length > item.size
        )
          throw new HubApiError(400, 'invalid_chat_chunk');
        const { bytesWritten } = await item.handle.write(
          args[1],
          0,
          args[1].length,
          item.written
        );
        item.written += bytesWritten;
        item.expiresAt = Date.now() + 120000;
        return item.written;
      }
      if (method !== 'upload:finish' || item.written !== item.size)
        throw new HubApiError(400, 'incomplete_chat_upload');
      this.uploads.delete(args[0]);
      await item.handle.close();
      try {
        const { namespace, ownerId, fileName, mimeType, metadata } =
          item.metadata;
        const manifest = await this.worker.resources.importLocalFileAsync({
          sourcePath: path.join(item.directory, 'data'),
          namespace,
          ownerId,
          fileName: path.basename(fileName),
          mimeType,
          encrypted: false,
          metadata,
        });
        if (this.authored.size >= 256)
          this.authored.delete(this.authored.keys().next().value);
        this.authored.set(manifest.fileHash, Number(metadata.groupId));
        return { success: true, manifest };
      } finally {
        await rm(item.directory, { recursive: true, force: true });
      }
    } finally {
      item.busy = false;
    }
  }
}
