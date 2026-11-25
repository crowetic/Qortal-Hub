# Hosted Access Q-App Reticulum lifecycle

The hotel incident demo uses the generic Reticulum v1 Q-App capability already
present in `hosted-access` at
`8ebdf460c8e45620abafdfb36c8908dccec000dd`. No whole-branch merge or new
incident-specific Hub endpoint is needed. Work is isolated on
`feature/hosted-access-qapp-reticulum`.

## Audited path

```text
Cross-origin native Q-App iframe
  -> qortalRequest / MessageChannel
  -> useQortalMessageListener (trusted frame + tab identity)
  -> dispatchQAppReticulumRequest / destination permission
  -> Hosted Access electronAPI compatibility surface
  -> wallet-authenticated browser WebSocket
  -> per-browser-account HostedQapps / QAppReticulumManager
  -> existing account Python bridge / Reticulum Link, Buffer stream 7
  -> qortal-hub-v3.qapp-backend.v1 backend
  -> owner-routed RNS_MESSAGE / RNS_CONNECTION_STATE to Q-App iframe
```

Relevant code:

- `src/hosted/qapp-frame.ts`: exact frame source, cross-origin check and
  transferred response port. Q-Apps must use an origin distinct from Hub.
- `src/hooks/useQortalMessageListener.tsx`: trusted application identity,
  per-tab dispatch and owner-key routing of unsolicited events.
- `src/qortal/qapp-reticulum-request.ts` and `src/qortal/get.ts`: destination
  approval and existing `SIGN_QAPP_IDENTITY` account challenge signing.
- `src/hosted/bootstrap.ts`, `client.ts`, and `qapp-reticulum.ts`: hosted
  compatibility surface, authenticated socket and logical connection tracking.
- `daemon/src/hosted/server.ts`: exact Origin admission, one-use wallet-signed
  challenge, per-session account worker, 32-operation concurrency and bounded
  WebSocket queues. This is separate from the daemon's privileged bearer API.
- `daemon/src/hosted/qapps.ts`: generic Q-App operations scoped to that worker.
- `electron/src/qapp-reticulum-manager.ts` and
  `qapp-reticulum-bridge-transport.ts`: shared bounds, ownership, Python reset
  handling and cleanup.
- `electron/resources/presence_bridge.py`: real Reticulum RPC and framed Buffer
  transport; `examples/qapp-reticulum/backend.py` is the transport-only example.

The audited owner `develop` was
`81aa364c1314ef5059c964f005f1faddf34922f7`. Required Q-App transport and identity
APIs already exist on the hosted baseline. Its stronger binary handling is
retained. Browser builds without Hosted Access and mobile do not acquire a
Reticulum runtime automatically.

## Changes

Hosted Access previously routed ordinary RNS requests and events correctly, but
a quiet application could retain obsolete IDs after Python or the hosted
WebSocket restarted.

The daemon now reuses `QAppReticulumBridgeTransport`. Python `stopped` or
`degraded` invalidates every logical ID and emits `CLOSED` with reason
`RNS_TRANSPORT_RESET`; dependent private/MoQ transports are cleaned up too.
The browser tracks successful connections and emits the same terminal event on
socket loss or logout. Duplicate resets do not repeat notifications for old
connections. A late connect reply from a destroyed session is rejected.

The bridge does not replay backend account proofs, mutations or subscription
state. The Q-App reconnects, obtains a fresh backend proof and synchronizes from
its authoritative store. Transport admission/ACK remains distinct from durable
business acceptance. Controls in owner fields are rejected before they can
collide with the NUL-separated isolation key.

## Security and application responsibilities

The trusted shell supplies tab/application identity; a cross-origin Q-App does
not call the daemon socket directly. A wallet-authenticated socket owns its own
manager and Reticulum identity. Shell destination approval remains required.
This authenticated browser session is not an incident backend session.

Use the existing `SIGN_QAPP_IDENTITY` contract documented in
[`qapp-reticulum.md`](qapp-reticulum.md). The incident backend independently
verifies the proof and membership/role policy. Do not trust application-supplied
actor, organization or role fields. No backend credential or private key belongs
in QDN, Q-App JavaScript or a query string. Bound attachments within the existing
256 KiB transport envelope or use an explicitly authorized file protocol.

An authenticated Hub shell is trusted to enforce its Q-App sandbox boundary.
Origin admission alone does not authorize a tenant subscription, and transport
echo tests are not application authorization tests. The incident backend owns
durable storage, revisions, idempotency, subscription authorization and offline
recovery.

## Verification

From this worktree, with normal project dependencies installed, Node >=22.12,
and `npm run setup:reticulum --prefix daemon` completed:

```bash
npx vitest run src/hosted/qapp-reticulum.test.ts src/hosted/client.test.ts \
  src/hosted/qapp-frame.test.ts src/qortal/qapp-reticulum-request.test.ts \
  electron/src/hosted-qapp-lifecycle.test.ts \
  electron/src/qapp-reticulum-manager.test.ts \
  electron/src/qapp-reticulum-bridge-transport.test.ts
npm run build --prefix daemon
node --test daemon/test/hosted.test.cjs daemon/test/native.test.cjs
npm run test:hosted-build
npm run build
```

The hosted integration test runs ordinary Node, SQLite and Python Reticulum on
an isolated local network with a fixture Core and unreachable External Auth.
It starts the existing backend example and verifies `/hello` RPC, framed stream
echo, cross-wallet and cross-application rejection, and connection cleanup.
Existing group/direct Q-Chat, calls, resources and reconnect checks run in the
same test. Unit tests cover quiet Python reset, socket loss/logout, late replies,
owner-key controls and dependent transport cleanup.

These checks do not prove a published QDN application, a real browser iframe
permission flow, external Reticulum routing or production NAT/TLS behavior.
The application has its own multi-client durability/recovery acceptance suite.

## Packaging and rollout

Source push does not deploy. Build the matching hosted browser/daemon package
using `./build-hosted-access.sh` and the intended deployment's actual hostnames,
ports, Core and ICE configuration as described in
[`hosted-access.md`](hosted-access.md). Keep browser and daemon versions paired.
The existing package readiness probe and previous-release rollback apply; no
data migration is introduced here. Rollout requires explicit authorization.
No VM access, service changes or deployment is part of this change.
