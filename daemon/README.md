# Qortal Hub Daemon

Standalone Node runtime for Reticulum group Q-Chat. No Electron or display.

From the repository root:

```bash
npm ci --prefix daemon
npm run setup:reticulum --prefix daemon
npm run build --prefix daemon
npm start --prefix daemon
```

Requires Qortal Core and the updated optional External Auth Hub enhancement.
See [setup, wallet permissions, API and verification](../docs/hub-daemon.md).
