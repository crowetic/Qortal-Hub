import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
// Stubs exercise actual shell orchestration in disposable checkouts. They do
// not substitute for a real container/native build and compatibility checks.
const driver = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const root = process.env.FIXTURE_ROOT;
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({tool, args, cwd: process.cwd()}) + '\n');
const put = (file, data) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, data);
};
const electronRoot = path.join(root, 'electron');
const arch = process.env.QORTAL_LINUX_DOCKER_ARCH || 'x64';
if (tool === 'docker') {
  if (args[0] === process.env.FIXTURE_DOCKER_FAIL) process.exit(1);
} else if (tool === 'npm' && args[0] === 'run') {
  if (args[1] === 'build' && process.cwd() === root) {
    put(path.join(root, 'dist/index.html'), 'fresh desktop renderer');
    put(path.join(electronRoot, 'build/foreign-wallet-engine.cjs'), 'fresh signer');
  } else if (args[1] === 'build') {
    put(path.join(electronRoot, 'build/src/index.js'), 'fresh Electron');
  } else if (args[1] === 'build:private-transport') {
    put(path.join(electronRoot, 'resources/private-transport/linux-' + arch + '/qortal-private-transport'), 'fresh transport');
  } else if (args[1] === 'bundle:reticulum') {
    put(path.join(electronRoot, 'resources/reticulum/rnsd'), 'fresh rnsd');
    put(path.join(electronRoot, 'resources/reticulum/presence_bridge'), 'fresh bridge');
    put(path.join(electronRoot, 'resources/reticulum/BUNDLE_READY'), 'reticulum_metadata=' + JSON.stringify({version:'fixture', source:'fixture-source'}) + '\n');
  }
} else if (tool === 'npx') {
  if (args.includes('install-electron')) {
    const target = path.join(electronRoot, 'node_modules/electron/dist/electron');
    put(target, fs.readFileSync(path.join(process.env.FIXTURE_BIN, 'electron')));
    fs.chmodSync(target, 0o755);
  } else if (args.includes('cap')) {
    fs.rmSync(path.join(electronRoot, 'app'), {recursive:true, force:true});
    put(path.join(electronRoot, 'app/index.html'), fs.readFileSync(path.join(root, 'dist/index.html')));
    if (process.env.FIXTURE_HOSTED_CONFIG) put(path.join(electronRoot, 'app/hub-config.json'), '{}');
  } else if (args.includes('electron-rebuild')) {
    put(path.join(electronRoot, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'), 'rebuilt SQLite');
    fs.mkdirSync(path.join(electronRoot, 'node_modules/better-sqlite3/prebuilds'), {recursive:true});
  } else if (args.includes('electron-builder')) {
    put(path.join(electronRoot, 'dist/Qortal-Hub' + (arch === 'arm64' ? '-arm64' : '') + '.AppImage'), fs.readFileSync(path.join(electronRoot, 'app/index.html')));
    const unpacked = arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked';
    const native = 'node_modules/better-sqlite3/prebuilds/linux-' + arch + '.node';
    put(path.join(electronRoot, 'dist', unpacked, 'resources/app.asar.unpacked', native), fs.readFileSync(path.join(electronRoot, native)));
  }
} else if (tool === 'go') {
  console.log('go version go1.26.0 linux/' + (arch === 'arm64' ? 'arm64' : 'amd64'));
} else if (tool === 'readelf') {
  console.log(process.env.FIXTURE_NEW_GLIBC ? 'GLIBC_2.39' : 'GLIBC_2.31');
} else if (tool === 'electron') {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') throw new Error('Expected headless Electron runtime');
  process.exit(spawnSync(process.execPath, args, {stdio:'inherit'}).status || 0);
}
`;

describe('desktop Docker build workflow', () => {
  let scratch: string;
  let root: string;
  let bin: string;
  let log: string;
  let env: NodeJS.ProcessEnv;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const put = (relative: string, content: string) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((v) => JSON.parse(v))
      : [];
  const run = (script: string, args: string[] = [], extra = {}) =>
    spawnSync('bash', [path.join(root, script), ...args], {
      cwd: scratch,
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 30_000,
    });
  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'hub-docker-build-'));
    root = path.join(scratch, 'checkout with spaces');
    bin = path.join(scratch, 'bin');
    log = path.join(scratch, 'calls.jsonl');
    mkdirSync(bin, { recursive: true });
    for (const relative of [
      'build-appimage.sh',
      'electron/scripts/run-linux-build-in-docker.sh',
      'electron/scripts/linux-docker-entry.sh',
      'electron/scripts/write-desktop-build-receipt.mjs',
      'electron/scripts/linux-build.Dockerfile',
    ]) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      copyFileSync(path.join(sourceRoot, relative), path.join(root, relative));
    }
    for (const tool of [
      'docker',
      'npm',
      'npx',
      'go',
      'readelf',
      'chown',
      'electron',
    ]) {
      writeFileSync(
        path.join(bin, tool),
        `#!${process.execPath}\nconst tool = ${JSON.stringify(tool)};\n${driver}`,
        { mode: 0o755 }
      );
    }
    put(
      '.gitignore',
      'node_modules/\ndist/\nelectron/app/\nelectron/build/\nelectron/.build/\n'
    );
    put('electron/package.json', JSON.stringify({ version: '3.0.3' }));
    put(
      'electron/node_modules/electron/package.json',
      JSON.stringify({ version: '44.1.1' })
    );
    put(
      'electron/node_modules/better-sqlite3/index.js',
      'module.exports = class { prepare() { return {get:()=>({ok:1})}; } close() {} };'
    );
    git('init', '-q', '-b', 'develop');
    git('add', '.');
    git(
      '-c',
      'user.name=Build fixture',
      '-c',
      'user.email=build@example.invalid',
      'commit',
      '-qm',
      'fixture'
    );
    env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CONTAINER_CMD: 'docker',
      FIXTURE_ROOT: root,
      FIXTURE_LOG: log,
      FIXTURE_BIN: bin,
      QORTAL_DESKTOP_SOURCE_BRANCH: 'develop',
      QORTAL_DESKTOP_SOURCE_COMMIT: git('rev-parse', 'HEAD'),
      QORTAL_DESKTOP_SOURCE_DIRTY: 'false',
    };
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('runs Phil’s exact npm command from the Electron project from any directory', () => {
    const result = run('build-appimage.sh');
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).toEqual([
      {
        tool: 'npm',
        args: ['run', 'electron:make-lin-docker-appimage'],
        cwd: path.join(root, 'electron'),
      },
    ]);
  });
  it.each(['hosted-access', 'hub-daemon'])(
    'rejects the %s branch before contacting the engine',
    (branch) => {
      git('branch', '-m', branch);
      const result = run('electron/scripts/run-linux-build-in-docker.sh', [
        'appimage',
      ]);
      expect(result.status).toBe(65);
      expect(result.stderr).toContain('Switch to develop');
      expect(calls()).toEqual([]);
    }
  );
  it('rejects tracked hosted code even on a desktop-named branch', () => {
    put('src/hosted/bootstrap.ts', 'export {};');
    git('add', 'src/hosted/bootstrap.ts');
    expect(
      run('electron/scripts/run-linux-build-in-docker.sh', ['appimage']).status
    ).toBe(65);
    expect(calls()).toEqual([]);
  });
  it('ignores untracked daemon leftovers and sends desktop source identity to Docker', () => {
    put('daemon/package.json', '{}');
    const result = run('electron/scripts/run-linux-build-in-docker.sh', [
      'appimage',
    ]);
    expect(result.status, result.stderr).toBe(0);
    const invoked = calls();
    expect(invoked.map((v) => v.args[0])).toEqual(['info', 'build', 'run']);
    expect(invoked[2].args).toContain('QORTAL_LINUX_DOCKER_PROFILE=appimage');
    expect(invoked[2].args).toContain(
      `QORTAL_DESKTOP_SOURCE_COMMIT=${env.QORTAL_DESKTOP_SOURCE_COMMIT}`
    );
    expect(invoked[2].args).toContain('QORTAL_DESKTOP_SOURCE_BRANCH=develop');
    expect(invoked[2].args).toContain(`${root}:/workspace`);
  });
  it('stops on an unavailable engine and preserves the previous artifact', () => {
    put('electron/dist/Qortal-Hub.AppImage', 'previous build');
    const result = run(
      'electron/scripts/run-linux-build-in-docker.sh',
      ['appimage'],
      { FIXTURE_DOCKER_FAIL: 'info' }
    );
    expect(result.status).toBe(69);
    expect(result.stderr).toContain('container engine is unavailable');
    expect(calls().map((v) => v.args[0])).toEqual(['info']);
    expect(
      readFileSync(path.join(root, 'electron/dist/Qortal-Hub.AppImage'), 'utf8')
    ).toBe('previous build');
  });
  it.each([
    ['x64', 'appimage'],
    ['arm64', 'appimage'],
    ['x64', 'full'],
  ])(
    'builds fresh renderer, transport and Electron artifacts and receipts for %s/%s',
    (arch, profile) => {
      put('electron/build/stale-hosted.js', 'stale');
      put('electron/app/hub-config.json', '{}');
      put('electron/.build/rnsd-frozen/stale-host-python', 'stale');
      const result = run('electron/scripts/linux-docker-entry.sh', [], {
        QORTAL_LINUX_DOCKER_ARCH: arch,
        QORTAL_LINUX_DOCKER_PROFILE: profile,
        QORTAL_GO_BINARY: '/unavailable-host-Go',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(
        existsSync(path.join(root, 'electron/build/stale-hosted.js'))
      ).toBe(false);
      expect(existsSync(path.join(root, 'electron/app/hub-config.json'))).toBe(
        false
      );
      expect(
        existsSync(
          path.join(root, 'electron/.build/rnsd-frozen/stale-host-python')
        )
      ).toBe(false);
      const invoked = calls();
      const renderer = invoked.findIndex(
        (v) =>
          v.tool === 'npm' && v.cwd === root && v.args.join(' ') === 'run build'
      );
      const sync = invoked.findIndex(
        (v) => v.tool === 'npx' && v.args.includes('cap')
      );
      const native = invoked.findIndex(
        (v) => v.tool === 'npm' && v.args.includes('build:private-transport')
      );
      const builder = invoked.findIndex(
        (v) => v.tool === 'npx' && v.args.includes('electron-builder')
      );
      expect(renderer).toBeGreaterThan(-1);
      expect(sync).toBeGreaterThan(renderer);
      expect(native).toBeGreaterThan(sync);
      expect(builder).toBeGreaterThan(native);
      expect(invoked[builder].args).toContain('--publish=never');
      expect(invoked[builder].args.includes('deb')).toBe(profile === 'full');
      expect(invoked.some((v) => v.tool === 'electron')).toBe(true);
      const receipt = JSON.parse(
        readFileSync(
          path.join(root, 'electron/dist/desktop-build.json'),
          'utf8'
        )
      );
      expect(receipt.variant).toBe('desktop');
      expect(receipt.platform).toBe(`linux-${arch}`);
      expect(receipt.artifact.file).toBe(
        `Qortal-Hub${arch === 'arm64' ? '-arm64' : ''}.AppImage`
      );
      expect(receipt.source.commit).toBe(env.QORTAL_DESKTOP_SOURCE_COMMIT);
      expect(receipt.source.dirty).toBe(false);
      expect(receipt.artifact.sha256).toBe(
        createHash('sha256').update('fresh desktop renderer').digest('hex')
      );
    }
  );
  it('stops if a hosted config leaks into the fresh frontend', () => {
    const result = run('electron/scripts/linux-docker-entry.sh', [], {
      FIXTURE_HOSTED_CONFIG: '1',
    });
    expect(result.status).toBe(65);
    expect(result.stderr).toContain('Hosted runtime configuration');
    expect(
      calls().some(
        (v) => v.tool === 'npx' && v.args.includes('electron-builder')
      )
    ).toBe(false);
  });
  it('rejects newer-glibc native modules before packaging', () => {
    const result = run('electron/scripts/linux-docker-entry.sh', [], {
      FIXTURE_NEW_GLIBC: '1',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'exceeds the Debian 11 glibc 2.31 baseline'
    );
    expect(
      existsSync(path.join(root, 'electron/dist/desktop-build.json'))
    ).toBe(false);
    expect(calls().some((v) => v.tool === 'chown')).toBe(true);
  });
});
