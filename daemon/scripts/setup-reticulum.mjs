import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venv = path.join(root, '.venv');
const python = path.join(
  venv,
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!existsSync(python))
  run(process.env.PYTHON || 'python3', ['-m', 'venv', venv]);
// Same Qortal Reticulum fork as the desktop runtime, pinned for reproducibility.
const rns =
  process.env.QORTAL_RETICULUM_PIP_PACKAGE ||
  'git+https://github.com/Philreact/Reticulum.git@f03a687b70294058beddce6ddc7a7eab50c3d462';
run(python, ['-m', 'pip', 'install', rns, 'lxmf==0.9.4', 'websockets==14.2']);
run(python, [
  '-c',
  'import RNS, LXMF, websockets; print("Reticulum runtime ready")',
]);
