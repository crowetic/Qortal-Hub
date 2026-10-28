import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseCrossOptions,
  verifyCrossOutput,
} from '../scripts/run-cross-docker.mjs';
import { assertWindowsX64 } from '../scripts/build-windows-cross.mjs';
import { validateMacReceipt } from '../scripts/mac-ci-controller.mjs';

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const write = (file: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const digest = (data: string) =>
  createHash('sha256').update(data).digest('hex');

describe('Docker desktop cross-build controller', () => {
  let temp: string;
  let root: string;
  let engine: string;
  let log: string;
  let source: any;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub cross build '));
    root = path.join(temp, 'checkout with spaces');
    fs.mkdirSync(root);
    for (const name of [
      'build-cross-docker.sh',
      'electron/scripts/run-cross-docker.mjs',
    ])
      write(
        path.join(root, name),
        fs.readFileSync(path.join(sourceRoot, name))
      );
    write(path.join(root, '.gitignore'), 'electron/dist/\n');
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['add', '.'], { cwd: root });
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
      { cwd: root }
    );
    source = {
      branch: 'main',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      dirty: false,
    };
    log = path.join(temp, 'engine.jsonl');
    engine = path.join(temp, 'fake-engine');
    write(
      engine,
      `#!${process.execPath}\nconst fs=require('fs'),path=require('path'),crypto=require('crypto');
const args=process.argv.slice(2); fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='info' && process.env.FIXTURE_NO_ENGINE) process.exit(69);
if(args[0]==='run' && !process.env.FIXTURE_NO_RECEIPT) {
 const mount=args.find(a=>a.startsWith('type=bind,source=') && a.endsWith(',target=/output')); const output=mount.slice(17,-15);
 const get=k=>args.find(a=>a.startsWith(k+'=')).slice(k.length+1);
 const artifacts=['Qortal-Hub-test-setup.exe','Qortal-Hub-test-portable.exe'].map(file=>{const data='fixture artifact';fs.writeFileSync(path.join(output,file),data);return{file,size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')}});
 fs.writeFileSync(path.join(output,'desktop-build.json'),JSON.stringify({variant:'desktop',method:'docker-wine-cross',platform:'win32',arch:'x64',signing:get('QORTAL_CROSS_SIGNING'),source:{commit:get('QORTAL_SOURCE_COMMIT'),branch:get('QORTAL_SOURCE_BRANCH'),dirty:get('QORTAL_SOURCE_DIRTY')==='true'},artifacts}));
}`
    );
    fs.chmodSync(engine, 0o755);
  });
  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));
  function run(args: string[], extra: any = {}) {
    return spawnSync(
      process.execPath,
      [path.join(root, 'electron/scripts/run-cross-docker.mjs'), ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          CONTAINER_CMD: engine,
          FIXTURE_LOG: log,
          XDG_CACHE_HOME: path.join(temp, 'cache'),
          ...extra,
        },
        encoding: 'utf8',
      }
    );
  }

  it('accepts explicit Windows signing and separates remote Mac builds', () => {
    expect(parseCrossOptions(['win'])).toMatchObject({
      platform: 'win',
      signing: 'unsigned',
    });
    expect(parseCrossOptions(['mac', '--arch', 'arm64'])).toMatchObject({
      platform: 'mac',
      arch: 'arm64',
    });
    for (const args of [
      ['win', '--arch', 'arm64'],
      ['mac', '--signing', 'signed'],
      ['linux'],
      ['win', '--signing'],
    ])
      expect(() => parseCrossOptions(args)).toThrow();
  });

  it('inspects both paths without contacting Docker or requiring credentials', () => {
    for (const platform of ['win', 'mac']) {
      const result = run([platform, '--dry-run'], { GH_TOKEN: '' });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).method).toBe(
        platform === 'win'
          ? 'docker-wine-cross'
          : 'docker-controller-native-mac-ci'
      );
    }
    expect(fs.existsSync(log)).toBe(false);
  });

  it('preserves earlier artifacts when the engine is unavailable', () => {
    const old = path.join(root, 'electron/dist/Qortal-Hub.AppImage');
    write(old, 'old');
    const result = run(['win'], { FIXTURE_NO_ENGINE: '1' });
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(old, 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(root, 'electron/dist/test-releases'))).toBe(
      false
    );
  });

  it('builds with an empty context, read-only source and isolated writable output', () => {
    const result = run(['win']);
    expect(result.status, result.stderr).toBe(0);
    const commands = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(commands.map((command) => command[0])).toEqual([
      'info',
      'build',
      'run',
    ]);
    expect(commands[1].at(-1)).toBe(
      path.join(root, 'electron/scripts/docker-context')
    );
    expect(commands[2]).toContain(
      `type=bind,source=${root},target=/source,readonly`
    );
    expect(
      commands[2].some((arg) =>
        arg.includes('QORTAL_SOURCE_COMMIT=' + source.commit)
      )
    ).toBe(true);
  });

  it('passes a signed PFX read-only and its password by environment name only', () => {
    const pfx = path.join(temp, 'certificate.pfx');
    write(pfx, 'fixture');
    const result = run(['win', '--signing', 'signed'], {
      WIN_CSC_LINK: pfx,
      WIN_CSC_KEY_PASSWORD: 'private-fixture-password',
    });
    expect(result.status, result.stderr).toBe(0);
    const commands = fs.readFileSync(log, 'utf8');
    expect(commands).toContain('target=/signing/certificate.pfx,readonly');
    expect(commands).toContain('WIN_CSC_KEY_PASSWORD');
    expect(commands).not.toContain('private-fixture-password');
  });

  it('fails before Docker when signing prerequisites or the Mac token are missing', () => {
    expect(
      run(['win', '--signing', 'signed'], {
        WIN_CSC_LINK: '',
        WIN_CSC_KEY_PASSWORD: '',
      }).status
    ).not.toBe(0);
    expect(run(['mac'], { GH_TOKEN: '' }).stderr).toContain(
      'native Mac runner'
    );
    expect(fs.existsSync(log)).toBe(false);
  });

  it('rejects variant branches before contacting the engine', () => {
    execFileSync('git', ['checkout', '-qb', 'hosted-access'], { cwd: root });
    expect(run(['win']).stderr).toContain('regular desktop main');
    expect(fs.existsSync(log)).toBe(false);
  });

  it('does not report success when Docker exits without a completion receipt', () => {
    const result = run(['win'], { FIXTURE_NO_RECEIPT: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('completion receipt');
  });

  it('checks artifact hashes, source and signing rather than trusting an exit code', async () => {
    const dir = path.join(temp, 'output');
    const artifacts = ['one.exe', 'two.exe'].map((file) => {
      write(path.join(dir, file), 'bytes');
      return { file, size: 5, sha256: digest('bytes') };
    });
    write(
      path.join(dir, 'desktop-build.json'),
      JSON.stringify({
        variant: 'desktop',
        method: 'docker-wine-cross',
        platform: 'win32',
        arch: 'x64',
        signing: 'unsigned',
        source,
        artifacts,
      })
    );
    await expect(
      verifyCrossOutput(
        dir,
        { platform: 'win', arch: 'x64', signing: 'unsigned' },
        source
      )
    ).resolves.toBeDefined();
    write(path.join(dir, 'one.exe'), 'corrupt');
    await expect(
      verifyCrossOutput(
        dir,
        { platform: 'win', arch: 'x64', signing: 'unsigned' },
        source
      )
    ).rejects.toThrow('completion receipt');
  });

  it('rejects Linux, ARM and malformed native files masquerading as Windows x64', () => {
    const file = path.join(temp, 'binding.node');
    write(file, '\x7fELF');
    expect(() => assertWindowsX64(file)).toThrow();
    const bytes = Buffer.alloc(128);
    bytes.write('MZ');
    bytes.writeUInt32LE(64, 60);
    bytes.write('PE\0\0', 64);
    bytes.writeUInt16LE(0xaa64, 68);
    write(file, bytes);
    expect(() => assertWindowsX64(file)).toThrow();
    bytes.writeUInt16LE(0x8664, 68);
    write(file, bytes);
    expect(() => assertWindowsX64(file)).not.toThrow();
  });

  it('requires native clean Mac provenance and prevents receipt path traversal', () => {
    const dir = path.join(temp, 'mac');
    const artifacts = ['app.dmg', 'app.zip'].map((file) => {
      write(path.join(dir, file), 'data');
      return { file, size: 4, sha256: digest('data') };
    });
    const receipt = {
      variant: 'desktop',
      method: 'native-test-release',
      platform: 'darwin',
      arch: 'arm64',
      signing: 'unsigned',
      source,
      artifacts,
    };
    const save = () =>
      write(path.join(dir, 'desktop-build.json'), JSON.stringify(receipt));
    save();
    expect(validateMacReceipt(dir, source.commit, 'arm64')).toBeDefined();
    receipt.source = { ...source, dirty: true };
    save();
    expect(() => validateMacReceipt(dir, source.commit, 'arm64')).toThrow(
      'provenance'
    );
    receipt.source = source;
    artifacts[0].file = '../app.dmg';
    save();
    expect(() => validateMacReceipt(dir, source.commit, 'arm64')).toThrow(
      'path/hash'
    );
  });
});
