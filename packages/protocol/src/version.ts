// The protocol's major version. Bump this only for a breaking change to
// the frame wire format or handshake semantics -- the hub rejects any
// agent whose hello reports a different major (or omits protocolVersion
// entirely, which means "predates versioning") with a version_mismatch
// error rather than risk speaking a protocol the agent doesn't understand.
// See apps/hub/src/tunnel/ws.ts's handleHello and packages/agent/src/daemon.ts's
// hello send.
export const PROTOCOL_VERSION = 1;
