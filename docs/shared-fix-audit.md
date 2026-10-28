# Standalone shared-fix review on 2026-10-28

The standalone branch was checked against desktop `develop` through `81aa364c`
and the wallet fixes on `main` through `52b1666d`. It retains its separate
External Auth API, Node runtime, per-account databases and injected Reticulum
platform. No browser runtime or Electron dependency was introduced.

The relevant update is the shared Python bridge: event-driven output wakeups,
bounded reliable event admission and logical RNS connection close handling.
The bridge, its regression tests and their matching RNS backend example match
the shared source selected for `hosted-access`. This avoids copying desktop
launch/path discovery over the daemon's injected platform adapter. Updating the
example does not add a daemon endpoint or start an additional service.

The following reviewed changes are outside this runtime:

- Q-App URL handling, wallet approval/signing, Pirate Core responses and
  coin-send request timeouts run in the browser interface, which this API does
  not serve. Relevant backports are on `hosted-access`.
- The private Q-App QUIC/MoQ backend and Go transport executable are used by the
  hosted browser backend. This standalone branch exposes group chat operations
  and does not build or start that executable; its build needs no Go compiler.
- AppImage/Docker packaging, glibc/archive configuration, Electron window/guest
  security and renderer presence updates are outside this headless executable.
- `codegraph-cache/` is already ignored at the root and at nested paths.

## Verification and rollout

The separate daemon dependencies and build remain sufficient:

```bash
npm ci --prefix daemon
npm run build --prefix daemon
npm test --prefix daemon
```

The build rejects static Electron imports. Both native tests passed, including
real SQLite persistence and External Auth delivery between two temporary
accounts using mock Core and local Reticulum interfaces. All 388 Python tests
passed with the existing Reticulum environment. No production service or data
was changed. The existing GitHub workflow does not trigger on this branch;
these checks were run locally.

Update an existing standalone checkout from `origin/hub-daemon`, retain its
current environment, Python runtime and data directory, then rebuild before
an operator-authorized restart through its existing service manager. Check
`/healthz`, then authenticated status, history and delivery between two test
accounts using [hub-daemon.md](hub-daemon.md). Liveness alone does not prove chat
delivery. External Auth configuration and permission behavior are unchanged.

Keep the previous built release for recovery and switch the service back to it
if checks fail, preserving its original environment and data directory. No
database schema migration is introduced. A browser-facing daemon on ai-devrig-2
must use the matching `hosted-access` package rather than this smaller API.
