import type { RelaySocket } from '../../src/server/relay.js';

/** A minimal `RelaySocket` double: records every send, and lets a test fire the handlers it registered as if the underlying transport had. */
export class MockSocket implements RelaySocket {
  readyState = 1;
  /** Whatever a test wants the transport to claim is queued but unwritten; a real ws/browser socket reports it for free. */
  bufferedAmount = 0;
  sent: (string | Uint8Array | Buffer)[] = [];
  closed: number[] = [];
  terminated = 0;
  pings = 0;
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string | Uint8Array | Buffer): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed.push(code ?? 0);
  }
  terminate(): void {
    this.terminated++;
  }
  ping(): void {
    this.pings++;
  }
  on(ev: string, cb: (...args: unknown[]) => void): void {
    const list = this.handlers.get(ev) ?? [];
    list.push(cb);
    this.handlers.set(ev, list);
  }
  fire(ev: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(ev) ?? []) cb(...args);
  }
}
