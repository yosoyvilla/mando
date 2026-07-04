import type { Frame } from "@mando/protocol";

// A Conn wraps one live agent WebSocket connection. It only exposes what
// callers outside this module need -- routes (online status, revoke) and
// the proxy (task 2.8, request/response correlation) -- so nothing here
// leans on WebSocket/Bun internals directly.
export type Conn = {
  send(frame: Frame): void;
  onResponse(id: string, handler: (frame: Frame) => void): void;
  // Removes a previously-registered onResponse handler without waiting for
  // a terminal response_end/response_error frame. Task 2.7 shipped
  // onResponse's own terminal-frame cleanup (see tunnel/ws.ts) but flagged
  // that nothing let a caller release a handler early -- if the proxy
  // (task 2.8) sends a `cancel` and the agent never replies with a
  // terminal frame for that id, the entry would leak for the connection's
  // lifetime. offResponse closes that gap; safe to call even if the
  // handler was already removed (e.g. a terminal frame arrived first).
  offResponse(id: string): void;
  close(): void;
};

// Registry tracks the single live Conn per machine for this hub process.
// Deliberately a small in-memory map, not a persisted/shared store: the
// hub is a single-process, self-hosted deployment (see pairing/service.ts
// for the same assumption re: pendingTokens), so "is this machine online"
// only ever needs to mean "does *this* process hold its socket". A
// multi-process hub would need to replace this with something shared
// (e.g. Redis) -- out of scope here.
export class Registry {
  private readonly conns = new Map<string, Conn>();

  add(machineId: string, conn: Conn): void {
    this.conns.set(machineId, conn);
  }

  remove(machineId: string): void {
    this.conns.delete(machineId);
  }

  get(machineId: string): Conn | null {
    return this.conns.get(machineId) ?? null;
  }
}
