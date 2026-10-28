import type { createStore } from 'jotai';
import { onlineAddressesAtom, statusMapAtom } from '../atoms/presence';
import type { UserStatus } from '../atoms/presence';
import { buildPresenceSnapshot } from '../hooks/usePresence';
import type { PresenceSession } from '../../electron/src/presence';

type Update = { address: string; online: boolean; status: UserStatus | null };
type PresenceReader = {
  getAllOnline: () => Promise<PresenceSession[]>;
  onUpdate: (callback: (update: Update) => void) => () => void;
  onCleared: (callback: () => void) => () => void;
  onResync: (callback: () => void) => () => void;
};

// The account daemon announces/heartbeats. This entry only reads its verified
// presence; mounting the desktop lifecycle would create a second session.
export function connectPresence(
  store: ReturnType<typeof createStore>,
  reader: PresenceReader
) {
  let active = true;
  let revision = 0;
  let buffered: Map<string, Update> | null = null;
  const apply = (update: Update) => {
    store.set(onlineAddressesAtom, (previous) => {
      const next = new Set(previous);
      if (update.online) next.add(update.address);
      else next.delete(update.address);
      return next;
    });
    store.set(statusMapAtom, (previous) => {
      const next = new Map(previous);
      if (update.online) next.set(update.address, update.status ?? 'online');
      else next.delete(update.address);
      return next;
    });
  };
  const clear = () => {
    revision++;
    buffered = null;
    store.set(onlineAddressesAtom, new Set());
    store.set(statusMapAtom, new Map());
  };
  const refresh = () => {
    const expected = ++revision;
    buffered = new Map();
    void reader.getAllOnline().then(
      (sessions) => {
        if (!active || revision !== expected) return;
        const snapshot = buildPresenceSnapshot(sessions);
        store.set(onlineAddressesAtom, snapshot.onlineAddresses);
        store.set(statusMapAtom, snapshot.statusMap);
        for (const update of buffered?.values() ?? []) apply(update);
        buffered = null;
      },
      () => {
        if (active && revision === expected) clear();
      }
    );
  };
  const unsubscribe = reader.onUpdate((update) => {
    if (!active) return;
    buffered?.set(update.address, update);
    apply(update);
  });
  const unsubscribeCleared = reader.onCleared(clear);
  const unsubscribeResync = reader.onResync(refresh);
  refresh();
  return () => {
    active = false;
    unsubscribe();
    unsubscribeCleared();
    unsubscribeResync();
    clear();
  };
}
