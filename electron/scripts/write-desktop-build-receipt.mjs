import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronRoot = fileURLToPath(new URL('../', import.meta.url));
const arch = process.env.QORTAL_LINUX_DOCKER_ARCH || 'x64';
const profile = process.env.QORTAL_LINUX_DOCKER_PROFILE || 'full';
const commit = process.env.QORTAL_DESKTOP_SOURCE_COMMIT;
if (!/^[a-f0-9]{40}$/.test(commit || '')) {
  throw new Error(
    'Missing desktop source commit from the Docker build wrapper'
  );
}
const artifactName = `Qortal-Hub${arch === 'arm64' ? '-arm64' : ''}.AppImage`;
const artifact = path.join(electronRoot, 'dist', artifactName);
const hash = createHash('sha256');
for await (const chunk of createReadStream(artifact)) hash.update(chunk);
const pkg = JSON.parse(await readFile(path.join(electronRoot, 'package.json')));
const electron = JSON.parse(
  await readFile(path.join(electronRoot, 'node_modules/electron/package.json'))
);
const bundle = await readFile(
  path.join(electronRoot, 'resources/reticulum/BUNDLE_READY'),
  'utf8'
);
const reticulum = JSON.parse(
  bundle
    .split('\n')
    .find((line) => line.startsWith('reticulum_metadata='))
    ?.slice('reticulum_metadata='.length) || 'null'
);
if (!reticulum) throw new Error('Missing frozen Reticulum provenance');
const receipt = {
  variant: 'desktop',
  method: `npm run electron:make-${arch === 'arm64' ? 'arm' : 'lin'}-docker${profile === 'appimage' ? '-appimage' : ''}`,
  builtAt: new Date().toISOString(),
  source: {
    branch: process.env.QORTAL_DESKTOP_SOURCE_BRANCH,
    commit,
    dirty: process.env.QORTAL_DESKTOP_SOURCE_DIRTY === 'true',
  },
  platform: `linux-${arch}`,
  baseline: 'Debian 11 / glibc 2.31',
  glibcRuntime: process.report.getReport().header.glibcVersionRuntime,
  node: process.versions.node,
  electron: electron.version,
  hub: pkg.version,
  go: execFileSync('go', ['version'], { encoding: 'utf8' }).trim(),
  reticulum,
  artifact: { file: artifactName, sha256: hash.digest('hex') },
};
const output = path.join(electronRoot, 'dist/desktop-build.json');
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
console.log(`Desktop build receipt: ${output}`);
console.log(`AppImage SHA256: ${receipt.artifact.sha256}`);
