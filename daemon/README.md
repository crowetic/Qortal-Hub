# Qortal Hub Daemon

Standalone Node runtime for Reticulum Q-Chat and hosted Hub real-time transport.
No Electron or display.

From the repository root:

```bash
npm ci --prefix daemon
npm run setup:reticulum --prefix daemon
npm run build --prefix daemon
npm start --prefix daemon
```

Hosted browser users log in with the normal Hub wallet interface and need only
Core plus the daemon. External Auth remains optional for integration clients.
Build the matching browser/daemon deployment package from `hosted-access`;
`hub-daemon` remains the standalone daemon/API development branch.
See [hosted build and deployment](../docs/hosted-access.md).
See [setup, wallet permissions, API and verification](../docs/hub-daemon.md).
