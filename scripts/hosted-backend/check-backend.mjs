#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
export async function checkBackend({
  directory = packageDir,
  local = false,
  timeout = 5000,
  installDir,
} = {}) {
  const metadata = JSON.parse(
    readFileSync(path.join(directory, 'backend/deployment.json'), 'utf8')
  );
  const daemon = installDir
    ? path.join(installDir, 'current/daemon')
    : path.join(directory, 'daemon');
  const { WebSocket } = createRequire(path.join(daemon, 'package.json'))('ws');
  if (local) {
    const response = await fetch(
      `http://127.0.0.1:${metadata.apiPort}/healthz`,
      { signal: AbortSignal.timeout(timeout) }
    );
    if (!response.ok || (await response.json()).service !== 'qortal-hub-api')
      throw new Error('Local daemon HTTP health check failed');
  }
  const url = local
    ? `ws://127.0.0.1:${metadata.daemonPort}/realtime`
    : metadata.daemonUrl;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: metadata.origin });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket challenge timed out'));
    }, timeout);
    const fail = (error) => {
      clearTimeout(timer);
      ws.terminate();
      reject(error);
    };
    ws.on('error', fail);
    ws.on('unexpected-response', (_request, response) =>
      fail(new Error(`WebSocket upgrade rejected: HTTP ${response.statusCode}`))
    );
    ws.once('close', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket closed before the expected challenge'));
    });
    ws.once('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (
          message.type !== 'challenge' ||
          message.origin !== metadata.origin ||
          !/^[a-zA-Z0-9_-]{43}$/.test(message.nonce)
        )
          throw new Error('Invalid daemon origin-bound challenge');
        clearTimeout(timer);
        ws.close();
        resolve();
      } catch (error) {
        fail(error);
      }
    });
  });
  return {
    ready: true,
    url,
    origin: metadata.origin,
    authenticatedPeerDelivery: 'requires a two-wallet chat test',
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const options = {};
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--local') options.local = true;
      else if (args[i] === '--install-dir' && args[i + 1])
        options.installDir = path.resolve(args[++i]);
      else if (args[i] === '--timeout' && args[i + 1]) {
        options.timeout = Number(args[++i]);
        if (
          !Number.isInteger(options.timeout) ||
          options.timeout < 100 ||
          options.timeout > 30000
        )
          throw new Error('Invalid timeout');
      } else throw new Error(`Unknown or incomplete option: ${args[i]}`);
    }
    console.log(JSON.stringify(await checkBackend(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
