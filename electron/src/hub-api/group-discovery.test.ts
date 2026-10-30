import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPublicGroupDiscovery } from '../../../daemon/src/group-discovery';

afterEach(() => vi.useRealTimers());
function fixture() {
  const now = new Date('2026-10-30T12:00:00Z').getTime();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const group = {
    groupId: 1144,
    isOpen: true,
    balance: 1_000_000,
    memberCount: 5000,
    created: now - 15_778_800_000,
  };
  const state = {
    balances: [group, { ...group, groupId: 42, isOpen: false }],
    fail: false,
    activity: true,
    observed: true,
  };
  const readDiscoveryCore = vi.fn(async (resource: string) => {
    if (state.fail) throw new Error('offline');
    return resource.startsWith('/groups/')
      ? state.balances
      : { currentTimestamp: Date.now() };
  });
  const setPublicGroupDirectory = vi.fn();
  const worker: any = {
    active: true,
    readDiscoveryCore,
    runtime: { assertAccount: vi.fn() },
    manager: {
      setPublicGroupDirectory,
      getPublicGroupActivitySnapshot: () => {
        if (!state.activity) throw new Error('unavailable');
        return {
          availableGroupIds: state.observed ? [1144, 42, 999] : [],
          summaries: state.observed
            ? [1144, 42, 999].map((groupId) => ({
                groupId,
                activeAuthors7d: 50,
                messages24h: 100,
                messages7d: 500,
                confidence: 1,
                observedAt: Date.now(),
              }))
            : [],
        };
      },
    },
  };
  return { worker, state, readDiscoveryCore, setPublicGroupDirectory };
}
describe('Core-verified public group discovery', () => {
  it('uses the desktop formula and removes private/unsolicited activity IDs', async () => {
    const f = fixture();
    const result = await getPublicGroupDiscovery(f.worker);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      groupId: 1144,
      score: 90,
      activityObserved: true,
    });
    expect(f.setPublicGroupDirectory).toHaveBeenCalledWith([1144]);
    await getPublicGroupDiscovery(f.worker);
    expect(f.readDiscoveryCore).toHaveBeenCalledTimes(2);
  });
  it('distinguishes an unavailable observation, then upgrades within the same slot', async () => {
    const f = fixture();
    f.state.observed = false;
    expect((await getPublicGroupDiscovery(f.worker)).groups[0]).toMatchObject({
      score: null,
      activityObserved: false,
    });
    f.state.observed = true;
    expect((await getPublicGroupDiscovery(f.worker)).groups[0].score).toBe(90);
    f.state.activity = false;
    expect((await getPublicGroupDiscovery(f.worker)).groups[0].score).toBe(90);
  });
  it('bounds stale data to 24 hours and keeps account caches separate', async () => {
    const f = fixture();
    await getPublicGroupDiscovery(f.worker);
    vi.setSystemTime(Date.now() + 7 * 3600_000);
    f.state.fail = true;
    f.state.activity = false;
    expect(await getPublicGroupDiscovery(f.worker)).toMatchObject({
      stale: true,
      groups: [{ score: 90 }],
    });
    const other = { ...f.worker };
    await expect(getPublicGroupDiscovery(other)).rejects.toThrow(
      'group_discovery_unavailable'
    );
    vi.setSystemTime(Date.now() + 18 * 3600_000);
    await expect(getPublicGroupDiscovery(f.worker)).rejects.toThrow(
      'group_discovery_unavailable'
    );
  });
  it('does not modify a closed account after an upstream read', async () => {
    const f = fixture();
    f.worker.active = false;
    await expect(getPublicGroupDiscovery(f.worker)).rejects.toThrow();
    expect(f.setPublicGroupDirectory).not.toHaveBeenCalled();
  });
});
