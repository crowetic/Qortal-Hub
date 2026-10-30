import {
  calculateReticulumGroupScore,
  type ReticulumGroupActivityMetrics,
  type ReticulumGroupScoreBreakdown,
  type ReticulumGroupScoreSnapshot,
} from '../../lib/reticulum/groupScore';
export {
  calculateReticulumGroupScore,
  getLegacyLevel,
  getCommunityLevel,
} from '../../lib/reticulum/groupScore';
export type {
  ReticulumGroupActivityMetrics,
  ReticulumGroupScoreBreakdown,
  ReticulumGroupScoreSnapshot,
} from '../../lib/reticulum/groupScore';
import { useEffect, useSyncExternalStore } from 'react';
import { getBaseApiReact } from '../../App';

// Scoring contract and rationale: docs/reticulum-group-score.md

const GROUP_SCORE_CACHE_KEY = 'qortal-reticulum-group-score-snapshot-v1';
const GROUP_SCORE_VERSION = 3;
const GROUP_SCORE_SLOT_MS = 6 * 60 * 60_000;
const GROUP_SCORE_MAX_STALE_MS = 24 * 60 * 60_000;
const UNKNOWN_GROUP_REFRESH_COOLDOWN_MS = 5 * 60_000;
const EMPTY_SNAPSHOT: ReticulumGroupScoreSnapshot = {
  capturedAt: 0,
  evaluatedGroupIds: [],
  groups: {},
  holdings: {},
  networkOffsetMs: 0,
  slot: -1,
  version: GROUP_SCORE_VERSION,
};

export const getReticulumGroupScoreColor = (score?: number | null) => {
  if (!Number.isFinite(score)) return '#8F96A5';
  if (Number(score) <= 24) return '#EF4444';
  if (Number(score) <= 44) return '#F97316';
  if (Number(score) <= 64) return '#FACC15';
  if (Number(score) <= 94) return '#22C55E';
  return '#00A8FF';
};

const isPublicGroup = (group: any) =>
  group?.isOpen === true ||
  group?.groupType === 0 ||
  group?.groupType === 'OPEN';

const readCachedSnapshot = (): ReticulumGroupScoreSnapshot => {
  if (typeof window === 'undefined') return EMPTY_SNAPSHOT;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(GROUP_SCORE_CACHE_KEY) || 'null'
    );
    if (
      !parsed ||
      parsed.version !== GROUP_SCORE_VERSION ||
      !Array.isArray(parsed.evaluatedGroupIds) ||
      !parsed.groups ||
      typeof parsed.groups !== 'object' ||
      !parsed.holdings ||
      typeof parsed.holdings !== 'object'
    ) {
      return EMPTY_SNAPSHOT;
    }
    const networkNow = Date.now() + (Number(parsed.networkOffsetMs) || 0);
    if (
      networkNow - Number(parsed.capturedAt || 0) >
      GROUP_SCORE_MAX_STALE_MS
    ) {
      return EMPTY_SNAPSHOT;
    }
    return parsed as ReticulumGroupScoreSnapshot;
  } catch {
    return EMPTY_SNAPSHOT;
  }
};

let currentSnapshot = readCachedSnapshot();
let refreshInFlight: Promise<ReticulumGroupScoreSnapshot> | null = null;
const listeners = new Set<() => void>();
const unknownGroupRefreshes = new Map<string, number>();

const emitSnapshot = (snapshot: ReticulumGroupScoreSnapshot) => {
  currentSnapshot = snapshot;
  try {
    window.localStorage.setItem(
      GROUP_SCORE_CACHE_KEY,
      JSON.stringify(snapshot)
    );
  } catch {
    // Scores remain available for the current session without persistent storage.
  }
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => currentSnapshot;

const currentNetworkTime = () =>
  Date.now() + (Number(currentSnapshot.networkOffsetMs) || 0);

const currentSlot = () =>
  Math.floor(currentNetworkTime() / GROUP_SCORE_SLOT_MS);

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export const refreshReticulumGroupScores = async (
  force = false
): Promise<ReticulumGroupScoreSnapshot> => {
  if (!force && currentSnapshot.slot === currentSlot()) return currentSnapshot;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const baseApi = getBaseApiReact();
      const [balancesResponse, adminInfo] = await Promise.all([
        fetch(`${baseApi}/groups/balances?limit=0&reverse=true`),
        fetch(`${baseApi}/admin/info`)
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
      ]);
      if (!balancesResponse.ok) {
        throw new Error(
          `Group balances request failed (${balancesResponse.status})`
        );
      }
      const balances = await balancesResponse.json();
      if (!Array.isArray(balances)) {
        throw new Error('Group balances response is invalid');
      }
      const networkTimestamp = Number(adminInfo?.currentTimestamp);
      const networkOffsetMs = Number.isFinite(networkTimestamp)
        ? networkTimestamp - Date.now()
        : currentSnapshot.networkOffsetMs;
      const capturedAt = Date.now() + networkOffsetMs;
      const slot = Math.floor(capturedAt / GROUP_SCORE_SLOT_MS);
      const publicGroups = balances.filter(isPublicGroup);
      const holdings = Object.fromEntries(
        balances.flatMap((group: any) => {
          const groupId = Number(group?.groupId);
          if (!Number.isInteger(groupId) || groupId <= 0) return [];
          return [[String(groupId), Math.max(0, Number(group?.balance) || 0)]];
        })
      );
      const publicGroupIds = publicGroups
        .map((group: any) => Number(group?.groupId))
        .filter((groupId: number) => Number.isInteger(groupId) && groupId > 0);

      await window.reticulumChat?.setPublicGroupDirectory?.(publicGroupIds);
      const readActivity = async () => {
        if (!window.reticulumChat?.getPublicGroupActivitySnapshot) {
          throw new Error('Public group Activity snapshot is unavailable');
        }
        return window.reticulumChat.getPublicGroupActivitySnapshot();
      };
      const firstActivity = await readActivity();
      await delay(3_000);
      const latestActivity = await readActivity();
      const activityByGroup = new Map<number, ReticulumGroupActivityMetrics>();
      for (const summary of [
        ...(firstActivity?.summaries || []),
        ...(latestActivity?.summaries || []),
      ]) {
        const groupId = Number(summary?.groupId);
        if (!Number.isInteger(groupId) || groupId <= 0) continue;
        const previous = activityByGroup.get(groupId);
        if (!previous || Number(summary.observedAt) >= previous.observedAt) {
          activityByGroup.set(groupId, {
            activeAuthors7d: Math.max(0, Number(summary.activeAuthors7d) || 0),
            confidence: Math.max(0, Number(summary.confidence) || 0),
            messages24h: Math.max(0, Number(summary.messages24h) || 0),
            messages7d: Math.max(0, Number(summary.messages7d) || 0),
            observedAt: Number(summary.observedAt) || capturedAt,
          });
        }
      }
      const availableGroupIds = new Set<number>(
        [
          ...(firstActivity?.availableGroupIds || []),
          ...(latestActivity?.availableGroupIds || []),
        ].map(Number)
      );

      const publicIds = new Set(publicGroupIds.map(String));
      const preservingCurrentSlot = currentSnapshot.slot === slot;
      const nextGroups: Record<string, ReticulumGroupScoreBreakdown> = {};
      for (const [groupId, previous] of Object.entries(
        currentSnapshot.groups
      )) {
        if (
          publicIds.has(groupId) &&
          capturedAt - Number(previous?.capturedAt || 0) <=
            GROUP_SCORE_MAX_STALE_MS
        ) {
          nextGroups[groupId] = previous;
        }
      }
      for (const group of publicGroups) {
        const groupId = Number(group?.groupId);
        if (!Number.isInteger(groupId) || groupId <= 0) continue;
        const groupKey = String(groupId);
        const previous = nextGroups[groupKey];
        const activityObserved = availableGroupIds.has(groupId);
        if (preservingCurrentSlot && previous) {
          const previousActivityWasObserved =
            previous.activityObserved !== false;
          if (previousActivityWasObserved || !activityObserved) continue;
        }
        if (!activityObserved && previous) continue;
        const activity = activityByGroup.get(groupId) || {
          activeAuthors7d: 0,
          confidence: activityObserved ? 1 : 0,
          messages24h: 0,
          messages7d: 0,
          observedAt: capturedAt,
        };
        const breakdown = calculateReticulumGroupScore({
          activity,
          activityObserved,
          balance: Math.max(0, Number(group?.balance) || 0),
          capturedAt,
          created: Number(
            group?.created ?? group?.creationTimestamp ?? group?.createdAt
          ),
          groupId,
          memberCount: Math.max(0, Number(group?.memberCount) || 0),
        });
        if (breakdown) nextGroups[groupKey] = breakdown;
      }

      const nextSnapshot: ReticulumGroupScoreSnapshot = {
        capturedAt,
        evaluatedGroupIds: [...publicIds],
        groups: nextGroups,
        holdings,
        networkOffsetMs,
        slot,
        version: GROUP_SCORE_VERSION,
      };
      emitSnapshot(nextSnapshot);
      return nextSnapshot;
    } catch (error) {
      console.warn('[ReticulumGroupScore] Refresh failed:', error);
      return currentSnapshot;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
};

export const ensureReticulumGroupScore = (groupId?: string | number) => {
  const normalizedGroupId = String(groupId ?? '').trim();
  if (!normalizedGroupId) return refreshReticulumGroupScores(false);
  const existing = currentSnapshot.groups[normalizedGroupId];
  if (
    existing &&
    currentNetworkTime() - existing.capturedAt <= GROUP_SCORE_MAX_STALE_MS
  ) {
    return Promise.resolve(currentSnapshot);
  }
  if (
    currentSnapshot.slot === currentSlot() &&
    currentSnapshot.evaluatedGroupIds.includes(normalizedGroupId)
  ) {
    return Promise.resolve(currentSnapshot);
  }
  const lastRequested = unknownGroupRefreshes.get(normalizedGroupId) || 0;
  if (Date.now() - lastRequested < UNKNOWN_GROUP_REFRESH_COOLDOWN_MS) {
    return Promise.resolve(currentSnapshot);
  }
  unknownGroupRefreshes.set(normalizedGroupId, Date.now());
  return refreshReticulumGroupScores(true);
};

export const startReticulumGroupScoreScheduler = () => {
  void refreshReticulumGroupScores(false);
  const interval = window.setInterval(() => {
    void refreshReticulumGroupScores(false);
  }, 60_000);
  return () => window.clearInterval(interval);
};

export const useReticulumGroupScoreSnapshot = () =>
  useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);

export const useReticulumGroupScore = (
  groupId?: string | number,
  isPublic = true
) => {
  const snapshot = useReticulumGroupScoreSnapshot();
  const normalizedGroupId = String(groupId ?? '').trim();
  const score =
    isPublic && normalizedGroupId
      ? snapshot.groups[normalizedGroupId]
      : undefined;
  useEffect(() => {
    if (!isPublic || !normalizedGroupId || score) return;
    void ensureReticulumGroupScore(normalizedGroupId);
  }, [isPublic, normalizedGroupId, score]);
  if (
    !score ||
    currentNetworkTime() - score.capturedAt > GROUP_SCORE_MAX_STALE_MS
  ) {
    return undefined;
  }
  return score;
};
