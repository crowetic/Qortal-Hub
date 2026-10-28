import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const sha = 'a'.repeat(40);

// Execute the real controller against a fake GitHub CLI. No remote dispatch,
// credentials, native Mac execution or Docker engine is used by these tests.
describe('Docker controller for native Mac CI', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mac-controller-'));
    const file = path.join(scratch, 'gh');
    fs.writeFileSync(
      file,
      `#!${process.execPath}
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const args=process.argv.slice(2), base=process.env.FIXTURE_ROOT;
fs.appendFileSync(path.join(base,'calls'),JSON.stringify(args)+'\\n');
if(args[0]==='api') {
 if(args[1].includes('git/ref/')) console.log(process.env.FIXTURE_WRONG_COMMIT?'b'.repeat(40):'a'.repeat(40));
 else if(args[1].includes('/contents/')) {if(process.env.FIXTURE_UNREGISTERED)process.exit(1);console.log(JSON.stringify({content:Buffer.from('request_id:').toString('base64')}))}
 else console.log('main');
} else if(args[0]==='workflow') fs.writeFileSync(path.join(base,'request'),args.find(a=>a.startsWith('request_id=')).split('=')[1]);
else if(args[1]==='list') console.log(JSON.stringify([{databaseId:12,headSha:'a'.repeat(40),displayTitle:'unrelated build',url:'https://example.invalid/12'},{databaseId:34,headSha:'a'.repeat(40),displayTitle:fs.readFileSync(path.join(base,'request'),'utf8'),url:'https://example.invalid/34'}]));
else if(args[1]==='watch') {if(args[2]!=='34'||process.env.FIXTURE_FAILED_RUN)process.exit(1)}
else if(args[1]==='download') {
 const dir=args[args.indexOf('--dir')+1]; fs.mkdirSync(dir,{recursive:true});
 const artifacts=['app.dmg','app.zip'].map(file=>{fs.writeFileSync(path.join(dir,file),file==='app.zip'&&process.env.FIXTURE_CORRUPT?'FAIL':'data');return{file,size:4,sha256:crypto.createHash('sha256').update('data').digest('hex')}});
 fs.writeFileSync(path.join(dir,'desktop-build.json'),JSON.stringify({variant:'desktop',method:'native-test-release',platform:'darwin',arch:'arm64',signing:'unsigned',source:{commit:'a'.repeat(40),dirty:false},artifacts}));
}`
    );
    fs.chmodSync(file, 0o755);
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const run = (extra: any = {}) =>
    spawnSync(
      process.execPath,
      [path.join(root, 'electron/scripts/mac-ci-controller.mjs')],
      {
        env: {
          ...process.env,
          PATH: `${scratch}:${process.env.PATH}`,
          HOME: path.join(scratch, 'home'),
          GH_TOKEN: 'fixture-token',
          QORTAL_MAC_ARCH: 'arm64',
          QORTAL_EXPECTED_COMMIT: sha,
          QORTAL_MAC_OUTPUT: path.join(scratch, 'output'),
          FIXTURE_ROOT: scratch,
          ...extra,
        },
        encoding: 'utf8',
        timeout: 20_000,
      }
    );

  it('correlates the exact dispatch and validates downloaded content before success', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(scratch, 'output/controller-run.json'), 'utf8')
    );
    expect(receipt).toMatchObject({
      run: 34,
      commit: sha,
      arch: 'arm64',
      method: 'docker-controller-native-mac-ci',
    });
    expect(fs.readFileSync(path.join(scratch, 'calls'), 'utf8')).not.toContain(
      'fixture-token'
    );
  });
  it('rejects an unexpected remote main before dispatching', () => {
    const result = run({ FIXTURE_WRONG_COMMIT: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Push this clean desktop main commit');
    expect(fs.existsSync(path.join(scratch, 'request'))).toBe(false);
  });
  it('explains workflow registration rather than changing repository settings', () => {
    const result = run({ FIXTURE_UNREGISTERED: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('repository default branch');
    expect(fs.existsSync(path.join(scratch, 'request'))).toBe(false);
  });
  it('propagates a failed native build without downloading artifacts', () => {
    const result = run({ FIXTURE_FAILED_RUN: '1' });
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(scratch, 'calls'), 'utf8')).not.toContain(
      'download'
    );
  });
  it('rejects corrupted downloads and withholds the controller completion marker', () => {
    const result = run({ FIXTURE_CORRUPT: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SHA256');
    expect(
      fs.existsSync(path.join(scratch, 'output/controller-run.json'))
    ).toBe(false);
  });
});
