/**
 * Build the XPI and update manifest. --publish publishes the exact source commit;
 * prerelease versions are marked as such and never replace GitHub's latest release.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublishBranch, releaseArguments, releaseInfo, updateManifest } from './release-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'addon/manifest.json'), 'utf8'));
const info = releaseInfo(pkg.version);
const DIST_DIR = resolve(ROOT, 'dist');
const xpiPath = resolve(DIST_DIR, `${pkg.name}-${info.version}.xpi`);
const updatePath = resolve(DIST_DIR, 'update.json');
const publish = process.argv.includes('--publish');

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

async function main() {
  let publishArgs;
  if (publish) {
    const branch = process.env.GITHUB_REF_NAME || git('branch', '--show-current');
    assertPublishBranch(info.version, branch);
    const head = git('rev-parse', 'HEAD');
    const targetSha = process.env.GITHUB_SHA || head;
    if (targetSha !== head) throw new Error('GITHUB_SHA does not match the checked-out source commit');
    const notesFile = resolve(ROOT, 'docs/releases', `${info.tag}.md`);
    publishArgs = releaseArguments({
      version: info.version, targetSha, assets: [xpiPath, updatePath],
      notesFile: existsSync(notesFile) ? notesFile : undefined,
    });
  }

  console.log(`Building Skill Task ${info.tag}${info.prerelease ? ' (prerelease)' : ''}`);
  execFileSync(process.execPath, [resolve(ROOT, 'scripts/build.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (!existsSync(xpiPath)) throw new Error(`XPI not found: ${xpiPath}`);

  const sha256 = createHash('sha256').update(readFileSync(xpiPath)).digest('hex');
  const update = updateManifest({
    version: info.version, name: pkg.name, pluginID: manifest.applications.zotero.id,
    zotero: manifest.applications.zotero, sha256,
  });
  mkdirSync(DIST_DIR, { recursive: true });
  const json = JSON.stringify(update, null, 2) + '\n';
  writeFileSync(updatePath, json);
  // This ignored copy is used by local development; the installed stable update URL stays unchanged.
  writeFileSync(resolve(ROOT, 'update.json'), json);
  console.log(`Packaged ${xpiPath}`);
  console.log(`Update manifest: ${updatePath}`);

  if (publishArgs) {
    execFileSync('gh', publishArgs, { cwd: ROOT, stdio: 'inherit' });
    console.log(`Published ${info.tag}${info.prerelease ? ' as a prerelease (not latest)' : ''}`);
  }
}

main().catch(error => {
  console.error('Release failed:', error);
  process.exitCode = 1;
});
