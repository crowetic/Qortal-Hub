import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { resolve, dirname } from 'node:path';
import { rename, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const root = __dirname;
const substitutions = new Map([
  ['src/App', 'src/nuqloud/app.ts'],
  ['src/utils/globalApi', 'src/nuqloud/globalApi.ts'],
  ['src/background/background', 'src/nuqloud/background.ts'],
  ['src/messaging/MessagesToBackground', 'src/nuqloud/messages.ts'],
  ['src/components/Group/Group', 'src/nuqloud/group.ts'],
  ['src/components/Desktop/CustomTitleBar', 'src/nuqloud/titlebar.ts'],
  ['src/components/Apps/AppViewerContainer', 'src/nuqloud/unavailable.tsx'],
]);
export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [
    {
      name: 'nuqloud-services',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer || !source.startsWith('.')) return;
        const candidate = resolve(dirname(importer), source).replace(
          /\.[jt]sx?$/,
          ''
        );
        for (const [name, replacement] of substitutions)
          if (candidate === resolve(root, name))
            return resolve(root, replacement);
      },
      async closeBundle() {
        await rename(
          resolve(root, 'daemon/dist/nuqloud-ui/nuqloud.html'),
          resolve(root, 'daemon/dist/nuqloud-ui/index.html')
        );
        let sourceRevision = process.env.QORTAL_HUB_SOURCE_REVISION || null;
        try {
          sourceRevision ||= execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch {
          /* Container source has no Git metadata. */
        }
        await writeFile(
          resolve(root, 'daemon/dist/nuqloud-ui/build-info.json'),
          JSON.stringify({ contractVersion: 1, sourceRevision })
        );
      },
    },
    react(),
    wasm(),
    topLevelAwait(),
  ],
  worker: { format: 'es' },
  build: {
    outDir: 'daemon/dist/nuqloud-ui',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: resolve(root, 'nuqloud.html') },
  },
});
