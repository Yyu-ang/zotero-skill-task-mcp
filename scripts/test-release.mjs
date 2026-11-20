/** Release behavior tests: beta isolation, exact commit targeting and manifest consistency. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPublishBranch, shouldPublish, releaseArguments, releaseInfo, updateManifest } from './release-config.mjs';

const targetSha = '0123456789abcdef0123456789abcdef01234567';
const assets = ['/build/dist/plugin-0.7.0-beta.3.xpi', '/build/dist/update.json'];

test('beta release targets the validated commit and cannot become latest', () => {
  const args = releaseArguments({ version: '0.7.0-beta.3', targetSha, assets });
  assert.deepEqual(args, [
    'release', 'create', 'v0.7.0-beta.3', ...assets,
    '--target', targetSha, '--title', 'v0.7.0-beta.3', '--prerelease', '--latest=false', '--generate-notes',
  ]);
});

test('stable release keeps normal release behavior and still uses an exact commit', () => {
  const args = releaseArguments({ version: '0.7.0', targetSha, assets });
  assert.equal(args.includes('--prerelease'), false);
  assert.equal(args.includes('--latest=false'), false);
  assert.equal(args[args.indexOf('--target') + 1], targetSha);
});

test('non-main branches cannot publish a stable version', () => {
  assert.equal(assertPublishBranch('0.7.0-beta.3', 'beta/builtin-note-completion').prerelease, true);
  assert.equal(assertPublishBranch('0.7.0', 'main').prerelease, false);
  assert.throws(() => assertPublishBranch('0.7.0', 'beta/builtin-note-completion'), /Only main/);
  assert.throws(() => assertPublishBranch('0.7.0', 'feature/new-work'), /Only main/);
  assert.throws(() => assertPublishBranch('0.7.0-beta.3', ''), /source branch/);
});

test('release targets reject moving refs and abbreviated commits', () => {
  for (const invalid of ['main', 'beta/builtin-note-completion', targetSha.slice(0, 8), '--help']) {
    assert.throws(() => releaseArguments({ version: '0.7.0-beta.3', targetSha: invalid, assets }), /exact/);
  }
});

test('release version validation rejects ambiguous versions before constructing commands', () => {
  assert.deepEqual(releaseInfo('0.7.0-beta.30'), { version: '0.7.0-beta.30', tag: 'v0.7.0-beta.30', prerelease: true });
  for (const version of ['', 'v0.7.0', '0.7', '0.7.0-beta.01', '0.7.0-', '0.7.0;echo bad', '0.7.0+build']) {
    assert.throws(() => releaseInfo(version));
  }
});

test('notes are passed as a separate file argument, including paths with spaces', () => {
  const notesFile = '/build/docs/releases/beta release.md';
  const args = releaseArguments({ version: '0.7.0-beta.3', targetSha, assets, notesFile });
  assert.equal(args[args.indexOf('--notes-file') + 1], notesFile);
  assert.equal(args.includes('--generate-notes'), false);
});

test('beta update manifest refers to the same beta version and release asset', () => {
  const doc = updateManifest({
    version: '0.7.0-beta.3', name: 'zotero-skill-task-mcp', pluginID: 'plugin@example.com',
    zotero: { strict_min_version: '9.0', strict_max_version: '10.*' }, sha256: 'a'.repeat(64),
  });
  const [update] = doc.addons['plugin@example.com'].updates;
  assert.equal(update.version, '0.7.0-beta.3');
  assert.equal(update.update_link, 'https://github.com/Yyu-ang/zotero-skill-task-mcp/releases/download/v0.7.0-beta.3/zotero-skill-task-mcp-0.7.0-beta.3.xpi');
  assert.equal(update.update_link.includes('/latest/'), false);
  assert.equal(update.update_hash, `sha256:${'a'.repeat(64)}`);
  assert.deepEqual(update.applications.zotero, { strict_min_version: '9.0', strict_max_version: '10.*' });
});


test('prereleases cannot publish from a push or an unconfirmed manual run', () => {
  assert.equal(shouldPublish('0.7.0-beta.3', 'push', false), false);
  assert.equal(shouldPublish('0.7.0-beta.3', 'push', true), false);
  assert.equal(shouldPublish('0.7.0-beta.3', 'workflow_dispatch', false), false);
  assert.equal(shouldPublish('0.7.0-beta.3', 'workflow_dispatch', true), true);
  assert.equal(shouldPublish('0.7.0', 'push', false), true);
});

test('withdrawn beta releases cannot be recreated by any publication path', () => {
  for (const version of ['0.7.0-beta.1', '0.7.0-beta.2']) {
    assert.throws(() => shouldPublish(version, 'workflow_dispatch', true), /Withdrawn/);
    assert.throws(() => assertPublishBranch(version, 'main'), /Withdrawn/);
    assert.throws(() => releaseArguments({ version, targetSha, assets }), /Withdrawn/);
  }
});
