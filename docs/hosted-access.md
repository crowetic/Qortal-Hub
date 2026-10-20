# Hosted Qortal Hub

The current renderer can run in a browser and use the headless Hub daemon for
Reticulum and other native real-time transports. Login, account creation,
wallet encryption, Qortal transaction signing and application permissions use
the normal Hub interface. **External Auth is not required for hosted users.**
The optional External Auth integration remains available for NuQloud and other
API clients, independently of browser access.

## Build a deployment package

Use the `hosted-access` branch. Install Node 22.12+, Git and Go 1.26+ (or Docker for
the native transport build). From the repository root:

```bash
npm ci
npm ci --prefix daemon
npm run build:hosted -- \
  --origin https://hub.qortal.link \
  --core-url http://127.0.0.1:12391 \
  --out .artifacts/hosted-hub
```

The output directory must not exist. The script refuses to replace an existing
package or deployment. Set `QORTAL_GO_BINARY=/path/to/go` if Go is not on PATH.
`--help` lists the options. `--skip-build` packages already built renderer,
daemon and native transport artifacts; it checks that required artifacts exist.

For WebRTC through NAT, optionally supply `--ice-servers /path/to/ice.json`:

```json
[{ "urls": "stun:your-stun.example.org:3478" }]
```

This file becomes **public browser configuration**. Use an appropriate provider
for STUN and short-lived credentials for TURN. Do not include an External Auth
application secret, API key, wallet password, seed or private key.

The package contains:

| Path                        | Purpose                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `www/`                      | Normal production renderer plus `hub-config.json`                                                    |
| `daemon/`                   | Headless Node executable, workers, Python resources, native transport binary and dependency lockfile |
| `daemon/hosted.env`         | Browser enablement, allowed origin, listener ports and Core URL                                      |
| `nginx.conf`                | HTTPS, WebSocket proxy and cross-origin isolation template                                           |
| `qortal-hub-hosted.service` | Optional systemd user service template                                                               |
| `DEPLOY.txt`                | Installation and startup instructions                                                                |

Build the native package on the deployment server's OS and architecture. The
static `www/` files can be served by any suitable HTTPS web server.
Use the browser and daemon from the same hosted build so their transport
contracts match. The separate `hub-daemon` branch remains available for
standalone daemon/API development.

## Deploy

1. Copy the package to `/srv/qortal-hub`, or adjust the template paths.
2. Serve **only `www/`**. Keep `daemon/`, configuration and account data outside
   the web root. Do not copy a development wallet or data directory into `www/`.
3. On the daemon host install Node, Git, Python 3.9+ and Python's venv support.
   In the packaged `daemon/`, run `npm ci --omit=dev` and
   `npm run setup:reticulum`.
4. Review `daemon/hosted.env`. The Core URL is used by the daemon to verify
   group membership and admin rights. The browser retains the normal Hub node
   selection interface.
5. Start the daemon with the commands in `DEPLOY.txt`, or install the supplied
   systemd user service. Start one daemon per data directory.
6. Adapt the Nginx template to the existing site's certificates and root, check
   it with `nginx -t`, and reload Nginx.

No installation, service restart, web-server reload, commit or deployment is
performed by the build script. Existing External Auth services are independent.
If an existing External Auth-managed Hub daemon is already running, enable the
browser settings on that daemon instead of starting another copy with the same
data directory or Reticulum ports.

The daemon's optional browser listener is disabled unless
`QORTAL_HUB_BROWSER_ENABLED=1`. It binds to loopback on port 3193 by default.
The existing External Auth REST listener remains on port 3192. Customize these
with `QORTAL_HUB_BROWSER_PORT` and `QORTAL_HUB_API_PORT`; the build script's
`--daemon-port` and `--api-port` generate matching configuration.

Preserve these proxy properties when adapting the template:

- HTTPS and WebSocket upgrades; a 90-second or longer idle timeout.
- The original `Origin` header and the exact configured origin allowlist.
- Rewrite upstream `Host` to the daemon's loopback address and listener port.
- Forward `/hub-ws` to `/realtime`, including its query string.
- Disable proxy buffering and access logging for the WebSocket location.
- Serve `hub-config.json` with `Cache-Control: no-store`.
- Cross-Origin-Opener-Policy `same-origin` and Cross-Origin-Embedder-Policy
  `credentialless` for the renderer and its worker assets.

For a split deployment, serve `www/` from CyberPanel and put the TLS WebSocket
proxy on the daemon VM (the selected deployment target is `ai-devrig-2`). Set
`daemonUrl` in the static site's `hub-config.json` to the daemon's public URL,
for example `wss://hub-daemon.qortal.link/hub-ws`. Keep
`QORTAL_HUB_API_ORIGINS=https://hub.qortal.link` on the daemon: this is the
browser website's origin, not the daemon hostname. The generated Nginx template
assumes a combined host; adapt its hostname/certificates and retain the
WebSocket location on the daemon VM. Set the static response headers and
`hub-config.json` cache policy on CyberPanel. This does not require a WebSocket
proxy on CyberPanel.

Current Chromium was used to check the hosted login screen. Credentialless
Q-App frames and cross-origin-isolated audio depend on browser support. Q-Apps
must be served from a different origin than Hub. A QDN Core endpoint on a
separate origin supports the normal iframe permission boundary. Same-origin
Q-App frames are deliberately refused.

## Runtime and identity

```text
Browser: normal Hub UI, unlocked wallet, encryption, media capture/playback
   | wallet-signed nonce proof, then authenticated WebSocket
Daemon: per-wallet/browser Reticulum identity, presence, chat DB, call managers
   | Python bridge / native QUIC sidecar
Reticulum peers and authenticated real-time services
```

The browser signs an expiring, one-use nonce containing the web origin, wallet
identity and browser installation ID. The daemon derives the Qortal address
from the public key and verifies the proof. No authentication secret is embedded
in the hosted bundle. No wallet private key or password is sent to the daemon.

The browser installation ID is public local browser state. Separate browser
installations can use the same wallet with independent Reticulum identities
and storage. One live session per wallet/installation is allowed; a second tab
using that same installation must wait for the first connection to close.
Reconnections retain history in that installation's daemon account directory.

Normal renderer actions sign chat/call events using the existing background
wallet code. Native synchronization can request schema-checked chat control
signatures and relay ticket proofs over the authenticated connection. The
transport cannot request arbitrary transaction or call signatures. Logout closes
the connection, workers, media transports and pending signing operations.

The daemon verifies membership/admin rights against Core. Renderer-supplied
membership flags do not grant access. Each browser account has separate
Reticulum identity, SQLite and resource state; Q-App connections, private
transports and relay ticket signing state are also isolated.

The browser reconnects after a transport failure and reports connection state
in the normal interface. An interrupted call may need to be rejoined. Active
browser sessions count toward `QORTAL_HUB_MAX_ACCOUNTS` (default 16). Deployments
should size CPU, memory, disk and Reticulum bandwidth for their expected users;
each active installation owns a Python bridge and native verification workers.

## Real-time coverage

| Feature                                                              | Hosted path                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Group messages, edits, deletes, reactions, threads, history and sync | Existing Reticulum chat manager through authenticated RPC/events  |
| Direct messages, typing, read state, expiry and history              | Per-account direct-chat manager                                   |
| Channel/category metadata, moderation and calendar                   | Existing signed protocols and local projections                   |
| Presence and selectable online status                                | Browser-signed presence, verified daemon presence manager         |
| Chat attachments                                                     | Bounded upload/download chunks and browser Blob URLs              |
| Direct file offers                                                   | Native Q-Chat link authentication and Reticulum resource transfer |
| Incoming/outgoing direct calls                                       | Native call manager, authenticated signaling to browser           |
| Group calls and encrypted audio fallback                             | Native group-call manager and encrypted WebSocket audio packets   |
| WebRTC audio/video negotiation                                       | Browser audio engine and native authenticated signaling           |
| Direct screen sharing                                                | Browser `getDisplayMedia()` picker and existing WebRTC signaling  |
| Qortal Land state/chat/actions/calls                                 | Reticulum chat manager events and methods                         |
| Land games and proximity transport                                   | Account-bound, one-use proxy to the Python real-time WebSocket    |
| Q-App RNS requests and connections                                   | Per-account Q-App Reticulum manager                               |
| Q-App private channels and MoQ                                       | Per-account native QUIC/MASQUE sidecar and relay admission        |

Browser media permissions and platform codec support still apply. The daemon
does not capture the server's microphone, camera, desktop, or sound output.
Desktop OS configuration, Core installation controls and native filesystem
dialogs remain desktop features. Hosted file operations use browser pickers and
downloads. Hosted upload/download and file-offer sizes are capped at 128 MiB;
upload chunks are 512 KiB. GIF conversion through desktop Sharp is not exposed;
normal browser attachment handling remains available.

Q-App private channels/MoQ need reachable authenticated RNS services and a
compatible community MASQUE relay, as they do on desktop. The build includes the
native sidecar. WebRTC NAT traversal depends on the configured ICE servers.

## Test

```bash
npm run build --prefix daemon
node --test daemon/test/hosted.test.cjs daemon/test/native.test.cjs
npx vitest run src/hosted/client.test.ts src/background/reticulum-signing-policy.test.ts
QORTAL_GO_BINARY=go npm run test:private-transport
```

The hosted integration test starts ordinary Node, real SQLite and Python
Reticulum with an isolated local network and a fixture Core. External Auth is
pointed at an unreachable port. It exercises wallet proof, presence, group/DM
delivery, resources, calls and access isolation. The private transport suite
includes real local QUIC/MASQUE fixtures when Go is available.

For staging, use two browser installations/wallets and a desktop Hub peer. Log
in normally, send group and direct messages, reconnect and verify history, test
file offers in both directions, then try direct/group voice, screen sharing,
Land games/proximity and an RNS/private-channel/MoQ Q-App. Check microphone
permissions and test across your actual NAT/TURN deployment. Automated protocol
tests do not measure microphone playback quality or production NAT behavior.

The `hosted-access` branch retains the earlier hosted implementation's history
and now supplies the current renderer with runtime configuration. Without
`hub-config.json`, the normal renderer startup remains available; desktop
startup uses its native preload. Publishing source does not deploy a hosted site
or restart its daemon.
