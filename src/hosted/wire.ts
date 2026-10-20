// JSON control frames preserve the opaque encrypted audio/attachment bytes.
// No paths, native handles, or executable objects cross this boundary.
export function encodeWire(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item === undefined) return { $hubUndefined: true };
    let bytes: Uint8Array | undefined;
    if (item instanceof ArrayBuffer) bytes = new Uint8Array(item);
    else if (ArrayBuffer.isView(item))
      bytes = new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
    else if (item?.type === 'Buffer' && Array.isArray(item.data))
      bytes = new Uint8Array(item.data);
    if (!bytes) return item;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { $hubBinary: btoa(binary) };
  });
}

export function decodeWire(text: string): any {
  return JSON.parse(text, (key, item) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      throw new Error('invalid_wire_key');
    if (item && typeof item === 'object' && '$hubUndefined' in item) {
      if (Object.keys(item).length !== 1 || item.$hubUndefined !== true)
        throw new Error('invalid_undefined');
      return undefined;
    }
    if (item && typeof item === 'object' && '$hubBinary' in item) {
      if (Object.keys(item).length !== 1 || typeof item.$hubBinary !== 'string')
        throw new Error('invalid_binary');
      return Uint8Array.from(atob(item.$hubBinary), (c) => c.charCodeAt(0));
    }
    return item;
  });
}
