# Headless Qortal Hub

Branch `hub-daemon` starts from current `develop` at `ae338f34` (Hub 3.0.3).
`daemon/` is a separate Node application. It runs the current native RCHAT
manager, SQLite workers, signed presence, Python bridge, and its own `rnsd`.
It does not require Electron, a display, a renderer, or a desktop login.

Each authenticated External Auth wallet gets its own chat/resource databases,
Reticulum identity, Python bridge, and presence session. There is no fixed Hub
wallet and no requirement to run a desktop Hub as the same Qortal account.
External Auth retains wallet keys and signs constrained protocol fields.

The implemented API supports group channels, history, change notifications,
and signed group messages through the optional External Auth integration.
The hosted browser UI, direct-message API, uploads, calls and NuQloud client
changes are separate follow-up work. The deployed `hub.qortal.link` and old
`hosted-access` branch have not been changed.

## Install and run

Requirements: Node 22.12+ (or 24), Python 3.9+ with `venv`/pip, Git, a reachable
Qortal Core, and the companion External Auth checkout containing the Hub
session signer. A compiler/toolchain may be needed if your Node/platform has
no prebuilt `better-sqlite3` binary. The root renderer and `electron/` npm
projects do not need to be installed to build/run this daemon.

Build External Auth and enable its optional Hub enhancement:

```bash
cd ~/git-repos/gitea/crowetic/Qortal-External-Auth
npm ci
npm run build
export QORTAL_AUTH_HUB_ENABLED=true
export QORTAL_AUTH_HUB_URL=http://127.0.0.1:3192
export QORTAL_AUTH_HUB_TIMEOUT_MS=20000
npm start
```

In another terminal, build and launch the headless Hub:

```bash
cd ~/git-repos/crowetic/Qortal-Hub
npm ci --prefix daemon
npm run setup:reticulum --prefix daemon
npm run build --prefix daemon
export QORTAL_HUB_API_AUTH_URL=http://127.0.0.1:3191
export QORTAL_HUB_CORE_URL=http://127.0.0.1:12391
npm start --prefix daemon
```

`setup:reticulum` creates `daemon/.venv` and installs the same Reticulum fork
used by desktop Hub, pinned to a commit. It does not change system Python.
The build bundles native TypeScript and worker threads and copies the Python
resources. A build-time guard rejects static Electron imports.

Environment variables must be exported by the launching shell or configured
in the service manager; the Hub daemon does not automatically load `.env`.
`daemon/example.env` lists the settings. Its defaults connect to Hub's public
Reticulum backbones; actual delivery still depends on reachable network peers.

Check process liveness:

```bash
curl -fsS http://127.0.0.1:3192/healthz
```

This only checks the HTTP process. Authenticated `/hub/status` below starts
an account worker and reports its Reticulum state and verified peer count.

## Connect a wallet and send

Use your existing app credentials with External Auth's `POST /sessions` to
obtain a fresh session token. Select/import an app-owned wallet using the
normal External Auth flow. After restarting External Auth, sessions and
wallet unlocks must be established again.

Set the token and wallet ID in your shell, then grant explicit permissions:

```bash
export AUTH_TOKEN='<External Auth app session token>'
export WALLET_ID='<app-owned walletId>'
for SCOPE in QCHAT_READ QCHAT_PUBLISH; do
  curl -fsS http://127.0.0.1:3191/permissions/set \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H 'Content-Type: application/json' \
    --data "{\"walletId\":\"$WALLET_ID\",\"scope\":\"$SCOPE\",\"mode\":\"session\",\"ttlSeconds\":3600}"
done
```

Unlock that wallet through External Auth's `POST /wallet/unlock`, with the
normal `{walletId,password,ttlSeconds}` JSON body. Unlocking is required before
starting a headless session, including the first status/history request:
Reticulum presence and synchronization require ongoing signatures. Keys and
passwords are never sent to Hub. A password supplied only on a send request
is not a substitute for maintaining this unlocked session.

Start the worker and inspect channels/history. Replace `716` with a group the
wallet actually belongs to:

```bash
curl -fsS "http://127.0.0.1:3191/hub/status?walletId=$WALLET_ID" \
  -H "Authorization: Bearer $AUTH_TOKEN"
curl -fsS "http://127.0.0.1:3191/hub/chat/channels?walletId=$WALLET_ID&groupId=716" \
  -H "Authorization: Bearer $AUTH_TOKEN"
curl -fsS "http://127.0.0.1:3191/hub/chat/history?walletId=$WALLET_ID&groupId=716&channelId=general&limit=20" \
  -H "Authorization: Bearer $AUTH_TOKEN"
curl -fsS http://127.0.0.1:3191/hub/chat/send \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{\"walletId\":\"$WALLET_ID\",\"groupId\":716,\"channelId\":\"general\",\"message\":\"Hello from headless Hub\"}"
```

Status reports `backend: "node"`, the selected wallet/address, joined group
IDs and `reticulum: {state,destinationHash,verifiedPeers}`. A ready bridge
with zero peers can store an accepted event locally, but has no verified peer
for immediate delivery. Verify receipt in another current Hub client.
`accepted:true` is local protocol acceptance, not a remote delivery receipt.

For existing integrations, `/qortal/request` supports `GET_HUB_STATUS`,
`GET_HUB_CHAT_CHANNELS`, `GET_HUB_CHAT_HISTORY`, and `SEND_HUB_CHAT_MESSAGE`.
`SEND_CHAT_MESSAGE` with `payload.transport: "hub"` selects this enhancement;
omitting transport retains the existing Core transaction path. See the
companion `Qortal-External-Auth/docs/hub-chat.md` for payloads.

## Configuration and lifecycle

| Variable                       | Default / meaning                                           |
| ------------------------------ | ----------------------------------------------------------- |
| `QORTAL_HUB_API_HOST`          | `127.0.0.1`; only loopback (`::1` also allowed)             |
| `QORTAL_HUB_API_PORT`          | `3192`                                                      |
| `QORTAL_HUB_API_AUTH_URL`      | `http://127.0.0.1:3191`; trusted issuer/callback origin     |
| `QORTAL_HUB_CORE_URL`          | `http://127.0.0.1:12391`; trusted membership source         |
| `QORTAL_HUB_DATA_DIR`          | `~/.local/share/qortal-hub-daemon`                          |
| `QORTAL_HUB_PYTHON`            | `daemon/.venv/bin/python` (platform equivalent on Windows)  |
| `QORTAL_HUB_API_GROUP_IDS`     | Optional comma-separated allowlist; otherwise joined groups |
| `QORTAL_HUB_API_ORIGINS`       | Optional exact allowed browser origins, comma-separated     |
| `QORTAL_HUB_MAX_ACCOUNTS`      | `16`; concurrent wallet workers, each with a Python bridge  |
| `QORTAL_HUB_ACCOUNT_IDLE_MS`   | `600000`; idle workers stop after 10 minutes                |
| `QORTAL_HUB_RNS_PORT`          | `37438`; separate from desktop's shared Reticulum port      |
| `QORTAL_HUB_RNS_CONTROL_PORT`  | `37439`                                                     |
| `QORTAL_HUB_CUSTOM_RNS_CONFIG` | `1` preserves an operator-written `data/rns/config`         |

The daemon stores histories across restarts. Bearer tokens exist only in
memory. Idle shutdown preserves disk state; the next authenticated request
reopens the worker. Expired/locked/revoked signing sessions stop on the next
25-second presence refresh. HTTP permissions are checked on every request.
Memberships refresh at most every 15 seconds on requests and every 30 seconds
in the background; Core failures remove access and background failures close
the session. Native message validation checks group and channel permissions.

SIGINT/SIGTERM closes the listener, databases, workers and Python processes.
The Python bridges and shared `rnsd` exit when their Node owner dies abruptly.
A PID lock prevents two daemons sharing one data directory. A stale lock from
a dead process is recovered on restart. Do not share its databases between
running instances. Per-wallet logs live alongside account databases; the
shared transport log is `data/rns/rnsd.log`.

For custom Reticulum interfaces, create `QORTAL_HUB_DATA_DIR/rns/config` before
starting with `QORTAL_HUB_CUSTOM_RNS_CONFIG=1`. Configure `share_instance = Yes`,
`shared_instance_type = tcp`, and the shared/control ports matching the daemon
environment. The managed default otherwise rewrites this config on startup.
Default hub endpoints are shared with desktop in `reticulum-hubs.ts`.

`daemon/qortal-hub-daemon.service.example` is a user-systemd service template.
Adjust its Node executable and checkout paths, configure its EnvironmentFile,
then install/start it yourself. No service or production deployment is
installed by this change.

## Direct Hub HTTP contract

Except `/healthz` and CORS preflight, requests require both
`Authorization: Bearer <External Auth token>` and
`X-Qortal-Hub-Wallet-Id: <walletId>`. This header selects an app-owned isolated
worker; successful responses echo it. There is no configured fixed account.
Read operations require `QCHAT_READ`; POST operations require `QCHAT_PUBLISH`.
The headless session additionally needs `QCHAT_READ` and an unlocked wallet
for presence/sync. Session/persistent grants are supported; one-time `ask`
permission approvals are not consumed by this API.

| Method | Route                                            | Result                                            |
| ------ | ------------------------------------------------ | ------------------------------------------------- |
| GET    | `/healthz`                                       | Process liveness                                  |
| GET    | `/v1/status`                                     | Wallet, groups, Node backend and Reticulum status |
| GET    | `/v1/groups/:groupId/channels`                   | Readable channels                                 |
| GET    | `/v1/groups/:groupId/channels/:channelId/events` | `{events:[native event envelopes]}`               |
| GET    | `/v1/groups/:groupId/channels/:channelId/stream` | SSE `ready`/`changed` invalidations               |
| POST   | `/v1/groups/:groupId/sequences`                  | `{}` -> author stream/sequence reservation        |
| POST   | `/v1/groups/:groupId/sequences/release`          | Exact stream/sequence to release                  |
| POST   | `/v1/groups/:groupId/events`                     | Signed native group event -> 202 acceptance       |

History accepts `limit` (1–500), `beforeTimestamp`, `beforeEventId`,
`afterTimestamp`, `afterEventId`. History is local-first; native sync can
subsequently add events. The API returns native payloads without a new
plaintext conversion/decryption endpoint. Current group text formatting
matches desktop Reticulum Q-Chat, including its current JSON message payload.

Direct publishers reserve, sign `buildReticulumChatSignedFields(event)` with
canonical sorted keys, and publish using the same bearer within 30 seconds.
One pending reservation per wallet/group is allowed. Supported event types:
`message`, `edit`, `delete`, `reaction_add`, `reaction_remove`. Failed attempts,
expiry and shutdown release the lease. External Auth's send helper builds
and signs new literal text messages; it does not expose arbitrary signing.

SSE carries only `{groupId,channelId}`. Fetch history after `ready`, `changed`
and reconnect. Use streaming `fetch` to send bearer and wallet headers;
browser EventSource cannot set these. Streams expire after 30 seconds for a
fresh authorization check. There is no durable SSE replay cursor yet.

Limits per listener: 256 KiB JSON bodies, 16 KiB headers, 32 concurrent
requests, 16 streams, 32 reservations and 64 TCP connections. Errors use
`{"error":"machine_code"}`. External Auth wraps upstream errors as
`hub_request_failed` plus sanitized `hubError`. Locked wallets, unavailable
Core/auth, membership denial and account limits do not fall back to Core chat.

## Hosted access and remaining work

Put a TLS reverse proxy in front of the loopback API. Preserve Authorization,
Origin, wallet-binding request/response headers, rewrite upstream Host to
`127.0.0.1:3192` (or `[::1]:3192`), and disable buffering for SSE. Other Host
values are rejected. Set exact browser origins; wildcard CORS is unsupported.
In containers, loopback refers to that container, so use deliberate network
and proxy routing. Hub's auth URL must reach the same issuer as the incoming
session token. Hub/Core/auth URLs are operator configuration.

The browser transport adapter and delegated hosted-user login flow still
need implementation before updating `hub.qortal.link`. Do not expose app
secrets in a browser. Follow-up work also includes DMs, attachments, richer
message helpers, durable reconnect cursors, idempotent sends and deployment
quotas. Native group interoperability with a current desktop peer on the
public mesh remains a manual staging check; automated delivery uses an
isolated local Reticulum network and a Core membership fixture.

## Verification

Standalone native SQLite/signature test:

```bash
npm run build --prefix daemon
npm test --prefix daemon
```

Real External Auth + Node + Python/RNS delivery, persistence and crash cleanup:

```bash
# Build the companion auth checkout first.
QORTAL_EXTERNAL_AUTH_REPO="$HOME/git-repos/gitea/crowetic/Qortal-External-Auth" \
  npm test --prefix daemon
```

The integration test creates temporary app/wallets, uses two separate SQLite
stores and Python bridges, verifies signed presence and peer delivery,
restarts Hub to read persisted history, checks scope revocation, kills Node
to check orphan cleanup and restarts again. Electron imports are blocked and
display variables are empty. No public interfaces are configured and no test
message is sent to the public mesh. Without the companion variable this test
is explicitly skipped; the real SQLite test still runs.

Desktop extraction regressions use the repository test harness:

```bash
npm run pretest
npx vitest run electron/src/hub-api electron/src/reticulum-bridge.test.ts electron/src/reticulum-daemon.test.ts electron/src/reticulum-resource-store.test.ts
```

The standalone TypeScript closure type-checks. Full desktop typechecking still
has the seven pre-existing `WebFrameMain.detached`/missing `sharp` dependency
errors also observed on untouched develop.
