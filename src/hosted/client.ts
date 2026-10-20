import { sendMessageBackground } from '../messaging/MessagesToBackground';
import i18n from '../i18n/i18n';
import { encodeWire, decodeWire } from './wire';

export type HostedState = 'idle' | 'connecting' | 'connected' | 'disconnected';
const connectionError = () =>
  new Error(i18n.t('reticulum:hosted.connection_failed'));

export class HostedClient {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Map<string, Set<(payload: any) => void>>();
  private retry?: ReturnType<typeof setTimeout>;
  private identity?: { address: string; publicKey: string };
  private stopped = true;
  state: HostedState = 'idle';
  constructor(readonly url: string) {}
  on(channel: string, callback: (payload: any) => void) {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(callback);
    this.listeners.set(channel, listeners);
    return () => {
      listeners.delete(callback);
    };
  }
  private emit(channel: string, payload?: any) {
    for (const callback of this.listeners.get(channel) ?? []) {
      try {
        Promise.resolve(callback(payload)).catch((error) =>
          console.warn('Hosted event handler failed', error)
        );
      } catch (error) {
        console.warn('Hosted event handler failed', error);
      }
    }
  }
  private setState(state: HostedState) {
    this.state = state;
    this.emit('state', state);
  }
  disconnect() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.identity = undefined;
    this.socket?.close();
    this.socket = undefined;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(connectionError());
    }
    this.pending.clear();
    this.setState('idle');
    this.emit('presence:cleared');
  }
  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.state === 'connected'
    )
      return Promise.resolve();
    this.stopped = false;
    this.setState('connecting');
    const task = this.open();
    this.connecting = task;
    void task
      .finally(() => {
        if (this.connecting === task) this.connecting = undefined;
      })
      .catch(() => {});
    return task;
  }
  private async open() {
    const identity = await sendMessageBackground(
      'userInfo',
      {},
      30_000,
      false,
      undefined
    );
    if (this.stopped) throw connectionError();
    if (!identity?.address || !identity?.publicKey) {
      this.setState('idle');
      throw connectionError();
    }
    this.identity = {
      address: identity.address,
      publicKey: identity.publicKey,
    };
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      let ready = false;
      const timer = setTimeout(() => {
        socket.close();
        reject(connectionError());
      }, 30_000);
      socket.addEventListener('message', (event) => {
        void (async () => {
          if (socket !== this.socket) return;
          const msg = decodeWire(String(event.data));
          if (msg.type === 'challenge') {
            if (msg.origin !== window.location.origin) throw connectionError();
            const fields = {
              type: 'HUB_BROWSER_SESSION',
              nonce: msg.nonce,
              origin: msg.origin,
              clientId: this.clientId(),
              address: identity.address,
              publicKey: identity.publicKey,
              timestamp: Date.now(),
            };
            const signed = await sendMessageBackground(
              'signPresenceMessage',
              fields,
              10_000,
              false,
              undefined
            );
            if (!signed?.signature) throw connectionError();
            if (this.stopped || socket !== this.socket) return;
            socket.send(
              encodeWire({
                ...fields,
                type: 'authenticate',
                signature: signed.signature,
              })
            );
          } else if (msg.type === 'ready') {
            if (msg.address !== identity.address) throw connectionError();
            ready = true;
            clearTimeout(timer);
            this.setState('connected');
            resolve();
          } else if (msg.type === 'event') this.emit(msg.channel, msg.payload);
          else if (msg.type === 'result') {
            const item = this.pending.get(msg.id);
            if (!item) return;
            this.pending.delete(msg.id);
            clearTimeout(item.timer);
            if (msg.error) item.reject(connectionError());
            else item.resolve(msg.result);
          } else if (msg.type === 'sign') await this.sign(socket, msg);
        })().catch(() => {
          socket.close();
          reject(connectionError());
        });
      });
      socket.addEventListener('error', () => reject(connectionError()));
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        if (!ready) reject(connectionError());
        if (socket !== this.socket) return;
        this.socket = undefined;
        for (const item of this.pending.values()) {
          clearTimeout(item.timer);
          item.reject(connectionError());
        }
        this.pending.clear();
        this.setState(this.stopped ? 'idle' : 'disconnected');
        this.emit('presence:cleared');
        this.emit('reticulumChat:readiness', {
          state: 'starting',
          revision: Date.now(),
        });
        if (!this.stopped)
          this.retry = setTimeout(() => {
            void this.connect().catch(() => {});
          }, 3000);
      });
    });
  }
  private clientId() {
    const key = 'qortal-hub-hosted-client';
    let id = window.localStorage.getItem(key);
    if (!id || !/^[a-f0-9]{32}$/.test(id)) {
      id = crypto.randomUUID().replace(/-/g, '');
      window.localStorage.setItem(key, id);
    }
    return id;
  }
  private async sign(socket: WebSocket, msg: any) {
    try {
      // Only native chat synchronization controls may request background signing.
      // Chat messages, admin mutations, calls and transactions are signed by the
      // normal interface in response to the user's own actions.
      const fields = msg.fields;
      const type = fields?.type;
      if (
        msg.kind !== 'chat' ||
        typeof type !== 'string' ||
        !(
          type.startsWith('RCHAT_') ||
          type === 'RETICULUM_CALENDAR_MUTATION_V1' ||
          type === 'QORTAL_LAND_SESSION_ROUTE_V1' ||
          type === 'masque-ticket-issue-v1'
        )
      )
        throw connectionError();
      if (
        fields.authorAddress &&
        fields.authorAddress !== this.identity?.address
      )
        throw connectionError();
      const result = await sendMessageBackground(
        'signReticulumChatEvent',
        fields,
        10_000,
        false,
        undefined
      );
      if (!result?.signature) throw connectionError();
      if (socket === this.socket && !this.stopped)
        socket.send(encodeWire({ type: 'signed', id: msg.id, result }));
    } catch {
      if (socket === this.socket && socket.readyState === WebSocket.OPEN)
        socket.send(
          encodeWire({ type: 'signed', id: msg.id, error: 'signing_failed' })
        );
    }
  }
  async rpc(channel: string, ...args: unknown[]): Promise<any> {
    await this.connect();
    if (
      this.pending.size >= 128 ||
      !this.socket ||
      this.socket.bufferedAmount > 4 * 1024 * 1024
    )
      throw connectionError();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(connectionError());
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket!.send(encodeWire({ type: 'rpc', id, channel, args }));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(connectionError());
      }
    });
  }
}
