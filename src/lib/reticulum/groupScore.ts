// Shared version-3 discovery score: desktop and the wallet-scoped daemon.
const QORT_HOLDING_TARGET = 1_000_000;
const ACTIVITY_AUTHORS_TARGET = 50;
const ACTIVITY_MESSAGES_7D_TARGET = 500;
const ACTIVITY_MESSAGES_24H_TARGET = 100;

export type ReticulumGroupActivityMetrics = {
  activeAuthors7d: number;
  confidence: number;
  messages24h: number;
  messages7d: number;
  observedAt: number;
};

export type ReticulumGroupScoreBreakdown = {
  activity: ReticulumGroupActivityMetrics;
  activityObserved?: boolean;
  activityScore: number;
  balance: number;
  capturedAt: number;
  communityScore: number;
  created: number;
  groupId: number;
  holdingScore: number;
  legacyScore: number;
  memberCount: number;
  score: number;
};

export type ReticulumGroupScoreSnapshot = {
  capturedAt: number;
  evaluatedGroupIds: string[];
  groups: Record<string, ReticulumGroupScoreBreakdown>;
  holdings: Record<string, number>;
  networkOffsetMs: number;
  slot: number;
  version: 3;
};

const clampScore = (value: number) =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

const logarithmicScore = (value: number, target: number) => {
  const normalizedValue = Math.max(0, Number(value) || 0);
  if (normalizedValue <= 0) return 0;
  return clampScore((Math.log1p(normalizedValue) / Math.log1p(target)) * 100);
};

const proportionalScore = (value: number, target: number) =>
  clampScore((Math.max(0, Number(value) || 0) / target) * 100);

export const getLegacyLevel = (
  timestamp?: number | string,
  nowTimestamp = Date.now()
) => {
  const created = Number(timestamp);
  if (!Number.isFinite(created) || created <= 0) return null;
  const start = new Date(created);
  const now = new Date(nowTimestamp);
  let years = now.getUTCFullYear() - start.getUTCFullYear();
  if (
    now.getUTCMonth() < start.getUTCMonth() ||
    (now.getUTCMonth() === start.getUTCMonth() &&
      now.getUTCDate() < start.getUTCDate())
  ) {
    years -= 1;
  }
  return Math.max(0, Math.min(10, years));
};

export const getCommunityLevel = (count?: number) => {
  const members = Math.max(0, Number(count) || 0);
  if (members <= 10) return 1;
  if (members <= 25) return 2;
  if (members <= 50) return 3;
  if (members <= 99) return 4;
  if (members <= 249) return 5;
  if (members <= 499) return 6;
  if (members <= 999) return 7;
  if (members <= 2499) return 8;
  if (members <= 4999) return 9;
  return 10;
};

export const calculateReticulumGroupScore = (input: {
  activity: ReticulumGroupActivityMetrics;
  activityObserved: boolean;
  balance: number;
  capturedAt: number;
  created: number;
  groupId: number;
  memberCount: number;
}): ReticulumGroupScoreBreakdown | null => {
  const legacyLevel = getLegacyLevel(input.created, input.capturedAt);
  if (legacyLevel == null) return null;
  const holdingScore = logarithmicScore(input.balance, QORT_HOLDING_TARGET);
  const activeAuthorsScore = proportionalScore(
    input.activity.activeAuthors7d,
    ACTIVITY_AUTHORS_TARGET
  );
  const messages7dScore = proportionalScore(
    input.activity.messages7d,
    ACTIVITY_MESSAGES_7D_TARGET
  );
  const messages24hScore = proportionalScore(
    input.activity.messages24h,
    ACTIVITY_MESSAGES_24H_TARGET
  );
  const activityScore =
    activeAuthorsScore * 0.5 + messages7dScore * 0.3 + messages24hScore * 0.2;
  const legacyScore = Math.min(100, legacyLevel * 10);
  const communityScore = getCommunityLevel(input.memberCount) * 10;
  const score = Math.round(
    holdingScore * 0.5 +
      activityScore * 0.3 +
      legacyScore * 0.1 +
      communityScore * 0.1
  );
  return {
    ...input,
    activityScore,
    communityScore,
    holdingScore,
    legacyScore,
    score: Math.max(0, Math.min(100, score)),
  };
};
