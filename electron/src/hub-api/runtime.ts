import type {
  ReticulumChatEvent,
  ReticulumChatHistoryReadOptions,
  ReticulumChatManager,
} from '../reticulum-chat';
import { HubApiError } from './auth';

export type HubApiChatManager = Pick<
  ReticulumChatManager,
  | 'getLocalAccountAddresses'
  | 'getChannels'
  | 'getChannelMetadataBundle'
  | 'getHistory'
  | 'reserveAuthorSequence'
  | 'releaseAuthorSequence'
  | 'publishEvent'
  | 'on'
  | 'off'
>;

/** Runtime boundary: the HTTP server has no Electron or renderer imports. */
export class HubApiRuntime {
  constructor(
    readonly manager: HubApiChatManager,
    readonly address: string,
    private readonly isEnabled: () => boolean,
    readonly backend: string = 'electron',
    readonly transportStatus: () => Record<string, unknown> = () => ({})
  ) {}

  assertAccount(): void {
    const addresses = this.manager.getLocalAccountAddresses();
    if (
      !this.isEnabled() ||
      addresses.length !== 1 ||
      addresses[0] !== this.address
    ) {
      throw new HubApiError(503, 'account_runtime_unavailable');
    }
  }

  channels(groupId: number) {
    this.assertAccount();
    try {
      return this.manager.getChannels(groupId);
    } catch {
      throw new HubApiError(403, 'group_access_denied');
    }
  }

  channelMetadata(groupId: number) {
    this.assertAccount();
    try {
      return this.manager.getChannelMetadataBundle(groupId);
    } catch {
      throw new HubApiError(403, 'group_access_denied');
    }
  }

  assertChannel(groupId: number, channelId: string): void {
    if (
      !this.channels(groupId).some((channel) => channel.channelId === channelId)
    ) {
      throw new HubApiError(403, 'channel_access_denied');
    }
  }

  history(
    groupId: number,
    channelId: string,
    limit: number,
    options: ReticulumChatHistoryReadOptions
  ) {
    this.assertChannel(groupId, channelId);
    return this.manager.getHistory(groupId, channelId, limit, options);
  }

  async reserve(groupId: number) {
    this.channels(groupId);
    const sequence = await this.manager.reserveAuthorSequence(
      groupId,
      this.address
    );
    try {
      this.assertAccount();
    } catch (error) {
      this.release(groupId, sequence);
      throw error;
    }
    return sequence;
  }

  release(
    groupId: number,
    sequence: { authorStreamId: string; authorSeq: number }
  ): void {
    try {
      this.manager.releaseAuthorSequence(
        groupId,
        this.address,
        sequence.authorStreamId,
        sequence.authorSeq
      );
    } catch {
      // Manager shutdown may have closed SQLite; its durable lease has its own TTL.
    }
  }

  async publish(event: ReticulumChatEvent): Promise<void> {
    if (
      event.eventType.startsWith('channel_') ||
      event.eventType.startsWith('category_')
    ) {
      // A create/restore may name a channel absent from the readable list.
      // The native manager independently validates the signed mutation and Core admin rights.
      this.channels(event.groupId);
    } else this.assertChannel(event.groupId, event.channelId);
    const result = await this.manager.publishEvent(event);
    if (!result.ok) throw new HubApiError(422, 'event_rejected');
  }

  onChange(groupId: number, channelId: string, notify: () => void): () => void {
    const listener = (payload: { event?: ReticulumChatEvent }) => {
      const event = payload?.event;
      if (event?.groupId !== groupId || event.channelId !== channelId) return;
      // The server rechecks account and channel access before every notification.
      notify();
    };
    this.manager.on('event', listener);
    return () => this.manager.off('event', listener);
  }
}
