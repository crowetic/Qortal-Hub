#!/usr/bin/env node
// Dispatch/download only. Compilation runs on the workflow's real Mac runner.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function validateMacReceipt(dir, expectedCommit, arch) {
  const receipt = JSON.parse(
    fs.readFileSync(path.join(dir, 'desktop-build.json'), 'utf8')
  );
  if (
    receipt.variant !== 'desktop' ||
    receipt.method !== 'native-test-release' ||
    receipt.platform !== 'darwin' ||
    receipt.arch !== arch ||
    receipt.source?.commit !== expectedCommit ||
    receipt.source?.dirty !== false ||
    receipt.signing !== 'unsigned' ||
    receipt.artifacts?.length !== 2
  )
    throw new Error(
      'Downloaded Mac build provenance does not match the requested clean source/architecture.'
    );
  for (const item of receipt.artifacts) {
    if (
      path.basename(item.file) !== item.file ||
      !/^[a-f\d]{64}$/.test(item.sha256)
    )
      throw new Error('Invalid artifact receipt path/hash.');
    const file = path.join(dir, item.file);
    if (fs.statSync(file).size !== item.size)
      throw new Error('Mac artifact size does not match receipt.');
  }
  return receipt;
}

export async function buildMacOnCI() {
  const output = path.resolve(process.env.QORTAL_MAC_OUTPUT || '/output');
  const repo = 'crowetic/Qortal-Hub';
  const workflow = 'desktop-test-releases.yml';
  const arch = process.env.QORTAL_MAC_ARCH;
  const expected = process.env.QORTAL_EXPECTED_COMMIT;
  if (
    !process.env.GH_TOKEN ||
    !['x64', 'arm64'].includes(arch) ||
    !/^[a-f\d]{40}$/.test(expected || '')
  )
    throw new Error(
      'Set GH_TOKEN, QORTAL_MAC_ARCH and the expected main commit.'
    );
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const gh = (args) => {
    const result = spawnSync('gh', args, { encoding: 'utf8', stdio: 'pipe' });
    if (result.error || result.status !== 0)
      throw new Error(
        `GitHub CLI failed (${result.status ?? result.error?.code}): ${result.stderr || ''}`
      );
    return result.stdout.trim();
  };
  const remote = gh([
    'api',
    `repos/${repo}/git/ref/heads/main`,
    '--jq',
    '.object.sha',
  ]);
  if (remote !== expected)
    throw new Error(
      'Push this clean desktop main commit to origin/main before dispatching the Mac build.'
    );
  // GitHub only registers workflow_dispatch from the repository default branch.
  // Never change repository defaults or write another branch implicitly.
  const defaultBranch = gh(['api', `repos/${repo}`, '--jq', '.default_branch']);
  const registrationError = `The controller-enabled workflow must be registered on the repository default branch (${defaultBranch}). Have the owner make main the default branch or explicitly synchronize this workflow to the chosen default branch.`;
  let registered;
  try {
    registered = JSON.parse(
      gh([
        'api',
        `repos/${repo}/contents/.github/workflows/${workflow}?ref=${encodeURIComponent(defaultBranch)}`,
      ])
    );
  } catch {
    throw new Error(registrationError);
  }
  if (
    !registered.content ||
    !Buffer.from(registered.content, 'base64')
      .toString('utf8')
      .includes('request_id:')
  )
    throw new Error(registrationError);
  const request = randomUUID();
  gh([
    'workflow',
    'run',
    workflow,
    '--repo',
    repo,
    '--ref',
    'main',
    '-f',
    `target=macos-${arch}`,
    '-f',
    `request_id=${request}`,
  ]);
  const deadline = Date.now() + 5 * 60_000;
  let run;
  while (!run && Date.now() < deadline) {
    const runs = JSON.parse(
      gh([
        'run',
        'list',
        '--repo',
        repo,
        '--workflow',
        workflow,
        '--branch',
        'main',
        '--event',
        'workflow_dispatch',
        '--limit',
        '50',
        '--json',
        'databaseId,displayTitle,headSha,url',
      ])
    );
    run = runs.find(
      (candidate) =>
        candidate.headSha === expected &&
        candidate.displayTitle.includes(request)
    );
    if (!run) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!run)
    throw new Error(
      `Mac workflow was dispatched (${request}), but its run was not found. Check Actions before retrying.`
    );
  console.log(`Native Mac build: ${run.url}`);
  const watch = spawnSync(
    'gh',
    [
      'run',
      'watch',
      String(run.databaseId),
      '--repo',
      repo,
      '--exit-status',
      '--interval',
      '10',
    ],
    { stdio: 'inherit' }
  );
  if (watch.error || watch.status !== 0)
    throw new Error(
      'Native Mac build did not succeed. Its run remains available in Actions.'
    );
  gh([
    'run',
    'download',
    String(run.databaseId),
    '--repo',
    repo,
    '--name',
    `Qortal-Hub-test-macos-${arch}-${expected}`,
    '--dir',
    output,
  ]);
  const receipts = fs
    .readdirSync(output, { recursive: true })
    .filter((name) => path.basename(name) === 'desktop-build.json');
  if (receipts.length !== 1)
    throw new Error('Expected exactly one Mac completion receipt.');
  const dir = path.dirname(path.join(output, receipts[0]));
  const receipt = validateMacReceipt(dir, expected, arch);
  for (const item of receipt.artifacts) {
    const digest = createHash('sha256');
    for await (const data of fs.createReadStream(path.join(dir, item.file)))
      digest.update(data);
    if (digest.digest('hex') !== item.sha256)
      throw new Error('Mac artifact SHA256 does not match receipt.');
  }
  fs.writeFileSync(
    path.join(output, 'controller-run.json'),
    JSON.stringify(
      {
        method: 'docker-controller-native-mac-ci',
        run: run.databaseId,
        url: run.url,
        commit: expected,
        arch,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`Verified Mac artifacts downloaded to /output (${arch}).`);
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await buildMacOnCI();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
