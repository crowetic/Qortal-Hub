import type { AccountWorker } from './accounts';
import { HubApiError } from '../../electron/src/hub-api/auth';
import {
  calculateReticulumGroupScore,
  type ReticulumGroupScoreBreakdown,
} from '../../src/lib/reticulum/groupScore';

const SLOT_MS = 6 * 60 * 60_000;
const MAX_STALE_MS = 24 * 60 * 60_000;
type PublicGroup = {
  groupId: number;
  created: number;
  memberCount: number;
  balance: number;
};
type Cache = {
  directory?: PublicGroup[];
  capturedAt: number;
  offset: number;
  slot: number;
  scores: Map<number, { slot: number; value: ReticulumGroupScoreBreakdown }>;
  refresh?: Promise<void>;
  retryAfter: number;
};
const caches = new WeakMap<AccountWorker, Cache>();
const nonnegative = (value: unknown) =>
  Number.isFinite(Number(value)) && Number(value) >= 0;
const isPublic = (group: any) =>
  group?.isOpen === true ||
  (group?.isOpen == null &&
    (group?.groupType === 0 || group?.groupType === 'OPEN'));

/** Public metadata only. Neither Core origin nor the public-ID list comes from RPC arguments. */
export async function getPublicGroupDiscovery(worker: AccountWorker) {
  worker.runtime.assertAccount();
  let cache = caches.get(worker);
  if (!cache) {
    cache = {
      capturedAt: 0,
      offset: 0,
      slot: -1,
      scores: new Map(),
      retryAfter: 0,
    };
    caches.set(worker, cache);
  }
  const now = () => Date.now() + cache!.offset;
  const slot = () => Math.floor(now() / SLOT_MS);
  if (
    (!cache.directory || cache.slot !== slot()) &&
    Date.now() >= cache.retryAfter
  ) {
    if (!cache.refresh) {
      cache.refresh = (async () => {
        try {
          const [balances, info] = await Promise.allSettled([
            worker.readDiscoveryCore('/groups/balances?limit=0&reverse=true'),
            worker.readDiscoveryCore('/admin/info'),
          ]);
          if (
            balances.status !== 'fulfilled' ||
            !Array.isArray(balances.value) ||
            balances.value.length > 10_000
          )
            throw new HubApiError(503, 'group_discovery_unavailable');
          if (!worker.active) throw new HubApiError(403, 'account_closed');
          worker.runtime.assertAccount();
          const timestamp =
            info.status === 'fulfilled'
              ? info.value?.currentTimestamp
              : undefined;
          if (Number.isSafeInteger(timestamp) && timestamp > 0)
            cache!.offset = timestamp - Date.now();
          const groups: PublicGroup[] = [];
          const ids = new Set<number>();
          for (const entry of balances.value) {
            if (!isPublic(entry)) continue;
            const id = entry.groupId;
            const created = Number(
              entry.created ?? entry.creationTimestamp ?? entry.createdAt
            );
            if (
              !Number.isSafeInteger(id) ||
              id <= 0 ||
              ids.has(id) ||
              !nonnegative(entry.balance) ||
              !nonnegative(entry.memberCount) ||
              !Number.isFinite(created) ||
              created <= 0
            )
              continue;
            ids.add(id);
            groups.push({
              groupId: id,
              created,
              memberCount: Number(entry.memberCount),
              balance: Number(entry.balance),
            });
          }
          // Only Core-verified public IDs can reach Reticulum's public activity directory.
          worker.manager.setPublicGroupDirectory(
            groups.map((group) => group.groupId)
          );
          cache!.directory = groups;
          cache!.capturedAt = now();
          cache!.slot = slot();
          cache!.retryAfter = 0;
          for (const id of cache!.scores.keys())
            if (!ids.has(id)) cache!.scores.delete(id);
        } catch (error) {
          cache!.retryAfter = Date.now() + 60_000;
          throw error;
        } finally {
          cache!.refresh = undefined;
        }
      })();
    }
    try {
      await cache.refresh;
    } catch {
      /* Bounded stale metadata remains usable below. */
    }
  }
  if (!cache.directory || now() - cache.capturedAt > MAX_STALE_MS)
    throw new HubApiError(503, 'group_discovery_unavailable');
  if (!worker.active) throw new HubApiError(403, 'account_closed');
  worker.runtime.assertAccount();
  let activity: any;
  try {
    activity = worker.manager.getPublicGroupActivitySnapshot();
  } catch {
    /* Never turn a failed observation into zero activity. */
  }
  const publicIds = new Set(cache.directory.map((group) => group.groupId));
  const available = new Set<number>(
    Array.isArray(activity?.availableGroupIds)
      ? activity.availableGroupIds.filter((id: number) => publicIds.has(id))
      : []
  );
  const byGroup = new Map<number, any>();
  for (const entry of Array.isArray(activity?.summaries)
    ? activity.summaries
    : []) {
    if (
      !available.has(entry?.groupId) ||
      ![
        'activeAuthors7d',
        'messages24h',
        'messages7d',
        'confidence',
        'observedAt',
      ].every((key) => nonnegative(entry[key])) ||
      Number(entry.observedAt) < now() - MAX_STALE_MS ||
      Number(entry.observedAt) > now() + 300_000
    )
      continue;
    const previous = byGroup.get(entry.groupId);
    if (!previous || entry.observedAt >= previous.observedAt)
      byGroup.set(entry.groupId, entry);
  }
  const groups = cache.directory.map((group) => {
    let saved = cache!.scores.get(group.groupId);
    const observed = byGroup.get(group.groupId);
    if (
      observed &&
      (!saved ||
        saved.slot !== cache!.slot ||
        saved.value.activityObserved === false)
    ) {
      const value = calculateReticulumGroupScore({
        ...group,
        capturedAt: cache!.capturedAt,
        activityObserved: true,
        activity: {
          activeAuthors7d: Number(observed.activeAuthors7d),
          messages24h: Number(observed.messages24h),
          messages7d: Number(observed.messages7d),
          confidence: Number(observed.confidence),
          observedAt: Number(observed.observedAt),
        },
      });
      if (value) {
        saved = { slot: cache!.slot, value };
        cache!.scores.set(group.groupId, saved);
      }
    }
    const value =
      saved && now() - saved.value.capturedAt <= MAX_STALE_MS
        ? saved.value
        : undefined;
    return value
      ? {
          ...value,
          stale:
            value.capturedAt !== cache!.capturedAt || cache!.slot !== slot(),
        }
      : {
          ...group,
          score: null,
          activityObserved: false,
          capturedAt: cache!.capturedAt,
        };
  });
  return {
    contractVersion: 1,
    scoreVersion: 3,
    capturedAt: cache.capturedAt,
    expiresAt: cache.capturedAt + MAX_STALE_MS,
    stale: cache.slot !== slot(),
    groups,
  };
}
