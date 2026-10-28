# Shared fixes reviewed on 2026-10-28

This branch retains its browser adapters and matching headless runtime. Changes
were selected from desktop `develop` through `81aa364c` and the subsequent
wallet fixes on `main` through `52b1666d`; neither branch was merged wholesale.

| Change                                                                                  | `hosted-access`                                                       | `hub-daemon`                                            |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| Q-App render/bookmark/chat link encoding and use-group navigation                       | Ported; preserve hosted iframe source/origin checks                   | No browser/Q-App viewer in the standalone API           |
| Explicit foreign-fee approval, bounded validated signing and account/node change checks | Ported with all existing translations                                 | No foreign-wallet signing endpoint                      |
| Pirate Core error preservation and longer pending Q-App coin sends                      | Ported                                                                | No coin-send endpoint                                   |
| RNS/QUIC/MoQ recovery, bounded queues, cancellation and redacted setup diagnostics      | Ported; retain per-wallet relay state and explicit sidecar executable | Standalone API does not expose private Q-App transports |
| Python bridge wakeups and reliable queue/close handling                                 | Ported                                                                | Ported to the same shared bridge source                 |
| Go `-buildvcs=false`                                                                    | Ported; the hosted package builds this binary                         | Standalone daemon build does not invoke Go              |
| Presence rendering deduplication                                                        | Ported; embedded NuQloud presence contract retained                   | No renderer                                             |
| Generated codegraph cache ignore                                                        | Already applies at every directory depth                              | Already applies at every directory depth                |
| AppImage wrappers, Docker glibc/Go/archive setup and Electron window/guest hardening    | Desktop-only; outside the hosted build/runtime                        | Desktop-only; outside the standalone build/runtime      |

The hosted relay coordinator keeps the new cancellation and recovery behavior
inside each wallet's existing account state. Concurrent account and group reads
must not change another wallet or the desktop's default coordinator. Regression
tests cover that boundary and encoded Q-App names through the hosted iframe
origin check.

Browser login and signing remain in the Hub interface. External Auth stays
optional for browser users and required only for its own standalone API clients.
This backport does not add an Electron signer to the browser or change the
existing BTC-family native-signing capability boundary. Existing hosted RPC
backpressure, reconnect handling, NuQloud embedding and permission boundaries
are retained. No service, Core, wallet, data directory or deployment was changed.

## Verification and rollout

The root lockfile is unchanged. The audit passed 2,520 JavaScript tests (82
skipped), 388 Python tests, all three daemon integration tests, the hosted
packaging suite's 14 tests and the changed Go protocol/MoQ/fixture packages.
Both renderer entries, the transport executable, the headless build and the
Electron source type check passed. The daemon build still rejects static
Electron imports. Native integration fixtures use temporary accounts, SQLite
databases, mock Core and local Reticulum interfaces; browser proof/chat also
passes without External Auth.

Changed-file lint introduces no new findings. `src/qortal/get.ts` retains three
pre-existing `no-constant-condition` findings on unchanged `while (true)` loops;
their diagnostics were compared with the original branch. Locale sorting and
all newly imported foreign-fee translations pass. The existing GitHub workflow
does not trigger on either variant branch, so these checks were run locally.

For a release, update an existing `hosted-access` checkout, then run
`./build-hosted-access.sh --non-interactive` using its saved
`hosted-access.config.json`. A new machine must supply the validated origin,
daemon URL and daemon-reachable Core URL documented in [hosted-access.md](hosted-access.md).
Build on the backend VM's OS/architecture. For NuQloud's separate embedded UI,
also follow [nuqloud-chat.md](nuqloud-chat.md) and its existing multi-stage build.

Deployment remains an explicit operator action. In the generated package,
review `DEPLOY.md` and `daemon/hosted.env`, retain the target's existing custom
installer options/environment, and use:

```bash
./backend/install-backend.sh --dry-run
sudo ./backend/install-backend.sh
node ./backend/check-backend.mjs
```

Use this matching hosted backend package for the browser service on ai-devrig-2;
the standalone `hub-daemon` branch has a smaller API. Publish only `www/` on
CyberPanel. Across all Cloudflare origins, publish new assets everywhere before
switching HTML/service workers, preserve previous hashed assets, and retain the
uncached matching `hub-config.json`. Confirm authenticated chat, a Q-App with an
encoded name, and permissions after reconnecting. Wallet sends require explicit
owner testing; automated checks do not move funds.

Keep the previous frontend package and backend release. For recovery, restore
the frontend on every origin and run the generated backend installer with
`--rollback` and the same target-specific options used during installation.
Preserve the existing data directory; this backport does not migrate its schema.
