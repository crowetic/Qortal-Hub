import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const go = process.env.QORTAL_GO_BINARY || 'go';
const version = spawnSync(go, ['version'], { encoding: 'utf8' });
const goMinor = Number(version.stdout?.match(/go1\.(\d+)/)?.[1] || 0);

// Uses the real compiler and Git ownership checks, with no Docker or downloads.
// A Go installation is optional for the renderer-only test environment.
describe.skipIf(version.status !== 0 || goMinor < 20)(
  'private transport build with inaccessible Git metadata',
  () => {
    let scratch: string;
    let moduleRoot: string;
    let script: string;
    let env: NodeJS.ProcessEnv;
    beforeEach(() => {
      scratch = mkdtempSync(path.join(tmpdir(), 'hub-sidecar-build-'));
      const root = path.join(scratch, 'checkout with spaces');
      moduleRoot = path.join(root, 'electron/native/private-transport');
      script = path.join(root, 'electron/scripts/build-private-transport.mjs');
      mkdirSync(path.dirname(script), { recursive: true });
      mkdirSync(path.join(moduleRoot, 'cmd/qortal-private-transport'), {
        recursive: true,
      });
      copyFileSync(
        path.join(sourceRoot, 'electron/scripts/build-private-transport.mjs'),
        script
      );
      writeFileSync(
        path.join(moduleRoot, 'go.mod'),
        'module example.org/sidecar-fixture\n\ngo 1.20\n'
      );
      writeFileSync(
        path.join(moduleRoot, 'cmd/qortal-private-transport/main.go'),
        'package main\nfunc main() {}\n'
      );
      execFileSync('git', ['init', '-q', root]);
      env = {
        ...process.env,
        QORTAL_GO_BINARY: go,
        QORTAL_PRIVATE_TRANSPORT_GOOS: 'linux',
        QORTAL_PRIVATE_TRANSPORT_GOARCH: 'amd64',
        CGO_ENABLED: '0',
        GOTOOLCHAIN: 'local',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
        // Git's test hook simulates the container/host ownership mismatch.
        // No actual ownership or user Git configuration is changed.
        GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
      };
    });
    afterEach(() => rmSync(scratch, { recursive: true, force: true }));

    it('builds successfully when Go auto stamping reproduces the reported failure', () => {
      const baseline = spawnSync(
        go,
        [
          'build',
          '-o',
          path.join(scratch, 'baseline'),
          './cmd/qortal-private-transport',
        ],
        { cwd: moduleRoot, env, encoding: 'utf8', timeout: 30_000 }
      );
      expect(baseline.status).not.toBe(0);
      expect(baseline.stderr).toContain(
        'error obtaining VCS status: exit status 128'
      );

      const result = spawnSync(process.execPath, [script], {
        env,
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(result.status, result.stderr).toBe(0);
      const binary = path.resolve(
        moduleRoot,
        '../../resources/private-transport/linux-x64/qortal-private-transport'
      );
      const metadata = execFileSync(go, ['version', '-m', binary], {
        env,
        encoding: 'utf8',
      });
      expect(metadata).toContain('example.org/sidecar-fixture');
      expect(metadata).not.toContain('vcs.revision=');
      expect(metadata).toContain('CGO_ENABLED=0');
    }, 120_000);

    it('still propagates real compiler failures', () => {
      writeFileSync(
        path.join(moduleRoot, 'cmd/qortal-private-transport/main.go'),
        'package main\nfunc main( {\n'
      );
      const result = spawnSync(process.execPath, [script], {
        env,
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('syntax error');
    }, 120_000);
  }
);
