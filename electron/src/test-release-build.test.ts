import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  builderConfig,
  buildEnvironment,
  buildTestRelease,
  parseOptions,
} from '../../build-test-release.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const require = createRequire(import.meta.url);
// Renderer-only CI installs only the root npm project. Schema checks additionally
// run when the separate Electron dependencies are installed.
const builderValidation = fs.existsSync(
  path.join(
    root,
    'electron/node_modules/app-builder-lib/out/util/config/config.js'
  )
)
  ? require('../node_modules/app-builder-lib/out/util/config/config.js')
  : null;
const identity = 'Developer ID Application: Fixture (TEST123456)';
const host = (platform = 'darwin', arch = 'arm64') => ({
  platform,
  arch,
  versions: { node: '22.22.0' },
});
const write = (file: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const windowsExe = () => {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 60);
  bytes.write('PE\0\0', 64);
  bytes.writeUInt16LE(0x8664, 68);
  return bytes;
};

// These exercise orchestration with disposable Git checkouts and fake native
// toolchains. They do not pretend to build Windows/macOS packages on Linux.
describe('native desktop test-release workflow', () => {
  let scratch: string;
  let calls: { cmd: string; args: string[]; options: any }[];
  let config: any;
  let mode: any;
  let failAt: string;
  let badPayload: boolean;
  let leakUpdater: boolean;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub test release '));
    fs.mkdirSync(path.join(scratch, 'electron'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', scratch]);
    write(
      path.join(scratch, '.gitignore'),
      'electron/dist/\nelectron/.build/\nelectron/app/\nelectron/build/\nelectron/resources/\n'
    );
    execFileSync('git', ['add', '.'], { cwd: scratch });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'Fixture',
      ],
      { cwd: scratch }
    );
    calls = [];
    config = undefined;
    mode = { platform: 'mac', arch: 'arm64', signing: 'unsigned' };
    failAt = '';
    badPayload = false;
    leakUpdater = false;
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  function command(cmd: string, args: string[], options: any) {
    calls.push({ cmd, args, options: { ...options, env: { ...options.env } } });
    if (cmd === 'git')
      return execFileSync(cmd, args, {
        cwd: options.cwd,
        encoding: 'utf8',
      }).trim();
    if (cmd === 'go') return 'go version go1.26.0 fixture';
    if (args.includes('-c'))
      return JSON.stringify({
        executable: '/fixture/python',
        version: [3, 12, 1],
        arch: mode.arch === 'x64' ? 'AMD64' : 'arm64',
      });
    if (cmd === 'security') return `1) ABC "${identity}"`;
    if (args.includes(failAt) && failAt) throw new Error('Toolchain failed');
    if (args.includes('build:private-transport')) {
      const folder = `${mode.platform === 'mac' ? 'darwin' : 'windows'}-${mode.arch}`;
      write(
        path.join(
          scratch,
          'electron/resources/private-transport',
          folder,
          `qortal-private-transport${mode.platform === 'win' ? '.exe' : ''}`
        ),
        mode.platform === 'win' ? windowsExe() : 'mach-o fixture'
      );
    }
    if (args.includes('bundle:reticulum')) {
      const dir = options.env.QORTAL_RETICULUM_OUTPUT_DIR;
      for (const name of ['rnsd', 'presence_bridge'])
        write(
          path.join(dir, `${name}${mode.platform === 'win' ? '.exe' : ''}`),
          badPayload
            ? 'wrong OS binary'
            : mode.platform === 'win'
              ? windowsExe()
              : 'mach-o fixture'
        );
      write(path.join(dir, 'BUNDLE_READY'), 'reticulum=fixture');
    }
    if (args.includes('--config')) {
      config = JSON.parse(
        fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8')
      );
      const output = config.directories.output;
      const mac = mode.platform === 'mac';
      const appDir = path.join(
        output,
        mac ? (mode.arch === 'x64' ? 'mac' : 'mac-arm64') : 'win-unpacked',
        ...(mac ? ['Qortal Hub.app/Contents/Resources'] : ['resources'])
      );
      for (const item of config.extraResources) {
        if (item.filter) {
          for (const file of item.filter)
            write(path.join(appDir, item.to, file), 'packaged fixture');
        } else write(path.join(appDir, item.to), 'runtime source');
      }
      if (leakUpdater)
        write(path.join(appDir, 'app-update.yml'), 'provider: github');
      for (const suffix of mac
        ? ['.dmg', '.zip']
        : ['-setup.exe', '-portable.exe'])
        write(
          path.join(output, `Qortal-Hub-test-fixture${suffix}`),
          'artifact'
        );
    }
    return '';
  }
  const build = (extra: any = {}) =>
    buildTestRelease(mode, {
      repoRoot: scratch,
      host: host(mode.platform === 'win' ? 'win32' : 'darwin', mode.arch),
      originalEnv: {},
      command,
      npmPath: '/fixture/npm-cli.js',
      ...extra,
    });

  it('defaults to unsigned and rejects unsupported targets and signing modes', () => {
    expect(parseOptions([], host())).toMatchObject({
      platform: 'mac',
      arch: 'arm64',
      signing: 'unsigned',
    });
    for (const args of [
      ['--platform', 'linux'],
      ['--platform', 'win', '--arch', 'arm64'],
      ['--platform', 'win', '--signing', 'notarized'],
      ['--arch', 'universal'],
      ['--signing'],
      ['--publish'],
    ])
      expect(() => parseOptions(args, host())).toThrow();
  });

  it('rejects the wrong host or architecture before any build command or directory', async () => {
    await expect(build({ host: host('linux', 'x64') })).rejects.toThrow(
      'matching native'
    );
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(scratch, 'electron/dist'))).toBe(false);
  });

  it.each(['hosted-access', 'hub-daemon'])(
    'rejects the %s branch',
    async (branch) => {
      execFileSync('git', ['checkout', '-qb', branch], { cwd: scratch });
      await expect(build()).rejects.toThrow('desktop main');
      expect(calls.some((call) => call.args.includes('ci'))).toBe(false);
    }
  );

  it('rejects tracked hosted code even when its branch is named main', async () => {
    write(path.join(scratch, 'src/hosted/bootstrap.ts'), '// hosted');
    execFileSync('git', ['add', 'src/hosted/bootstrap.ts'], { cwd: scratch });
    await expect(build()).rejects.toThrow('desktop main');
  });

  it('builds fresh renderer/native payloads in order and preserves earlier artifacts', async () => {
    const previous = path.join(scratch, 'electron/dist/Qortal-Hub.AppImage');
    write(previous, 'earlier build');
    write(path.join(scratch, 'electron/build/stale.js'), 'old');
    write(path.join(scratch, 'electron/app/hub-config.json'), '{}');
    const result = await build({
      originalEnv: {
        CSC_LINK: 'secret',
        WIN_CSC_LINK: 'secret',
        APPLE_ID: 'secret',
        QORTAL_RETICULUM_BUILD_ARCH: 'x64',
        QORTAL_PRIVATE_TRANSPORT_GOOS: 'linux',
      },
    });
    expect(fs.readFileSync(previous, 'utf8')).toBe('earlier build');
    expect(fs.existsSync(path.join(scratch, 'electron/build/stale.js'))).toBe(
      false
    );
    const steps = calls
      .filter((call) => call.args[0] === '/fixture/npm-cli.js')
      .map(
        (call) =>
          `${path.basename(call.options.cwd)}:${call.args.slice(1).join(' ')}`
      );
    expect(steps.map((step) => step.slice(step.indexOf(':') + 1))).toEqual([
      'ci',
      'ci',
      'exec --no -- install-electron',
      'run build',
      'exec --no -- cap sync @capacitor-community/electron',
      'run build',
      'run build:private-transport',
      'run bundle:reticulum',
    ]);
    const builder = calls.find((call) => call.args.includes('--config'))!;
    expect(builder.args).toContain('--publish=never');
    expect(builder.options.env.CSC_LINK).toBeUndefined();
    expect(builder.options.env.APPLE_ID).toBeUndefined();
    expect(builder.options.env.QORTAL_PRIVATE_TRANSPORT_GOOS).toBe('darwin');
    expect(config.mac).toMatchObject({
      identity: '-',
      notarize: false,
      target: ['dmg', 'zip'],
    });
    expect(
      config.extraResources.some((item) => item.to === 'reticulum/darwin-arm64')
    ).toBe(true);
    expect(result.receipt).toMatchObject({
      source: { branch: 'main', dirty: false },
      publish: false,
      adHoc: true,
    });
    expect(result.receipt.artifacts).toHaveLength(2);
    expect(result.receipt.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.receipt)).not.toContain('secret');
  });

  it('requires signing credentials before installing dependencies', async () => {
    mode.signing = 'signed';
    await expect(build()).rejects.toThrow('QORTAL_MAC_SIGN_IDENTITY');
    expect(calls).toHaveLength(0);
    mode = { platform: 'win', arch: 'x64', signing: 'signed' };
    await expect(build()).rejects.toThrow('WIN_CSC_LINK');
    expect(calls).toHaveLength(0);
  });

  it('rejects an ambient builder env file before installing or packaging', async () => {
    write(
      path.join(scratch, 'electron/electron-builder.env'),
      'CSC_LINK=fixture'
    );
    await expect(build()).rejects.toThrow('reloads ambient signing settings');
    expect(calls).toHaveLength(0);
  });

  it('passes installed Mac identity to PyInstaller and verifies notarization', async () => {
    mode.signing = 'notarized';
    const result = await build({
      originalEnv: {
        QORTAL_MAC_SIGN_IDENTITY: identity,
        APPLE_ID: 'test@example.invalid',
        APPLE_TEAM_ID: 'TEST123456',
        APPLE_APP_SPECIFIC_PASSWORD: 'not-a-real-password',
      },
    });
    const freezer = calls.find((call) =>
      call.args.includes('bundle:reticulum')
    )!;
    expect(freezer.options.env.QORTAL_RETICULUM_CODESIGN_IDENTITY).toBe(
      identity
    );
    expect(config).toMatchObject({
      forceCodeSigning: true,
      afterSign: null,
      mac: { identity: 'Fixture (TEST123456)', notarize: true },
    });
    expect(
      calls.some(
        (call) => call.cmd === 'xcrun' && call.args.includes('validate')
      )
    ).toBe(true);
    expect(calls.some((call) => call.cmd === 'spctl')).toBe(true);
    expect(JSON.stringify(result.receipt)).not.toContain('not-a-real-password');
  });

  it('does not notarize a signed-only Mac build even with Apple credentials set', async () => {
    mode.signing = 'signed';
    await build({
      originalEnv: { QORTAL_MAC_SIGN_IDENTITY: identity, APPLE_ID: 'secret' },
    });
    expect(config.mac.notarize).toBe(false);
    expect(
      calls.find((call) => call.args.includes('--config'))!.options.env.APPLE_ID
    ).toBeUndefined();
    expect(calls.some((call) => call.cmd === 'spctl')).toBe(false);
  });

  it('builds distinct signed Windows installers and validates their signatures', async () => {
    mode = { platform: 'win', arch: 'x64', signing: 'signed' };
    await build({
      originalEnv: {
        WIN_CSC_LINK: '/fixture/cert.pfx',
        WIN_CSC_KEY_PASSWORD: 'secret',
      },
    });
    expect(config.win).toMatchObject({
      signExecutable: true,
      signExts: ['.exe', '.dll', '.node'],
    });
    expect(config.nsis).toMatchObject({
      runAfterFinish: false,
      deleteAppDataOnUninstall: false,
    });
    expect(config.portable.artifactName).not.toBe(config.nsis.artifactName);
    expect(calls.filter((call) => call.cmd === 'powershell.exe')).toHaveLength(
      2
    );
  });

  it('supports a Windows hardware-backed certificate through its store thumbprint', async () => {
    mode = { platform: 'win', arch: 'x64', signing: 'signed' };
    await build({ originalEnv: { QORTAL_WIN_CERT_SHA1: 'A'.repeat(40) } });
    expect(config.win.signtoolOptions.certificateSha1).toBe('A'.repeat(40));
    expect(calls.filter((call) => call.cmd === 'powershell.exe')).toHaveLength(
      3
    );
    expect(
      calls.find((call) => call.args.includes('--config'))!.options.env
        .WIN_CSC_LINK
    ).toBeUndefined();
  });

  it('builds Intel macOS without certificate discovery or notarization', async () => {
    mode.arch = 'x64';
    const result = await build();
    expect(config.mac.identity).toBeNull();
    expect(result.receipt.adHoc).toBe(false);
    expect(calls.some((call) => call.cmd === 'codesign')).toBe(false);
  });

  it('requires all notarization credentials and rejects ambiguous Windows signing', () => {
    expect(() =>
      buildEnvironment(
        { platform: 'mac', signing: 'notarized' },
        { QORTAL_MAC_SIGN_IDENTITY: identity }
      )
    ).toThrow('APPLE_ID');
    expect(() =>
      buildEnvironment(
        { platform: 'win', signing: 'signed' },
        { QORTAL_WIN_CERT_SHA1: 'A'.repeat(40), WIN_CSC_LINK: 'cert.pfx' }
      )
    ).toThrow('not both');
    expect(() =>
      buildEnvironment(
        { platform: 'win', signing: 'signed' },
        { QORTAL_WIN_CERT_SHA1: 'bad' }
      )
    ).toThrow('thumbprint');
  });

  it('rejects a foreign native payload without packaging or a success receipt', async () => {
    mode = { platform: 'win', arch: 'x64', signing: 'unsigned' };
    badPayload = true;
    await expect(build()).rejects.toThrow('Windows x64 PE');
    expect(calls.some((call) => call.args.includes('--config'))).toBe(false);
  });

  it('propagates a compiler error without invoking the packager', async () => {
    failAt = 'build:private-transport';
    await expect(build()).rejects.toThrow('Toolchain failed');
    expect(calls.some((call) => call.args.includes('--config'))).toBe(false);
  });

  it('rejects a packaged production updater configuration', async () => {
    leakUpdater = true;
    await expect(build()).rejects.toThrow('production update feed');
    const output = config.directories.output;
    expect(fs.existsSync(path.join(output, 'desktop-build.json'))).toBe(false);
  });

  it.skipIf(!builderValidation).each([
    { platform: 'win', arch: 'x64', signing: 'unsigned' },
    { platform: 'win', arch: 'x64', signing: 'signed' },
    { platform: 'mac', arch: 'x64', signing: 'unsigned' },
    { platform: 'mac', arch: 'arm64', signing: 'signed' },
    { platform: 'mac', arch: 'arm64', signing: 'notarized' },
  ])(
    'validates and resolves $platform $arch $signing with the installed builder',
    async (options) => {
      const configFile = path.join(scratch, 'test-builder.json');
      write(
        configFile,
        JSON.stringify(
          builderConfig(options, '/fixture/native', '/fixture/output', identity)
        )
      );
      const actual = await builderValidation.getConfig(
        path.join(root, 'electron'),
        configFile,
        null
      );
      await builderValidation.validateConfiguration(actual, {
        isEnabled: false,
      });
      expect(actual.publish).toBeNull();
      expect(
        actual.extraResources.filter(
          (item) => item.from === 'resources/reticulum'
        )
      ).toHaveLength(0);
    }
  );

  it('supports credential-free cross-host inspection without creating artifacts', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'build-test-release.mjs'),
        '--platform',
        'mac',
        '--arch',
        'x64',
        '--signing',
        'notarized',
        '--dry-run',
      ],
      { cwd: scratch, encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).configuration.publish).toBeNull();
    expect(fs.readdirSync(path.join(scratch, 'electron'))).toHaveLength(0);
  });
});
