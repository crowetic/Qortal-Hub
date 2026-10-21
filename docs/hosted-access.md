# Hosted Qortal Hub

The current renderer can run in a browser and use the headless Hub daemon for
Reticulum and other native real-time transports. Login, account creation,
wallet encryption, Qortal transaction signing and application permissions use
the normal Hub interface. **External Auth is not required for hosted users.**
The optional External Auth integration remains available for NuQloud and other
API clients, independently of browser access.

## Build and configure

Use the `hosted-access` branch. Install Node 22.12+/npm, Git and Go 1.26+
(or working Docker for the native transport build). From the repository root:

```bash
./build-hosted-access.sh
```

The script prompts for the frontend HTTPS origin, public daemon WSS URL and
Core API reachable from the daemon VM. It saves validated settings to the
ignored `hosted-access.config.json`, installs locked npm dependencies, builds
the frontend and matching native/headless backend, and produces a new package
under `.artifacts/hosted-access/`. Reruns reuse settings and choose a fresh
output directory. Existing packages are never replaced.

For CyberPanel plus the `ai-devrig-2` daemon VM, the unattended equivalent is:

```bash
./build-hosted-access.sh --non-interactive \
  --origin https://hub.qortal.link \
  --daemon-url wss://hub-daemon.qortal.link/hub-ws \
  --core-url http://127.0.0.1:12391
```

The Core URL is relative to the **daemon VM**, so use loopback only when Core
runs there. The default daemon URL without a flag/config is the frontend host
with `/hub-ws`; the interactive prompt suggests a separate daemon hostname.
Both public URLs use TLS on port 443. The private browser and REST listener
ports default to 3193 and 3192 and can be changed independently.

Alternatively copy `hosted-access.config.example.json` to
`hosted-access.config.json`, edit it and run:

```bash
./build-hosted-access.sh --non-interactive
```

`--config FILE` selects another JSON file. Settings are parsed as data, never
sourced as shell code. `--out DIR` chooses an exact new package directory for
this invocation. `--skip-deps` reuses installed npm dependencies; `--skip-build`
packages existing frontend/backend/native builds and also skips dependency
installation. Set `QORTAL_GO_BINARY=/path/to/go` if Go is not on PATH. Use
`--help` for all flags. `npm run build:hosted-access -- ...` is an alias.

The lower-level existing `npm run build:hosted -- --origin ... --daemon-url ...`
remains available for automation that already installs dependencies itself.
The shell wrapper and both CLI entrypoints only configure/build local files;
they never SSH to a VM, install system services, reload a web server or deploy.

For WebRTC NAT traversal, set `iceServers` in the saved JSON or pass
`--ice-servers /path/to/ice.json`, for example:

```json
[{ "urls": "stun:your-stun.example.org:3478" }]
```

ICE settings become **public browser configuration**. Use short-lived TURN
credentials. Do not place External Auth secrets, API keys, wallet passwords,
seeds or private keys in frontend/build configuration.

## Package and deployment

| Path                                | Purpose                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `www/`                              | Static browser app, ready-to-use `hub-config.json`, SPA `.htaccess`                              |
| `daemon/`                           | Matching headless executable/workers, Python resources, native transport and locked dependencies |
| `daemon/hosted.env`                 | Backend environment template; never put this in the web root                                     |
| `backend/install-backend.sh`        | Explicit Linux/systemd installation, update, dry-run and rollback command                        |
| `backend/check-backend.mjs`         | Local HTTP/Ws or public TLS/WSS challenge probe                                                  |
| `backend/deployment.json`           | Build identity, architecture and runtime-code checksums                                          |
| `backend/nginx.conf`                | Daemon-host TLS WebSocket virtual host                                                           |
| `backend/qortal-hub-daemon.service` | Example system service; installer generates actual Node/path settings                            |
| `frontend/nginx.conf`               | Static frontend or combined-host Nginx example                                                   |
| `frontend/cyberpanel.txt`           | Exact OpenLiteSpeed Header Operations and cache configuration                                    |
| `DEPLOY.md` / `DEPLOY.txt`          | Build-specific hostnames, commands, readiness and rollback instructions                          |

Build the native package on the backend server's OS/architecture; the backend
installer requires a matching Linux VM. Static `www/` is platform-independent.
Keep browser and daemon releases together so their transport contracts match.
The `hub-daemon` branch remains separate for standalone daemon/API development.

Serve **only the contents of `www/`** from the CyberPanel document root. It
already points to the configured remote daemon. Enable rewrite rules and
`.htaccess` loading; configure response headers through the site's vhost static
contexts as described in `frontend/cyberpanel.txt`:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless`
- `Cache-Control: no-store` specifically for `/hub-config.json`, including CDN caches

Publish the **contents of the generated `www/` directory**, including
`hub-config.json`, into `/home/hub.qortal.link/public_html/`. A plain `dist/`
upload does not include the generated daemon connection settings. Check that
`https://hub.qortal.link/hub-config.json` returns JSON containing the expected
`daemonUrl`, rather than a 404 or the site's HTML. Without this file the
renderer runs in ordinary browser mode: Reticulum is unavailable and Q-Apps
attempt to use Electron's embedded viewer instead of hosted iframes.

OpenLiteSpeed supports rewrite rules in `.htaccess`, not Apache header
directives. Use the vhost Context Header Operations ([custom headers](https://docs.openlitespeed.org/config/headers/),
[security headers](https://docs.openlitespeed.org/security/headers/)). The generated
`.htaccess` therefore contains only SPA rewrite rules.

Copy `daemon/` and `backend/` together to a private directory on `ai-devrig-2`
(or another chosen VM). Install Node 22.12+/npm, Python 3.9+ with venv/pip, Git
and systemd. Review `daemon/hosted.env`, then run from the copied package:

```bash
./backend/install-backend.sh --dry-run
sudo ./backend/install-backend.sh
```

The installer creates a dedicated service account, prepares locked npm and
Reticulum Python dependencies in a versioned release, and starts a system
service. Account identities, history and resources live separately in
`/var/lib/qortal-hub-daemon`. It preserves existing compatible environment
settings, including optional External Auth settings. An incompatible existing
config requires deliberate `--replace-config`; updates are backed up and only
managed keys change. Unmanaged existing units are refused. If an existing
External Auth-managed daemon is running, plan its migration explicitly instead
of launching a second instance with its data or ports.

Default service: `qortal-hub-daemon.service`; code: `/srv/qortal-hub/current`;
environment: `/etc/qortal-hub/hosted.env`. Custom installation/data/env paths,
account and service name are supported; use installer `--help` and retain the
same flags for updates/rollback. For multiple daemons, also choose distinct
browser/REST and Reticulum shared/control ports. Reticulum port overrides can
be added to the backend environment before installation. Runtime code is
checksummed; the editable environment template is intentionally not checksummed.

The installer handles backend service setup only. Follow `DEPLOY.md` to configure
DNS, certificates and the generated backend TLS proxy. The proxy retains the
browser Origin, rewrites upstream Host to the loopback authority, maps the
configured public path to `/realtime` with query strings, and disables access
logging for one-use transport tickets. Keep private listener/control ports off
the public network. A split deployment needs no WebSocket proxy on CyberPanel.
For a combined hostname, use one combined frontend Nginx vhost rather than two
virtual hosts with the same server name.

### Multiple frontend origins behind Cloudflare

All servers serving the same frontend hostname must contain the same complete
`www/` release and `hub-config.json`, pointing to the same public daemon URL.
The static frontend servers do not hold the authenticated real-time session;
the browser connects directly to the configured daemon. Frontend DNS balancing
therefore does not require a separate daemon for each frontend origin.

For updates, copy the new hashed assets to **every** frontend origin before
switching their `index.html` files. Retain the previous hashed assets while old
pages or service workers may still reference them. Otherwise an HTML response
from one origin can reference an asset missing on another origin. Keep runtime
configuration uncached at both the origin and CDN.

Check each origin directly with normal TLS verification, for example:

```bash
curl --connect-to hub.qortal.link:443:web4.crowetic.com:443 \
  https://hub.qortal.link/hub-config.json
```

Repeat for each active origin and compare its main asset URL/checksum as well.
The hosted client bounds concurrent RPCs, discards stale typing notifications
while busy or offline, and reports operational failures in a real-time notice.
A real-time failure keeps the wallet and Q-App interface available. Queued
requests are cancelled on disconnect or expiry; mutations are never replayed
automatically after reconnecting.

After TLS is configured:

```bash
sudo systemctl status qortal-hub-daemon
node /srv/qortal-hub/current/backend/check-backend.mjs --local
node /srv/qortal-hub/current/backend/check-backend.mjs
```

The local probe establishes HTTP/WebSocket readiness. The public probe also
requires the frontend's `/hub-config.json` to load as JSON and point to this
package's daemon URL; a missing configuration or a mismatched deployment fails
the check. Use `--backend-only` to check public WSS before the static site is
published. Neither probe proves authenticated peer delivery; complete the
two-wallet checks in the Test section. Neither External Auth nor a server
wallet is required.

## Updates and rollback

Run the next package's installer. It prepares dependencies before switching
`current`, keeps persistent data, and retains a private prior-release/config
snapshot. Repeating a completed install does not reinstall or restart a healthy
unchanged service. A failed new service startup restores the previous managed
release automatically. To roll back manually:

```bash
sudo /srv/qortal-hub/current/backend/install-backend.sh --rollback
```

Pass the same custom path/service options used for installation. Restore the
matching previous static `www/` deployment as well. A code rollback retains
account data and does not reverse database/data changes; use your normal data
backup lifecycle where necessary. The build never triggers this rollout itself.

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
npm run test:hosted-build
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
