import path from 'node:path';
import { configureNativeRuntimeEnvironment } from '../../electron/src/native-runtime-environment';
import { startHubApi } from '../../electron/src/hub-api/server';
import { readConfig } from './config';
import { AccountRegistry } from './accounts';
import { lockDataDirectory, startReticulum } from './reticulum';

async function main() {
  process.umask(0o077);
  const config = readConfig();
  configureNativeRuntimeEnvironment({
    path: (name) =>
      name === 'temp' ? path.join(config.dataDir, 'tmp') : config.dataDir,
    resources: () => config.resourcesDir,
    packaged: () => false,
    ready: () => true,
  });
  const unlock = lockDataDirectory(config.dataDir);
  let rns: Awaited<ReturnType<typeof startReticulum>> | undefined;
  let accounts: AccountRegistry | undefined;
  let api: Awaited<ReturnType<typeof startHubApi>> | undefined;
  let closing: Promise<void> | undefined;
  let initialized = false;
  let terminating = false;
  const close = () =>
    (closing ||= (async () => {
      await api?.close();
      await accounts?.close();
      await rns?.stop();
      unlock();
    })());
  const shutdown = () => {
    terminating = true;
    if (initialized)
      void close().then(() => {
        process.exitCode = 0;
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    rns = await startReticulum(config, () => {
      terminating = true;
      console.error('Reticulum daemon exited unexpectedly');
      if (initialized)
        void close().then(() => {
          process.exitCode = 1;
        });
    });
    if (terminating) {
      await close();
      return;
    }
    accounts = new AccountRegistry(config);
    api = await startHubApi(
      config.api,
      async () => {
        throw new Error('Dynamic account resolver required');
      },
      async () => {
        throw new Error('Dynamic account resolver required');
      },
      accounts.resolve
    );
    initialized = true;
    if (terminating) {
      await close();
      return;
    }
    console.log(
      JSON.stringify({
        service: 'qortal-hub-daemon',
        backend: 'node',
        address: api.server.address(),
        dataDir: config.dataDir,
      })
    );
  } catch (error) {
    await close();
    throw error;
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
