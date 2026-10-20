import path from 'node:path';
import { QAppReticulumManager } from '../../../electron/src/qapp-reticulum-manager';
import { PrivateChannelManager } from '../../../electron/src/private-channel-manager';
import { QAppMoqTransportManager } from '../../../electron/src/moq-transport-manager';
import { PrivateTransportSidecar } from '../../../electron/src/private-transport-sidecar';
import { QuicMasqueTransport } from '../../../electron/src/quic-masque-transport';
import { MoqMasqueTransport } from '../../../electron/src/moq-masque-transport';
import { ReticulumPrivateChannelBootstrapProvider } from '../../../electron/src/private-channel-bootstrap';
import {
  createRelayAccountState,
  configureRelaySigner,
  RelayAccessCoordinator,
} from '../../../electron/src/relay-access-coordinator';
import type { AccountWorker, BrowserSigner } from '../accounts';

/** Each wallet owns its RNS connections, QUIC sidecar and relay ticket wallet. */
export class HostedQapps {
  readonly rns: QAppReticulumManager;
  readonly privateChannels: PrivateChannelManager;
  readonly moq: QAppMoqTransportManager;
  private sidecar: PrivateTransportSidecar;
  private relay: RelayAccessCoordinator;
  constructor(
    worker: AccountWorker,
    signer: BrowserSigner,
    emit: (channel: string, payload: any) => void
  ) {
    const bridge = worker.bridge;
    this.rns = new QAppReticulumManager({
      invoke: (action, payload) =>
        bridge.invokeQAppReticulum(action as any, payload),
      onEvent: (listener) => {
        bridge.on('qapp-rns', listener);
        return () => {
          bridge.off('qapp-rns', listener);
        };
      },
    });
    this.sidecar = new PrivateTransportSidecar({
      command: path.join(
        worker.config.resourcesDir,
        'private-transport',
        `${process.platform}-${process.arch}`,
        `qortal-private-transport${process.platform === 'win32' ? '.exe' : ''}`
      ),
    });
    const state = createRelayAccountState();
    configureRelaySigner(
      (fields) => signer('chat', fields),
      async () => worker.principal.address,
      async () => {
        await worker.refreshMemberships();
        return worker.groupIds;
      },
      state
    );
    this.relay = new RelayAccessCoordinator(this.sidecar, Math.random, state);
    const select = (excluded?: ReadonlySet<string>) =>
      this.relay.select(bridge, excluded);
    const bootstrap = new ReticulumPrivateChannelBootstrapProvider(this.rns);
    const ownership = (owner: any, id: string) =>
      this.rns.connectionOwnership(owner, id);
    this.privateChannels = new PrivateChannelManager(
      ownership,
      (event) => new QuicMasqueTransport(event, this.sidecar, select, bootstrap)
    );
    this.moq = new QAppMoqTransportManager(
      ownership,
      (event) => new MoqMasqueTransport(event, this.sidecar, select, bootstrap)
    );
    this.rns.on('event', (payload) => emit('qapp:rns', payload));
    this.privateChannels.on('event', (payload) =>
      emit('qapp:private', payload)
    );
    this.moq.on('event', (payload) => emit('qapp:moq', payload));
  }
  async invoke(channel: string, args: any[]) {
    const [owner, ...rest] = args;
    if (
      !owner ||
      !['tabId', 'name', 'service'].every(
        (key) =>
          typeof owner[key] === 'string' &&
          owner[key].length > 0 &&
          owner[key].length <= 256
      )
    )
      throw new Error('invalid_qapp_owner');
    const methods = {
      'qapp:rns:request': [this.rns, 'request'],
      'qapp:rns:connect': [this.rns, 'connect'],
      'qapp:rns:send': [this.rns, 'send'],
      'qapp:rns:close': [this.rns, 'close'],
      'qapp:private:open': [this.privateChannels, 'open'],
      'qapp:private:send': [this.privateChannels, 'send'],
      'qapp:private:status': [this.privateChannels, 'status'],
      'qapp:private:close': [this.privateChannels, 'close'],
      'qapp:moq:open': [this.moq, 'open'],
      'qapp:moq:subscribe': [this.moq, 'subscribe'],
      'qapp:moq:publish': [this.moq, 'publish'],
      'qapp:moq:metrics': [this.moq, 'metrics'],
      'qapp:moq:close': [this.moq, 'close'],
    };
    if (channel === 'qapp:cleanup') {
      await Promise.allSettled([
        this.moq.cleanupOwner(owner),
        this.privateChannels.cleanupOwner(owner),
        this.rns.cleanupOwner(owner),
      ]);
      return;
    }
    if (channel === 'qapp:rns:close') {
      await Promise.allSettled([
        this.privateChannels.cleanupRnsConnection(owner, rest[0]),
        this.moq.cleanupRnsConnection(owner, rest[0]),
      ]);
      await this.rns.close(owner, rest[0]);
      return true;
    }
    if (!Object.hasOwn(methods, channel)) throw new Error('method_not_allowed');
    const [manager, method] = methods[channel];
    return manager[method](owner, ...rest);
  }
  async close() {
    this.moq.destroy();
    this.privateChannels.destroy();
    this.rns.destroy();
    this.relay.dispose();
    await this.sidecar.shutdown();
  }
}
