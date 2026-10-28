import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai';
import type { PresenceSession } from '../../electron/src/presence';
import { onlineAddressesAtom, statusMapAtom } from '../atoms/presence';
import { connectPresence } from './presence';

function fixture() {
  const store = createStore();
  const listeners = new Map<string, (value?: any) => void>();
  const snapshots: Array<(value: PresenceSession[]) => void> = [];
  const on = (name: string) => (callback: (value?: any) => void) => {
    listeners.set(name, callback);
    return () => {
      listeners.delete(name);
    };
  };
  const stop = connectPresence(store, {
    getAllOnline: () => new Promise((resolve) => snapshots.push(resolve)),
    onUpdate: on('update'),
    onCleared: on('clear'),
    onResync: on('resync'),
  });
  const session = (address: string, status = 'online', lastSeen = 1) =>
    ({ address, status, lastSeen }) as PresenceSession;
  return { store, listeners, snapshots, stop, session };
}

describe('NuQloud presence reader', () => {
  it('loads the daemon snapshot and applies online, busy, idle and offline updates', async () => {
    const f = fixture();
    f.snapshots[0]([f.session('Q-peer'), f.session('Q-peer', 'busy', 2)]);
    await Promise.resolve();
    expect(f.store.get(onlineAddressesAtom).has('Q-peer')).toBe(true);
    expect(f.store.get(statusMapAtom).get('Q-peer')).toBe('busy');
    for (const status of ['online', 'busy', 'idle']) {
      f.listeners.get('update')!({ address: 'Q-peer', online: true, status });
      expect(f.store.get(statusMapAtom).get('Q-peer')).toBe(status);
    }
    f.listeners.get('update')!({
      address: 'Q-peer',
      online: false,
      status: null,
    });
    expect(f.store.get(onlineAddressesAtom).size).toBe(0);
    expect(f.store.get(statusMapAtom).size).toBe(0);
    f.stop();
  });

  it('preserves updates received while a snapshot is in flight and repairs dropped events', async () => {
    const f = fixture();
    f.listeners.get('update')!({
      address: 'Q-peer',
      online: false,
      status: null,
    });
    f.snapshots[0]([f.session('Q-peer')]);
    await Promise.resolve();
    expect(f.store.get(onlineAddressesAtom).size).toBe(0);
    f.listeners.get('resync')!();
    f.snapshots[1]([f.session('Q-new', 'idle')]);
    await Promise.resolve();
    expect([...f.store.get(onlineAddressesAtom)]).toEqual(['Q-new']);
    expect(f.store.get(statusMapAtom).get('Q-new')).toBe('idle');
    f.stop();
  });

  it('rejects late snapshots after disconnection, resync or account teardown', async () => {
    const f = fixture();
    f.listeners.get('clear')!();
    f.snapshots[0]([f.session('Q-stale')]);
    await Promise.resolve();
    expect(f.store.get(statusMapAtom).size).toBe(0);
    f.listeners.get('resync')!();
    f.listeners.get('resync')!();
    f.snapshots[2]([f.session('Q-current')]);
    f.snapshots[1]([f.session('Q-old')]);
    await Promise.resolve();
    expect([...f.store.get(onlineAddressesAtom)]).toEqual(['Q-current']);
    f.listeners.get('resync')!();
    f.stop();
    f.snapshots[3]([f.session('Q-after-logout')]);
    await Promise.resolve();
    expect(f.store.get(onlineAddressesAtom).size).toBe(0);
    expect(f.listeners.size).toBe(0);
  });
});
