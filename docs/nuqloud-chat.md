# NuQloud embedded Q-Chat

The `hosted-access` branch provides `npm run build:nuqloud`, a chat-only browser
entry for NuQloud. It reuses `ChatGroup`, the message list, TipTap editor and native
chat services. `src/nuqloud` replaces shell/backend dependencies through the
specialized Vite configuration. The ordinary desktop and full hosted-browser
entries keep their existing defaults.

NuQloud owns login, linked-account selection, unlock, permissions and the parent
frame. External Auth signs constrained native group events; wallet keys and app
bearers stay on the server. The existing Auth-wallet account worker/database is
used. This does not provision a hosted-browser installation identity or transfer
wallet keys into this entry.

## Build and packaging

Node 22.12+ is required. From a clean matching source revision:

```bash
npm ci --ignore-scripts
npm ci --prefix daemon
npm run build:nuqloud
npm run build --prefix daemon
```

The renderer outputs `daemon/dist/nuqloud-ui/index.html`, hashed assets and
`build-info.json`. NuQloud's multi-stage Dockerfile builds this entry and daemon
from the same source context. Build output stays untracked. `QORTAL_HUB_SOURCE_REVISION`
can supply provenance where Git metadata is absent; the local build otherwise
records HEAD. This is source metadata, not an attestation of a clean tree.

The platform defaults new source selections to `hosted-access`. Keep the separate
`hub-daemon` branch independent. No automatic merge or Hub `main` branch is needed.
Update the platform, External Auth and Hub together; older combinations retain
the previous Nextcloud interface through capability negotiation.

## Contract

The daemon advertises `nuqloudChatTransport=1` only when embedded assets exist.
Updated Auth exposes `sharedChatUI=1` only for that transport. Auth calls these
wallet-bound endpoints with its existing bearer and wallet header:

- `GET /v1/nuqloud/asset?path=...`: fixed build directory, hash/base64/type, no
  caller-selected roots, traversal, source maps or symlink escapes.
- `POST /v1/nuqloud/read`: bounded allowlist of native group queries, subscriptions,
  read/search/mute state, Core-derived admin capabilities, read-only presence and
  reference-authorized cached resource reads. Returns `{contractVersion:1,result}`.
- `POST /v1/nuqloud/write`: the same contract for constrained chunked uploads;
  `upload:*` is refused on the read route and requires `QCHAT_PUBLISH`.

Publication and sequence reservation/release continue to use the existing leased
`/v1/groups/:id/sequences` and `/events` routes. The native manager remains the
authority for group/channel membership, write restrictions, mutation ownership,
admin metadata and signatures. Auth separately checks read/publish and fresh
unlock on each operation. Signatures and events are never retried automatically
by the embedded message queue; default retries for ordinary Hub are unchanged.

Events use a 256-entry/2 MiB ring queue, with bounded poll responses, current
channel filtering and history repair on overflow. Visible/hidden polling is
2/10 seconds. Group history pages are capped at 20, and oversized query responses
fail explicitly. Resource uploads are at most 8 MiB, two per account, in 64 KiB
chunks; temporary files expire and are cleaned on worker close. Cached resource
access requires a readable live signed reference or authenticated local upload
tracking, never an untrusted manifest's ownerId.

The browser bridge checks parent/frame source, same origin, random context and
expiry. Nextcloud removes the frame on account changes, revocation and expiry.
It validates asset SHA-256 and injects its CSP nonce. The iframe contains only
trusted matching-build code; its same-origin sandbox is not a boundary against
malicious first-party code. Normal Hub content sanitization still applies.

## Initial capability boundary

Group history/send, rich formatting, replies, edits/deletion, reactions, search,
read/mute state, images/files, channels/categories and verified-admin metadata
use the original components. A members reader and native presence are available.
Group discovery/joining uses NuQloud's directory and consent flow. Its parent
owns Top/Active/Newest/Largest ordering, creation fee review/Core confirmation,
and separate first member/admin-key setup; these are shared by both chat UIs.
`getPublicGroupDiscovery` is a zero-argument wallet RPC using the configured Core,
native public Reticulum activity and the same Score v3 calculation as desktop.
It returns versioned metadata only, excluding private/unsolicited activity IDs;
unknown observations stay unknown. See [Group Score](reticulum-group-score.md).
External Auth retains creation signing and all key generation/encryption; setup
and key state use its new `GET_QORTAL_GROUP_SETUP` reader. Upgrade platform, Auth
and this branch together. Group key rotation/distribution is separate.
DMs, calls, calendar and Q-Manager are unavailable. Legacy threads and automatic
welcome publications are disabled. The native wire protocol/history are retained.

The embedded entry loads the account daemon's verified presence snapshot and
subscribes to its updates, feeding the same Jotai online/status atoms as Hub's
ordinary shell. Online, Busy, Idle and Offline badges therefore follow native
presence rather than remaining at the default Offline. The daemon owns the
account announcement/heartbeat; this reader creates no second presence session.
Poll overflow or reconnection reloads the snapshot. A transport failure,
invalidation or unmount clears the badges, and late snapshots cannot restore
the old account's status.

## Verification

```bash
node node_modules/vitest/vitest.mjs run src/nuqloud/presence.test.ts src/atoms/presence.test.ts electron/src/hub-api/nuqloud.test.ts electron/src/hub-api/group-discovery.test.ts src/components/Group/reticulumGroupScore.test.ts src/hosted/client.test.ts src/hosted/HostedConnectionNotice.test.tsx
QORTAL_EXTERNAL_AUTH_REPO=/path/to/built/Qortal-External-Auth node node_modules/vitest/vitest.mjs run electron/src/hub-api/group-key-interop.test.ts
QORTAL_EXTERNAL_AUTH_REPO=/path/to/Qortal-External-Auth node --test daemon/test/headless.test.cjs
```

The headless test requires built Auth, compiled embedded assets and the daemon's
Python environment. It tests real Auth/Hub HTTP, new RPC/sign/assets, consumed
lease rejection, two isolated Reticulum account stores, restart and revocation.
No public Reticulum interfaces are enabled. The companion platform test
`scripts/test-qchat-shared-ui.cjs` runs the real compiled UI/parent bridge and
native signer/SQLite/resources; its engineering plan documents setup and rollout.
Use the owner's existing lifecycle for deployment and retain all history/data.

## Received resources and links follow-up

The NuQloud resource reader uses the current `listReferences` index populated by
native signed-event receipt. It accepts only group references with an event ID,
current account membership and a fresh `canReadGroupResourceReference` check.
The older `listGroupReferences` download index can be empty before a first peer
download and must not gate its status request. Upload ownership remains tracked
locally; peer manifest owner IDs are never proof. Image read exceptions now reach
the existing Retry UI instead of becoming unhandled promise rejections.

The embedded event adapter hands APP/WEBSITE links to the parent cloud's QDN
viewer, and group invitations to its existing consent-based directory. It never
chooses the cloud viewer's origin/route. The matching parent must allow separate
HTTP(S) tabs from the frame; the existing HTTP helper uses `noopener,noreferrer`.
Message auto-linking walks text nodes so formatted anchor attributes are not
rewritten. Code blocks/existing anchors retain their markup, and nested formatted
link text remains clickable. Escaped QDN names/routes/queries/fragments survive
the handoff. DMs and other unsupported protocol actions remain unavailable.

Run the NuQloud API, MessageDisplay, link-helper and presence unit suites, rebuild
both daemon and `build:nuqloud`, then run the platform's compiled UI fixture. It
checks a separately signed received image without a legacy reference, acquisition,
decoding, forced read failure/Retry and actual sandboxed link navigation. The
network boundary is controlled locally; live-peer delivery requires acceptance
through the owner's Git/recreate deployment workflow.
