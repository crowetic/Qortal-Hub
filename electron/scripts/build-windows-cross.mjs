#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { builderConfig, buildEnvironment } from '../../build-test-release.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const electron = path.join(root, 'electron');

function windowsMachine(file) {
  const data = fs.readFileSync(file);
  const pe = data.length >= 64 ? data.readUInt32LE(60) : data.length;
  if (
    data.toString('ascii', 0, 2) !== 'MZ' ||
    pe + 6 > data.length ||
    data.toString('ascii', pe, pe + 4) !== 'PE\0\0'
  )
    throw new Error(`Not a Windows PE payload: ${file}`);
  return data.readUInt16LE(pe + 4);
}

export function assertWindowsX64(file) {
  if (windowsMachine(file) !== 0x8664)
    throw new Error(`Not a Windows x64 PE payload: ${file}`);
}

export function assertWindowsInstaller(file) {
  // NSIS uses an x86 launcher even when its embedded application is x64.
  // Native application payloads must still pass assertWindowsX64 separately.
  if (![0x14c, 0x8664].includes(windowsMachine(file)))
    throw new Error(`Not a Windows x86/x64 installer: ${file}`);
}

async function hash(file) {
  const digest = createHash('sha256');
  for await (const part of fs.createReadStream(file)) digest.update(part);
  return digest.digest('hex');
}

export async function buildWindowsCross() {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('Windows cross-builder requires Linux x64.');
  const output = path.resolve(process.env.QORTAL_CROSS_OUTPUT || '/output');
  const cache = path.resolve(process.env.QORTAL_CROSS_CACHE || '/cache');
  const options = {
    platform: 'win',
    arch: 'x64',
    signing: process.env.QORTAL_CROSS_SIGNING || 'unsigned',
  };
  if (!['unsigned', 'signed'].includes(options.signing))
    throw new Error('Unknown signing mode.');
  const env = buildEnvironment(options, process.env);
  const source = {
    branch: process.env.QORTAL_SOURCE_BRANCH,
    commit: process.env.QORTAL_SOURCE_COMMIT,
    dirty: process.env.QORTAL_SOURCE_DIRTY === 'true',
  };
  if (
    !/^[a-f\d]{40}$/.test(source.commit || '') ||
    ['hosted-access', 'hub-daemon'].includes(source.branch) ||
    fs.existsSync(path.join(root, 'src/hosted/bootstrap.ts')) ||
    fs.existsSync(path.join(root, 'daemon/package.json'))
  )
    throw new Error(
      'Missing desktop source provenance or wrong source variant.'
    );
  if (fs.existsSync(path.join(electron, 'electron-builder.env')))
    throw new Error(
      'Ambient electron-builder.env is unsupported; use explicit signing variables.'
    );
  const run = (cmd, args, cwd = root, capture = false, extra = {}) => {
    const result = spawnSync(cmd, args, {
      cwd,
      env: { ...env, ...extra },
      encoding: 'utf8',
      stdio: capture ? 'pipe' : 'inherit',
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `${path.basename(cmd)} failed (${result.status ?? result.error?.code}).${capture ? ` ${result.stderr || ''}` : ''}`
      );
    return result.stdout?.trim() || '';
  };
  const winPath = (file) => run('winepath', ['-w', file], root, true);
  const wineVersion = run('wine', ['--version'], root, true);
  if (Number(wineVersion.match(/^wine-(\d+)/)?.[1] || 0) < 11)
    throw new Error('Wine 11+ is required for CPython 3.12 CopyFile2 support.');
  const python = env.QORTAL_WINDOWS_PYTHON;
  if (!python || !fs.existsSync(python))
    throw new Error('Image is missing its Windows Python interpreter.');
  const pyVersion = run(
    'wine',
    [
      python,
      '-c',
      'import sys,platform,json; print(json.dumps({"version":platform.python_version(),"arch":platform.machine(),"platform":sys.platform}))',
    ],
    root,
    true
  );
  const py = JSON.parse(pyVersion);
  if (py.platform !== 'win32' || py.arch !== 'AMD64')
    throw new Error('Reticulum must be frozen by Windows x64 Python.');
  run('npm', ['ci', '--no-audit', '--no-fund']);
  // Install Windows optional packages (especially Sharp), never Linux addons.
  run(
    'npm',
    [
      'ci',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--include=optional',
      '--os=win32',
      '--cpu=x64',
    ],
    electron
  );
  fs.rmSync(path.join(electron, 'build'), { recursive: true, force: true });
  fs.rmSync(path.join(electron, 'app'), { recursive: true, force: true });
  run('npm', ['run', 'build']);
  run('npm', [
    'exec',
    '--no',
    '--',
    'cap',
    'sync',
    '@capacitor-community/electron',
  ]);
  if (fs.existsSync(path.join(electron, 'app/hub-config.json')))
    throw new Error('Hosted configuration leaked into desktop renderer.');
  run('npm', ['exec', '--no', '--', 'tsc'], electron);
  run('npm', ['run', 'build:private-transport'], electron);
  const runtime = path.join(electron, '.build/cross-reticulum');
  fs.mkdirSync(runtime, { recursive: true });
  const reticulumCommit = run(
    'git',
    [
      'ls-remote',
      'https://github.com/Philreact/Reticulum.git',
      'refs/heads/master',
    ],
    root,
    true
  ).split(/\s/)[0];
  if (!/^[a-f\d]{40}$/.test(reticulumCommit))
    throw new Error('Cannot resolve Reticulum source revision.');
  run(
    'wine',
    [
      python,
      winPath(path.join(electron, 'scripts/build-rnsd-frozen.py')),
      '--output-dir',
      winPath(runtime),
    ],
    electron,
    false,
    {
      QORTAL_RETICULUM_PIP_PACKAGE: `https://github.com/Philreact/Reticulum/archive/${reticulumCommit}.zip`,
    }
  );
  const sqlite = path.join(electron, 'node_modules/better-sqlite3/prebuilds');
  for (const name of fs.readdirSync(sqlite))
    if (name !== 'win32-x64.node')
      fs.rmSync(path.join(sqlite, name), { recursive: true, force: true });
  const sidecar = path.join(
    electron,
    'resources/private-transport/windows-x64/qortal-private-transport.exe'
  );
  for (const file of [
    sidecar,
    path.join(sqlite, 'win32-x64.node'),
    path.join(runtime, 'rnsd.exe'),
    path.join(runtime, 'presence_bridge.exe'),
  ])
    assertWindowsX64(file);

  const requireElectron = createRequire(
    path.join(electron, 'node_modules/electron/package.json')
  );
  const version = requireElectron('./package.json').version;
  const { downloadArtifact } = requireElectron('@electron/get');
  const archive = await downloadArtifact({
    version,
    artifactName: 'electron',
    platform: 'win32',
    arch: 'x64',
    cacheRoot: path.join(cache, 'electron'),
  });
  const requireBuild = createRequire(path.join(electron, 'package.json'));
  const extract = requireBuild('extract-zip');
  const winElectron = path.join(electron, '.build/windows-electron');
  await extract(archive, { dir: winElectron });
  const smoke = (exe, packageFile, file) => {
    // Wine console handles can be unavailable in headless mode. File output also
    // lets us reject a zero exit without proof that Electron loaded the addons.
    const script = `const r=require('node:module').createRequire(${JSON.stringify(winPath(packageFile))}); const D=r('better-sqlite3'); const db=new D(':memory:'); const row=db.prepare('select sqlite_version() as sqlite').get(); db.close(); r('sharp')({create:{width:1,height:1,channels:4,background:'white'}}).png().toBuffer().then(p=>{if(p.length<8)throw Error('PNG failed'); require('fs').writeFileSync(${JSON.stringify(winPath(file))},JSON.stringify({platform:process.platform,arch:process.arch,electron:process.versions.electron,...row,sharp:r('sharp').versions.sharp}));}).catch(()=>process.exit(1));`;
    run('wine', [exe, '-e', script], electron, false, {
      ELECTRON_RUN_AS_NODE: '1',
    });
    const proof = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      proof.platform !== 'win32' ||
      proof.arch !== 'x64' ||
      proof.electron !== version ||
      !proof.sqlite ||
      !proof.sharp
    )
      throw new Error('Windows Electron native addon smoke failed.');
    return proof;
  };
  smoke(
    path.join(winElectron, 'electron.exe'),
    path.join(electron, 'package.json'),
    path.join(electron, '.build/pre-package-native.json')
  );
  run('wine', [path.join(runtime, 'rnsd.exe'), '--version']);
  const config = builderConfig(options, runtime, output);
  config.npmRebuild = false; // The actual Windows Electron process above proves ABI compatibility.
  const configFile = path.join(electron, '.build/windows-cross.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  run(
    process.execPath,
    [
      path.join(electron, 'node_modules/electron-builder/cli.js'),
      'build',
      '--config',
      configFile,
      '--win',
      '--x64',
      '--publish=never',
    ],
    electron
  );
  const unpacked = path.join(output, 'win-unpacked');
  const resources = path.join(unpacked, 'resources');
  if (fs.existsSync(path.join(resources, 'app-update.yml')))
    throw new Error('Unexpected production update feed.');
  for (const file of [
    'reticulum/rnsd.exe',
    'reticulum/presence_bridge.exe',
    'private-transport/windows-x64/qortal-private-transport.exe',
  ])
    assertWindowsX64(path.join(resources, file));
  const native = smoke(
    path.join(unpacked, 'Qortal Hub.exe'),
    path.join(resources, 'app.asar/package.json'),
    path.join(output, 'windows-native-smoke.json')
  );
  const artifacts = [];
  for (const suffix of ['-setup.exe', '-portable.exe']) {
    const name = fs
      .readdirSync(output)
      .find(
        (name) => name.startsWith('Qortal-Hub-test-') && name.endsWith(suffix)
      );
    if (!name) throw new Error(`Missing artifact ${suffix}`);
    const file = path.join(output, name);
    assertWindowsInstaller(file);
    if (options.signing === 'signed')
      run('osslsigncode', [
        'verify',
        '-CAfile',
        '/etc/ssl/certs/ca-certificates.crt',
        '-in',
        file,
      ]);
    artifacts.push({
      file: name,
      size: fs.statSync(file).size,
      sha256: await hash(file),
    });
  }
  const receipt = {
    variant: 'desktop',
    method: 'docker-wine-cross',
    platform: 'win32',
    arch: 'x64',
    signing: options.signing,
    source,
    builtAt: new Date().toISOString(),
    publish: false,
    hub: requireBuild('./package.json').version,
    node: process.versions.node,
    go: run('go', ['version'], root, true),
    wine: wineVersion,
    python: py,
    reticulumCommit,
    nativeSmoke: native,
    artifacts,
  };
  fs.writeFileSync(
    path.join(output, 'desktop-build.json'),
    JSON.stringify(receipt, null, 2) + '\n'
  );
  console.log('Windows Docker/Wine test release verified.');
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await buildWindowsCross();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
