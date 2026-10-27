import i18n from '../i18n/i18n';

export interface ResourceClient {
  rpc(channel: string, ...args: any[]): Promise<any>;
  on(channel: string, callback: (payload?: any) => void): () => void;
}

export function installResources(
  client: ResourceClient,
  maxBytes = 128 * 1024 * 1024,
  chunkSize = 512 * 1024,
  downloadActiveContent = false
) {
  const files = new Map<string, File>();
  const urls = new Map<string, string>();
  const upload = async (file: Blob, metadata: any) => {
    if (file.size > maxBytes)
      throw new Error(
        i18n.t('core:message.error.file_too_large', {
          filename: metadata.fileName || '',
          size: Math.floor(maxBytes / 1024 / 1024),
        })
      );
    const id = await client.rpc('upload:begin', {
      ...metadata,
      size: file.size,
    });
    for (let offset = 0; offset < file.size; offset += chunkSize)
      await client.rpc(
        'upload:chunk',
        id,
        new Uint8Array(
          await file.slice(offset, offset + chunkSize).arrayBuffer()
        ),
        offset
      );
    return client.rpc('upload:finish', id);
  };
  const getUrl = async (hash: string) => {
    const cached = urls.get(hash);
    if (cached) return { success: true, url: cached };
    const status = await client.rpc('resource:getStatus', hash);
    if (status.manifest?.sizeBytes > maxBytes)
      throw new Error(
        i18n.t('core:message.error.file_too_large', {
          filename: status.manifest.fileName,
          size: Math.floor(maxBytes / 1024 / 1024),
        })
      );
    if (!status.complete) return { success: false };
    const chunks: BlobPart[] = [];
    for (
      let offset = 0;
      offset < status.manifest.sizeBytes;
      offset += chunkSize
    ) {
      const { bytes } = await client.rpc(
        'resource:read',
        hash,
        offset,
        chunkSize
      );
      chunks.push(bytes);
    }
    const url = URL.createObjectURL(
      new Blob(chunks, {
        type:
          downloadActiveContent &&
          !/^image\/(png|jpeg|gif|webp)$/.test(status.manifest.mimeType)
            ? 'application/octet-stream'
            : status.manifest.mimeType,
      })
    );
    urls.set(hash, url);
    return { success: true, url, manifest: status.manifest };
  };
  client.on('presence:cleared', () => {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    files.clear();
  });
  (window as any).reticulumResources = {
    getPathForFile: (file: File) => {
      if (files.size >= 32) files.delete(files.keys().next().value);
      const id = crypto.randomUUID();
      files.set(id, file);
      return id;
    },
    importFilePath: async (payload: any) => {
      const file = files.get(payload.filePath);
      if (!file) throw new Error(i18n.t('reticulum:hosted.connection_failed'));
      const { filePath: _, ...metadata } = payload;
      const result = await upload(file, metadata);
      files.delete(payload.filePath);
      return result;
    },
    importBase64: async (payload: any) => {
      const binary = atob(String(payload.base64).replace(/^data:[^,]*,/, ''));
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const { base64: _, ...metadata } = payload;
      return upload(new Blob([bytes]), metadata);
    },
    getUrl,
    getStatus: (hash: string) => client.rpc('resource:getStatus', hash),
    getStorageStatus: () => client.rpc('resource:getStorageStatus'),
    cleanupStorage: () => client.rpc('resource:cleanupStorage'),
    saveAs: async (hash: string, name?: string) => {
      const result = await getUrl(hash);
      if (!result.success) return result;
      const link = document.createElement('a');
      link.href = result.url;
      link.download = name || result.manifest?.fileName || hash;
      link.click();
      return { success: true };
    },
    open: async (hash: string) => {
      const result = await getUrl(hash);
      if (downloadActiveContent && result.success) {
        const link = document.createElement('a');
        link.href = result.url;
        link.download = hash;
        link.click();
        return result;
      }
      if (result.success) window.open(result.url, '_blank', 'noopener');
      return result;
    },
  };
}
