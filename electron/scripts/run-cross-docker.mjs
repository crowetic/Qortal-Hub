#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const usage = `Usage: ./build-cross-docker.sh win [--signing unsigned|signed] [--dry-run]
       ./build-cross-docker.sh mac --arch x64|arm64 [--dry-run]
Windows uses a Linux x64 Docker/Wine toolchain. Signed builds require a local
WIN_CSC_LINK PFX and WIN_CSC_KEY_PASSWORD; Windows certificate stores need Windows.
macOS uses the existing native Mac GitHub workflow via a Docker controller;
it is remote building, not local Linux cross-compilation. Requires GH_TOKEN.
No publishing or deployment. See docs/docker-cross-builds.md.`;

export function parseCrossOptions(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const options = {
    platform: args[0],
    signing: 'unsigned',
    arch: 'x64',
    dryRun: false,
  };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--dry-run') options.dryRun = true;
    else if (['--signing', '--arch'].includes(args[i]))
      options[args[i].slice(2)] = args[++i];
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!['win', 'mac'].includes(options.platform)) throw new Error(usage);
  if (
    !['x64', 'arm64'].includes(options.arch) ||
    (options.platform === 'win' && options.arch !== 'x64')
  )
    throw new Error('Windows supports x64; macOS supports x64 and arm64.');
  if (
    !['unsigned', 'signed'].includes(options.signing) ||
    (options.platform === 'mac' && options.signing !== 'unsigned')
  )
    throw new Error(
      'Windows supports unsigned/signed; the remote Mac workflow currently builds unsigned/ad-hoc test packages.'
    );
  return options;
}

function run(cmd, args, capture = false) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${path.basename(cmd)} failed (${result.status ?? result.error?.code}).${capture ? ` ${result.stderr || ''}` : ''}`
    );
  return result.stdout?.trim() || '';
}

export function crossDockerArguments(
  options,
  source,
  output,
  cache,
  signingFile
) {
  const args = [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--mount',
    `type=bind,source=${root},target=/source,readonly`,
    '--mount',
    `type=bind,source=${output},target=/output`,
    '--mount',
    `type=bind,source=${cache},target=/cache`,
    '-e',
    'HOME=/tmp/builder-home',
    '-e',
    'WINEPREFIX=/tmp/builder-home/wine',
    '-e',
    'npm_config_cache=/cache/npm',
    '-e',
    `QORTAL_SOURCE_COMMIT=${source.commit}`,
    '-e',
    `QORTAL_SOURCE_BRANCH=${source.branch}`,
    '-e',
    `QORTAL_SOURCE_DIRTY=${source.dirty}`,
    '-e',
    `QORTAL_CROSS_SIGNING=${options.signing}`,
  ];
  if (signingFile)
    args.push(
      '--mount',
      `type=bind,source=${signingFile},target=/signing/certificate.pfx,readonly`,
      '-e',
      'WIN_CSC_LINK=/signing/certificate.pfx',
      '-e',
      'WIN_CSC_KEY_PASSWORD'
    );
  args.push(
    'qortal-hub-windows-cross:local',
    'bash',
    '/source/electron/scripts/windows-cross-entry.sh'
  );
  return args;
}

export async function verifyCrossOutput(output, options, source) {
  const names = fs
    .readdirSync(output, { recursive: true })
    .filter((name) => path.basename(name) === 'desktop-build.json');
  if (names.length !== 1)
    throw new Error(
      'Container exited without exactly one completion receipt; keep earlier working artifacts.'
    );
  const dir = path.dirname(path.join(output, names[0]));
  const receipt = JSON.parse(
    fs.readFileSync(path.join(dir, 'desktop-build.json'), 'utf8')
  );
  if (
    receipt.variant !== 'desktop' ||
    receipt.platform !== (options.platform === 'win' ? 'win32' : 'darwin') ||
    receipt.arch !== options.arch ||
    receipt.signing !== options.signing ||
    receipt.source?.commit !== source.commit ||
    receipt.source?.dirty !== source.dirty ||
    receipt.method !==
      (options.platform === 'win'
        ? 'docker-wine-cross'
        : 'native-test-release') ||
    receipt.artifacts?.length !== 2
  )
    throw new Error(
      'Container receipt does not match the requested source/target/signing mode.'
    );
  for (const item of receipt.artifacts) {
    if (path.basename(item.file) !== item.file)
      throw new Error('Invalid artifact filename.');
    const file = path.join(dir, item.file);
    const hash = createHash('sha256');
    for await (const part of fs.createReadStream(file)) hash.update(part);
    if (
      hash.digest('hex') !== item.sha256 ||
      fs.statSync(file).size !== item.size
    )
      throw new Error(
        'Artifact content does not match the completion receipt.'
      );
  }
  return receipt;
}

export async function launchCrossBuild(options) {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error(
      'This Docker controller currently requires a Linux x64 host.'
    );
  const source = {
    branch: run('git', ['branch', '--show-current'], true) || 'detached',
    commit: run('git', ['rev-parse', 'HEAD'], true),
    dirty: Boolean(run('git', ['status', '--porcelain'], true)),
  };
  if (
    ['hosted-access', 'hub-daemon'].includes(source.branch) ||
    run(
      'git',
      ['ls-files', '--', 'src/hosted/bootstrap.ts', 'daemon/package.json'],
      true
    )
  )
    throw new Error('Use the regular desktop main checkout.');
  const engine = process.env.CONTAINER_CMD || 'docker';
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          ...options,
          source,
          method:
            options.platform === 'win'
              ? 'docker-wine-cross'
              : 'docker-controller-native-mac-ci',
          image:
            options.platform === 'win'
              ? 'qortal-hub-windows-cross:local'
              : 'qortal-hub-mac-controller:local',
          publishes: false,
          requires:
            options.platform === 'win'
              ? [
                  'Docker engine',
                  'Linux x64',
                  ...(options.signing === 'signed'
                    ? ['local PFX', 'WIN_CSC_KEY_PASSWORD']
                    : []),
                ]
              : [
                  'Docker engine',
                  'GH_TOKEN with Actions write and Contents read on crowetic/Qortal-Hub',
                  'main pushed to origin',
                ],
        },
        null,
        2
      )
    );
    return;
  }
  let signingFile;
  if (options.platform === 'win' && options.signing === 'signed') {
    if (process.env.QORTAL_WIN_CERT_SHA1)
      throw new Error(
        'Certificate-store/hardware-token signing requires the native Windows builder. Use a local PFX for this Linux path.'
      );
    signingFile = process.env.WIN_CSC_LINK;
    if (
      !signingFile ||
      !fs.statSync(signingFile, { throwIfNoEntry: false })?.isFile() ||
      process.env.WIN_CSC_KEY_PASSWORD === undefined
    )
      throw new Error(
        'Set WIN_CSC_LINK to a local PFX file and export WIN_CSC_KEY_PASSWORD before signed builds.'
      );
    signingFile = fs.realpathSync(signingFile);
    if (signingFile.includes(','))
      throw new Error(
        'The signing file path cannot contain a comma (Docker mount separator).'
      );
  }
  if (options.platform === 'mac' && !process.env.GH_TOKEN)
    throw new Error(
      'macOS requires a native Mac runner. Export GH_TOKEN to use the Docker GitHub controller, or launch Desktop test releases from Actions. This is not a local Linux Mac compiler.'
    );
  if (options.platform === 'mac' && source.dirty)
    throw new Error(
      'Remote Mac builds require a clean committed checkout pushed to origin/main.'
    );
  run(engine, ['info'], true);
  const file =
    options.platform === 'win'
      ? 'windows-cross.Dockerfile'
      : 'mac-controller.Dockerfile';
  const image =
    options.platform === 'win'
      ? 'qortal-hub-windows-cross:local'
      : 'qortal-hub-mac-controller:local';
  // Empty build context: host node_modules, wallet/runtime state and credentials
  // never enter the image's build context or layers.
  run(engine, [
    'build',
    '--platform',
    'linux/amd64',
    '-t',
    image,
    '-f',
    path.join(root, 'electron/scripts', file),
    path.join(root, 'electron/scripts/docker-context'),
  ]);
  const outputParent = path.join(
    root,
    'electron/dist/test-releases',
    `${options.platform}-${options.arch}-${options.signing}`
  );
  fs.mkdirSync(outputParent, { recursive: true });
  const output = fs.mkdtempSync(
    path.join(outputParent, `${source.commit.slice(0, 8)}-docker-`)
  );
  const cache = path.join(
    process.env.XDG_CACHE_HOME || path.join(process.env.HOME, '.cache'),
    'qortal-hub-cross'
  );
  fs.mkdirSync(cache, { recursive: true });
  if ([root, output, cache].some((value) => value.includes(',')))
    throw new Error('Docker mount paths cannot contain commas.');
  if (options.platform === 'win')
    run(
      engine,
      crossDockerArguments(options, source, output, cache, signingFile)
    );
  else
    run(engine, [
      'run',
      '--rm',
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '-e',
      'GH_TOKEN',
      '-e',
      `QORTAL_MAC_ARCH=${options.arch}`,
      '-e',
      `QORTAL_EXPECTED_COMMIT=${source.commit}`,
      '--mount',
      `type=bind,source=${output},target=/output`,
      '--mount',
      `type=bind,source=${root},target=/source,readonly`,
      image,
      'node',
      '/source/electron/scripts/mac-ci-controller.mjs',
    ]);
  await verifyCrossOutput(output, options, source);
  console.log(`Completed test release: ${output}`);
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseCrossOptions(process.argv.slice(2));
    if (options.help) console.log(usage);
    else await launchCrossBuild(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
