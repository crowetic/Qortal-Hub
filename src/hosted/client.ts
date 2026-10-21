import { sendMessageBackground } from '../messaging/MessagesToBackground';
import { encodeWire, decodeWire } from './wire';
import { HostedRequestError, isHostedRequestError } from './errors';

export type HostedState = 'idle' | 'connecting' | 'connected' | 'disconnected';
const connectionError = () => new HostedRequestError('connection');
// The daemon admits 32 operations per socket. Leave room for controls and
// queue startup reads instead of sending a burst that exceeds that limit.
const MAX_IN_FLIGHT = 16;
const MAX_PENDING = 512;
const MAX_BUFFERED = 4 * 1024 * 1024;
const typingChannels = new Set([
  'reticulumChat:sendTyping',
  'reticulumChat:sendDirectTyping',
]);

export class HostedClient {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      frame: string;
      sent: boolean;
    }
  >();
  private listeners = new Map<string, Set<(payload: any) => void>>();
  private retry?: ReturnType<typeof setTimeout>;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
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
    this.generation++;
    this.connecting = undefined;
    clearTimeout(this.retry);
    clearTimeout(this.drainTimer);
    this.identity = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
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
    clearTimeout(this.retry);
    this.setState('connecting');
    const generation = ++this.generation;
    const task = this.open(generation);
    this.connecting = task;
    void task
      .finally(() => {
        if (this.connecting === task) this.connecting = undefined;
      })
      .catch(() => {
        if (generation !== this.generation || this.stopped) return;
        if (!this.identity && !this.socket) {
          this.stopped = true;
          this.setState('idle');
          return;
        }
        this.setState('disconnected');
        this.scheduleReconnect();
      });
    return task;
  }
  private scheduleReconnect() {
    clearTimeout(this.retry);
    if (!this.stopped)
      this.retry = setTimeout(() => {
        void this.connect().catch(() => {});
      }, 3000);
  }
  private async open(generation: number) {
    const identity = await sendMessageBackground(
      'userInfo',
      {},
      30_000,
      false,
      undefined
    );
    if (this.stopped || generation !== this.generation) throw connectionError();
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
            if (msg.error)
              item.reject(
                new HostedRequestError(
                  msg.error === 'busy' ? 'busy' : 'operation'
                )
              );
            else item.resolve(msg.result);
            this.drain();
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
        clearTimeout(this.drainTimer);
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
        this.scheduleReconnect();
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
  private drain() {
    clearTimeout(this.drainTimer);
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    let inFlight = [...this.pending.values()].filter(
      (item) => item.sent
    ).length;
    for (const [id, item] of this.pending) {
      if (item.sent) continue;
      if (inFlight >= MAX_IN_FLIGHT) break;
      if (socket.bufferedAmount > MAX_BUFFERED) {
        this.drainTimer = setTimeout(() => this.drain(), 25);
        break;
      }
      item.sent = true;
      inFlight++;
      try {
        socket.send(item.frame);
      } catch {
        this.pending.delete(id);
        clearTimeout(item.timer);
        item.reject(connectionError());
        inFlight--;
      }
    }
  }
  private canSendTyping() {
    return (
      this.state === 'connected' &&
      this.socket?.readyState === WebSocket.OPEN &&
      this.pending.size < MAX_IN_FLIGHT &&
      this.socket.bufferedAmount <= MAX_BUFFERED
    );
  }
  async rpc(channel: string, ...args: unknown[]): Promise<any> {
    const typing = typingChannels.has(channel);
    // Typing is transient. Never reconnect, queue it behind startup work, or
    // let its rejection escape the renderer's fire-and-forget callers.
    if (typing && !this.canSendTyping()) return { success: false };
    let generation = this.generation;
    try {
      const connection = this.connect();
      generation = this.generation;
      await connection;
      if (
        generation !== this.generation ||
        !this.socket ||
        this.socket.readyState !== WebSocket.OPEN
      )
        throw connectionError();
      if (typing && !this.canSendTyping()) return { success: false };
      if (this.pending.size >= MAX_PENDING)
        throw new HostedRequestError('busy');
      return await new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const frame = encodeWire({ type: 'rpc', id, channel, args });
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new HostedRequestError('timeout'));
          this.drain();
        }, 30_000);
        this.pending.set(id, { resolve, reject, timer, frame, sent: false });
        this.drain();
      });
    } catch (error) {
      if (typing) return { success: false };
      const failure = new HostedRequestError(
        isHostedRequestError(error) ? error.code : 'connection',
        channel
      );
      if (!this.stopped && generation === this.generation)
        this.emit('request-error', failure);
      throw failure;
    }
  }
}
