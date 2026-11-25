import type { HostedClient } from './client';
import { HostedRequestError } from './errors';

type Owner = { tabId: string; service: string; name: string };
type Connection = { ownerKey: string; connectionId: string };
type RnsEvent = Connection & {
  action: string;
  state?: string;
  reason?: string;
  payload?: unknown;
};

const ownerKey = (owner: Owner) =>
  `${owner.tabId}\u0000${owner.service}\u0000${owner.name}`;

/** Browser socket replacement destroys the daemon's per-session logical IDs. */
export function installHostedQappReticulum(
  client: Pick<HostedClient, 'on' | 'rpc' | 'state'>,
  api: Record<string, any>
) {
  const connections = new Map<string, Connection>();
  const closed = new Set<string>();
  const listeners = new Set<(event: RnsEvent) => void>();
  let generation = 0;
  const emit = (event: RnsEvent) => {
    for (const listener of listeners) {
      try {
        Promise.resolve(listener(event)).catch(() => {});
      } catch {
        // One stale Q-App view must not prevent other views from being reset.
      }
    }
  };
  client.on('qapp:rns', (event: RnsEvent) => {
    if (event?.action === 'RNS_CONNECTION_STATE' && event.state === 'CLOSED') {
      connections.delete(event.connectionId);
      closed.add(event.connectionId);
      if (closed.size > 128) closed.delete(closed.values().next().value);
    }
    emit(event);
  });
  client.on('state', (state) => {
    if (state !== 'disconnected' && state !== 'idle') return;
    generation++;
    const previous = [...connections.values()];
    connections.clear();
    closed.clear();
    for (const connection of previous)
      emit({
        ...connection,
        action: 'RNS_CONNECTION_STATE',
        state: 'CLOSED',
        reason: 'RNS_TRANSPORT_RESET',
      });
  });
  api.qappReticulumRequest = (...args: unknown[]) =>
    client.rpc('qapp:rns:request', ...args);
  api.qappReticulumConnect = async (owner: Owner, destination: string) => {
    // Snapshot the owner before awaiting; only the trusted shell supplies it.
    const key = ownerKey(owner);
    const attempt = generation;
    const result = await client.rpc('qapp:rns:connect', owner, destination);
    if (
      client.state !== 'connected' ||
      attempt !== generation ||
      closed.has(result.connectionId)
    )
      throw new HostedRequestError('connection');
    connections.set(result.connectionId, {
      ownerKey: key,
      connectionId: result.connectionId,
    });
    return result;
  };
  api.qappReticulumSend = (...args: unknown[]) =>
    client.rpc('qapp:rns:send', ...args);
  api.qappReticulumClose = (owner: Owner, connectionId: string) => {
    if (connections.get(connectionId)?.ownerKey === ownerKey(owner))
      connections.delete(connectionId);
    return client.rpc('qapp:rns:close', owner, connectionId);
  };
  const cleanup = (owner: Owner) => {
    const key = ownerKey(owner);
    for (const [id, connection] of connections)
      if (connection.ownerKey === key) connections.delete(id);
    return client.rpc('qapp:cleanup', owner);
  };
  api.qappReticulumCleanupOwner = cleanup;
  api.qappGuestRelease = cleanup;
  api.onQAppReticulumEvent = (listener: (event: RnsEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
}
