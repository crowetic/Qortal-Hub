#!/usr/bin/env node
// Regular desktop test builds. No credentials are accepted as CLI arguments.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export const help = `Usage: npm run build:test-release -- [options]
  --platform mac|win       Default: current OS (Linux: ./build-appimage.sh)
  --arch x64|arm64         Default: current Node architecture; must match host
  --signing unsigned|signed|notarized  Default: unsigned; notarized is macOS only
  --dry-run                Print the build configuration without building

Windows x64 and macOS x64/arm64 require native matching hosts, Git, Node 22.12+,
Python 3.9+, Go 1.26+, and native C++ build tools. See docs/test-releases.md.
Artifacts stay local; publishing and the production updater feed are disabled.`;

export function parseOptions(args, host = process) {
  const options = {
    platform:
      host.platform === 'darwin'
        ? 'mac'
        : host.platform === 'win32'
          ? 'win'
          : 'linux',
    arch: host.arch,
    signing: 'unsigned',
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--dry-run') options.dryRun = true;
    else if (['--platform', '--arch', '--signing'].includes(arg)) {
      options[arg.slice(2)] = args[++i];
    } else throw new Error(`Unknown option: ${arg}. Use --help.`);
  }
  if (!['mac', 'win'].includes(options.platform)) {
    throw new Error(
      'Use --platform mac or win. For Linux use ./build-appimage.sh (Docker).'
    );
  }
  if (
    !['x64', 'arm64'].includes(options.arch) ||
    (options.platform === 'win' && options.arch !== 'x64')
  ) {
    throw new Error(
      'Supported targets: Windows x64, macOS x64, macOS arm64. Build each on a matching native host.'
    );
  }
  if (
    !['unsigned', 'signed', 'notarized'].includes(options.signing) ||
    (options.platform === 'win' && options.signing === 'notarized')
  ) {
    throw new Error(
      'Use unsigned or signed; notarized is available only for macOS.'
    );
  }
  return options;
}

// Restrict extraResources to this run's native payloads, even in reused checkouts.
export function builderConfig(
  options,
  nativeDir,
  outputDir,
  identity,
  certificateSha1
) {
  const mac = options.platform === 'mac';
  const os = mac ? 'darwin' : 'windows';
  const signed = options.signing !== 'unsigned';
  const reticulum = mac ? `reticulum/darwin-${options.arch}` : 'reticulum';
  const exe = mac ? '' : '.exe';
  const stem = `Qortal-Hub-test-\${version}-${options.platform}-${options.arch}-${options.signing}`;
  // Copy platform defaults and replace their broad resource list explicitly.
  const base = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        `electron/electron-builder.config.${options.platform}.json`
      ),
      'utf8'
    )
  );
  const config = {
    ...base,
    extends: null,
    directories: { ...base.directories, output: outputDir },
    artifactName: `${stem}.\${ext}`,
    publish: null,
    forceCodeSigning: signed,
    afterSign: null,
    extraResources: [
      ...[
        'presence_bridge.py',
        'masque_discovery_codec.py',
        'qortal_python_diagnostics.py',
        'sitecustomize.py',
        'qortalland_games.py',
        'qortalland_proximity.py',
        'mesh-network.identity',
        'mesh-network.passphrase',
      ].map((name) => ({ from: `resources/${name}`, to: `reticulum/${name}` })),
      {
        from: nativeDir,
        to: reticulum,
        filter: [`rnsd${exe}`, `presence_bridge${exe}`, 'BUNDLE_READY'],
      },
      {
        from: `resources/private-transport/${os}-${options.arch}`,
        to: `private-transport/${os}-${options.arch}`,
        filter: [`qortal-private-transport${exe}`],
      },
    ],
  };
  if (mac) {
    config.mac = {
      ...base.mac,
      target: ['dmg', 'zip'],
      // Apple Silicon needs ad-hoc signatures even without a developer certificate.
      identity: signed
        ? identity?.replace(/^Developer ID Application: /, '')
        : options.arch === 'arm64'
          ? '-'
          : null,
      notarize: options.signing === 'notarized',
      binaries: [
        `Contents/Resources/${reticulum}/rnsd`,
        `Contents/Resources/${reticulum}/presence_bridge`,
        `Contents/Resources/private-transport/${os}-${options.arch}/qortal-private-transport`,
      ],
    };
    config.dmg = { ...base.dmg, sign: signed, artifactName: `${stem}.\${ext}` };
  } else {
    config.win = {
      ...base.win,
      target: ['nsis', 'portable'],
      signExecutable: signed,
      signExts: ['.exe', '.dll', '.node'],
      signtoolOptions: {
        signingHashAlgorithms: ['sha256'],
        ...(certificateSha1 ? { certificateSha1 } : {}),
      },
    };
    config.nsis = {
      ...base.nsis,
      artifactName: `${stem}-setup.\${ext}`,
      runAfterFinish: false,
      deleteAppDataOnUninstall: false,
    };
    config.portable = { artifactName: `${stem}-portable.\${ext}` };
  }
  return config;
}

export function buildEnvironment(options, original) {
  const env = { ...original };
  // Unsigned means unsigned even on a developer machine with signing secrets.
  for (const key of Object.keys(env)) {
    if (
      /^(CSC_|WIN_CSC_|APPLE|MAC_CODESIGN$|QORTAL_RETICULUM_(BUILD_ARCH|OUTPUT_DIR|CODESIGN_IDENTITY)|QORTAL_PYTHON_BINARY)/i.test(
        key
      )
    )
      delete env[key];
  }
  env.CSC_IDENTITY_AUTO_DISCOVERY =
    options.signing === 'unsigned' ? 'false' : 'true';
  env.QORTAL_PRIVATE_TRANSPORT_GOOS =
    options.platform === 'mac' ? 'darwin' : 'windows';
  env.QORTAL_PRIVATE_TRANSPORT_GOARCH =
    options.arch === 'x64' ? 'amd64' : 'arm64';
  if (options.signing !== 'unsigned') {
    if (options.platform === 'mac') {
      const identity = original.QORTAL_MAC_SIGN_IDENTITY;
      if (!identity?.startsWith('Developer ID Application: '))
        throw new Error(
          'Set QORTAL_MAC_SIGN_IDENTITY to an installed Developer ID Application certificate name (including its prefix).'
        );
      env.QORTAL_RETICULUM_CODESIGN_IDENTITY = identity;
      if (options.signing === 'notarized') {
        for (const key of [
          'APPLE_ID',
          'APPLE_APP_SPECIFIC_PASSWORD',
          'APPLE_TEAM_ID',
        ]) {
          if (!original[key])
            throw new Error(`Notarized mode requires ${key}.`);
          env[key] = original[key];
        }
      }
    } else {
      if (original.QORTAL_WIN_CERT_SHA1) {
        if (!/^[a-f\d]{40}$/i.test(original.QORTAL_WIN_CERT_SHA1))
          throw new Error(
            'QORTAL_WIN_CERT_SHA1 must be a 40-character certificate thumbprint.'
          );
        if (original.WIN_CSC_LINK)
          throw new Error(
            'Choose QORTAL_WIN_CERT_SHA1 or WIN_CSC_LINK, not both.'
          );
      } else {
        if (!original.WIN_CSC_LINK)
          throw new Error(
            'Signed Windows builds require WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD, or QORTAL_WIN_CERT_SHA1 for a certificate in the Windows store.'
          );
        if (original.WIN_CSC_KEY_PASSWORD === undefined)
          throw new Error(
            'Set WIN_CSC_KEY_PASSWORD; use an empty value only for a certificate with no password.'
          );
        env.WIN_CSC_LINK = original.WIN_CSC_LINK;
        env.WIN_CSC_KEY_PASSWORD = original.WIN_CSC_KEY_PASSWORD;
      }
    }
  }
  return env;
}

function run(
  command,
  args,
  { cwd = root, env = process.env, capture = false } = {}
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    // Do not echo args/env: signing tools may receive credentials internally.
    throw new Error(
      `${path.basename(command)} failed (${result.status ?? result.error?.code ?? 'signal'}).${capture ? ` ${result.stderr || ''}` : ''}`
    );
  }
  return result.stdout?.trim() || '';
}

function npmCli(original, command) {
  const found = command(
    process.platform === 'win32' ? 'where.exe' : 'which',
    ['npm'],
    { capture: true }
  ).split(/\r?\n/)[0];
  const candidates = [
    original.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      'node_modules/npm/bin/npm-cli.js'
    ),
    path.resolve(
      path.dirname(process.execPath),
      '../lib/node_modules/npm/bin/npm-cli.js'
    ),
    path.join(path.dirname(found), 'node_modules/npm/bin/npm-cli.js'),
    fs.realpathSync(found),
  ];
  const cli = candidates.find(
    (file) => file?.endsWith('npm-cli.js') && fs.existsSync(file)
  );
  if (!cli)
    throw new Error(
      'Cannot locate npm-cli.js. Run this script through npm run build:test-release.'
    );
  return cli;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function buildTestRelease(
  options,
  {
    repoRoot = root,
    host = process,
    originalEnv = process.env,
    command = run,
    npmPath,
  } = {}
) {
  const mac = options.platform === 'mac';
  const platform = mac ? 'darwin' : 'win32';
  if (host.platform !== platform || host.arch !== options.arch) {
    throw new Error(
      `Target ${options.platform}-${options.arch} requires matching native Node, Python and build tools. Current host: ${host.platform}-${host.arch}. Use --dry-run to inspect from another OS.`
    );
  }
  const [major, minor] = host.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12))
    throw new Error('Node 22.12+ is required.');
  const env = buildEnvironment(options, originalEnv);
  const electron = path.join(repoRoot, 'electron');
  if (fs.existsSync(path.join(electron, 'electron-builder.env')))
    throw new Error(
      'Use a checkout without electron/electron-builder.env and export the documented signing variables explicitly. The builder CLI otherwise reloads ambient signing settings.'
    );
  const call = (cmd, args, extra = {}) =>
    command(cmd, args, { cwd: repoRoot, env, ...extra });
  const git = (args) => call('git', args, { capture: true });
  const branch = git(['branch', '--show-current']);
  if (
    ['hosted-access', 'hub-daemon'].includes(branch) ||
    git(['ls-files', '--', 'src/hosted/bootstrap.ts', 'daemon/package.json'])
  ) {
    throw new Error(
      'Use the regular desktop main branch. Hosted/daemon checkouts cannot produce desktop test releases.'
    );
  }
  const source = {
    branch: branch || 'detached',
    commit: git(['rev-parse', 'HEAD']),
    dirty: Boolean(git(['status', '--porcelain'])),
  };
  const go = originalEnv.QORTAL_GO_BINARY || 'go';
  const goVersion = call(go, ['version'], { capture: true });
  if (
    !/go1\.(\d+)/.test(goVersion) ||
    Number(goVersion.match(/go1\.(\d+)/)[1]) < 26
  )
    throw new Error('Install Go 1.26+ for the desktop private transport.');
  let python;
  for (const candidate of originalEnv.QORTAL_PYTHON_BINARY
    ? [[originalEnv.QORTAL_PYTHON_BINARY]]
    : mac
      ? [['python3'], ['python']]
      : [['py', '-3'], ['python3'], ['python']]) {
    try {
      const probe = JSON.parse(
        call(
          candidate[0],
          [
            ...candidate.slice(1),
            '-c',
            'import sys, platform, json; print(json.dumps({"executable":sys.executable,"version":list(sys.version_info[:3]),"arch":platform.machine()}))',
          ],
          { capture: true }
        )
      );
      const arch = {
        x86_64: 'x64',
        AMD64: 'x64',
        arm64: 'arm64',
        aarch64: 'arm64',
      }[probe.arch];
      if (
        arch === options.arch &&
        probe.version[0] === 3 &&
        probe.version[1] >= 9
      ) {
        python = probe;
        break;
      }
    } catch {
      /* Try the next interpreter; never freeze a foreign architecture. */
    }
  }
  if (!python)
    throw new Error(
      'Python 3.9+ matching the target architecture is required. Optionally set QORTAL_PYTHON_BINARY to its executable.'
    );
  env.QORTAL_PYTHON_BINARY = python.executable;
  env.npm_config_python = python.executable;
  env.PYTHON = python.executable;
  if (mac) {
    call('xcode-select', ['-p'], { capture: true });
    if (options.signing !== 'unsigned') {
      const identities = call(
        'security',
        ['find-identity', '-v', '-p', 'codesigning'],
        { capture: true }
      );
      if (!identities.includes(`"${originalEnv.QORTAL_MAC_SIGN_IDENTITY}"`))
        throw new Error(
          'The requested Developer ID Application identity is not available in the keychain. Import its certificate and private key before building.'
        );
    }
    if (options.signing === 'notarized')
      call('xcrun', ['--find', 'notarytool'], { capture: true });
  } else if (options.signing === 'signed' && originalEnv.QORTAL_WIN_CERT_SHA1) {
    call(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$c=Get-ChildItem -Recurse Cert: -CodeSigningCert | Where-Object { $_.Thumbprint -eq $env:QORTAL_WIN_CERT_SHA1 -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) }; if (-not $c) { throw 'Requested code-signing certificate and private key are unavailable or expired' }",
      ],
      { capture: true }
    );
  }
  const npm = npmPath || npmCli(originalEnv, call);
  const npmRun = (args, cwd) => call(process.execPath, [npm, ...args], { cwd });
  const buildId = `${options.platform}-${options.arch}-${options.signing}`;
  const outputParent = path.join(electron, 'dist/test-releases', buildId);
  fs.mkdirSync(outputParent, { recursive: true });
  // A unique directory preserves earlier builds and cannot yield a stale success receipt.
  const output = fs.mkdtempSync(
    path.join(outputParent, `${source.commit.slice(0, 8)}-`)
  );
  const nativeParent = path.join(electron, '.build/test-releases');
  fs.mkdirSync(nativeParent, { recursive: true });
  const nativeDir = fs.mkdtempSync(path.join(nativeParent, 'native-'));
  env.QORTAL_RETICULUM_OUTPUT_DIR = nativeDir;
  npmRun(['ci'], repoRoot);
  npmRun(['ci'], electron);
  npmRun(['exec', '--no', '--', 'install-electron'], electron);
  fs.rmSync(path.join(electron, 'build'), { recursive: true, force: true });
  fs.rmSync(path.join(electron, 'app'), { recursive: true, force: true });
  npmRun(['run', 'build'], repoRoot);
  npmRun(
    ['exec', '--no', '--', 'cap', 'sync', '@capacitor-community/electron'],
    repoRoot
  );
  if (fs.existsSync(path.join(electron, 'app/hub-config.json')))
    throw new Error(
      'Hosted runtime configuration leaked into the desktop app.'
    );
  npmRun(['run', 'build'], electron);
  npmRun(['run', 'build:private-transport'], electron);
  npmRun(['run', 'bundle:reticulum'], electron);
  const extension = mac ? '' : '.exe';
  const sidecar = path.join(
    electron,
    'resources/private-transport',
    `${mac ? 'darwin' : 'windows'}-${options.arch}`,
    `qortal-private-transport${extension}`
  );
  const payloads = [
    path.join(nativeDir, `rnsd${extension}`),
    path.join(nativeDir, `presence_bridge${extension}`),
    sidecar,
  ];
  for (const file of payloads) {
    if (!fs.statSync(file).size)
      throw new Error(`Empty native payload: ${file}`);
    if (mac)
      call('lipo', [
        '-verify_arch',
        options.arch === 'x64' ? 'x86_64' : 'arm64',
        file,
      ]);
    else {
      const bytes = fs.readFileSync(file);
      const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length;
      if (
        bytes.toString('ascii', 0, 2) !== 'MZ' ||
        pe + 6 > bytes.length ||
        bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' ||
        bytes.readUInt16LE(pe + 4) !== 0x8664
      )
        throw new Error(`Expected a Windows x64 PE native payload: ${file}`);
    }
  }
  // Electron, rather than host Node, must be able to load the rebuilt SQLite addon.
  call(
    path.join(
      electron,
      `node_modules/electron/dist/${mac ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe'}`
    ),
    [
      '-e',
      "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.prepare('select 1').get(); db.close();",
    ],
    { cwd: electron, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  );
  const config = builderConfig(
    options,
    nativeDir,
    output,
    originalEnv.QORTAL_MAC_SIGN_IDENTITY,
    options.signing === 'signed' ? originalEnv.QORTAL_WIN_CERT_SHA1 : undefined
  );
  const configFile = path.join(output, 'test-builder.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  call(
    process.execPath,
    [
      path.join(electron, 'node_modules/electron-builder/cli.js'),
      'build',
      '--config',
      configFile,
      mac ? '--mac' : '--win',
      `--${options.arch}`,
      '--publish=never',
    ],
    { cwd: electron }
  );
  const appDir = path.join(
    output,
    mac ? (options.arch === 'x64' ? 'mac' : 'mac-arm64') : 'win-unpacked',
    ...(mac ? ['Qortal Hub.app'] : [])
  );
  const resources = path.join(appDir, mac ? 'Contents/Resources' : 'resources');
  const packagedReticulum = path.join(
    resources,
    mac ? `reticulum/darwin-${options.arch}` : 'reticulum'
  );
  for (const file of [
    path.join(packagedReticulum, `rnsd${extension}`),
    path.join(packagedReticulum, `presence_bridge${extension}`),
    path.join(
      resources,
      'private-transport',
      `${mac ? 'darwin' : 'windows'}-${options.arch}`,
      `qortal-private-transport${extension}`
    ),
    path.join(resources, 'reticulum/masque_discovery_codec.py'),
  ]) {
    if (!fs.statSync(file).size)
      throw new Error(`Missing packaged runtime payload: ${file}`);
  }
  if (fs.existsSync(path.join(resources, 'app-update.yml')))
    throw new Error('Test builds must not contain a production update feed.');
  const expected = mac ? ['.dmg', '.zip'] : ['-setup.exe', '-portable.exe'];
  const names = fs.readdirSync(output);
  const artifacts = [];
  for (const suffix of expected) {
    const name = names.find(
      (name) => name.startsWith('Qortal-Hub-test-') && name.endsWith(suffix)
    );
    if (!name || !fs.statSync(path.join(output, name)).size)
      throw new Error(`Missing test-release artifact: ${suffix}`);
    const file = path.join(output, name);
    if (!mac && options.signing === 'signed') {
      // File path travels via env, never through PowerShell source interpolation.
      call(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$s=Get-AuthenticodeSignature -LiteralPath $env:QORTAL_VERIFY_FILE; if ($s.Status -ne 'Valid') { throw 'Invalid Authenticode signature' }",
        ],
        { env: { ...env, QORTAL_VERIFY_FILE: file } }
      );
    }
    artifacts.push({
      file: name,
      size: fs.statSync(file).size,
      sha256: await sha256(file),
    });
  }
  if (mac) {
    if (options.signing !== 'unsigned' || options.arch === 'arm64')
      call('codesign', ['--verify', '--deep', '--strict', appDir]);
    if (options.signing !== 'unsigned')
      call('codesign', [
        '--verify',
        '-R',
        `anchor apple generic and certificate leaf[subject.CN] = ${JSON.stringify(originalEnv.QORTAL_MAC_SIGN_IDENTITY)}`,
        appDir,
      ]);
    if (options.signing === 'notarized') {
      call('xcrun', ['stapler', 'validate', appDir]);
      call('spctl', ['--assess', '--type', 'execute', '--verbose', appDir]);
    }
  }
  const receipt = {
    variant: 'desktop',
    method: 'native-test-release',
    platform,
    arch: options.arch,
    signing: options.signing,
    adHoc: mac && options.arch === 'arm64' && options.signing === 'unsigned',
    publish: false,
    source,
    builtAt: new Date().toISOString(),
    node: host.versions.node,
    python: python.version.join('.'),
    go: goVersion,
    artifacts,
  };
  fs.writeFileSync(
    path.join(output, 'desktop-build.json'),
    JSON.stringify(receipt, null, 2) + '\n'
  );
  console.log(`Test release complete: ${output}`);
  return { output, receipt, config };
}

if (
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log(help);
    else if (options.dryRun)
      console.log(
        JSON.stringify(
          {
            options,
            configuration: builderConfig(
              options,
              '<fresh-native-payloads>',
              '<unique-test-output>',
              options.signing === 'unsigned'
                ? undefined
                : '<installed-developer-id>'
            ),
            note: 'Inspection only. Native host, tools and credentials are checked during a real build.',
          },
          null,
          2
        )
      );
    else await buildTestRelease(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
