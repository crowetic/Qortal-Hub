import { build } from 'esbuild';
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, '../electron/src');
await mkdir(path.join(root, 'dist/resources'), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: {
    index: 'src/index.ts',
    native: 'src/native.ts',
    ...Object.fromEntries(
      [
        'reticulum-chat.worker',
        'reticulum-resource.worker',
        'ed25519-verify.worker',
      ].map((name) => [name, path.join(native, `${name}.ts`)])
    ),
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  metafile: true,
  external: ['better-sqlite3', 'moment-timezone'],
  plugins: [
    {
      name: 'no-electron',
      setup(builder) {
        builder.onResolve({ filter: /^electron(?:\/|$)/ }, () => ({
          errors: [
            { text: 'Electron is forbidden in the headless executable' },
          ],
        }));
      },
    },
  ],
});
// A desktop import here would make the executable depend on Electron at runtime.
const desktop = Object.keys(result.metafile.inputs).filter(
  (name) =>
    /(?:reticulum-daemon|index)\.ts$/.test(name) && name.includes('electron/')
);
if (desktop.length) throw new Error(`Desktop dependency in daemon: ${desktop}`);
const resources = path.join(root, '../electron/resources');
for (const name of await readdir(resources)) {
  if (
    (name.endsWith('.py') && !name.startsWith('test_')) ||
    ['mesh-network.identity', 'mesh-network.passphrase'].includes(name)
  ) {
    await copyFile(
      path.join(resources, name),
      path.join(root, 'dist/resources', name)
    );
  }
}
await copyFile(
  path.join(root, 'resources/hub_rnsd.py'),
  path.join(root, 'dist/resources/hub_rnsd.py')
);
console.log('Built headless Hub and native worker threads.');
