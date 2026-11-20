/** Shared release decisions; publishing must keep prereleases off the stable feed. */
const WITHDRAWN_VERSIONS = new Set(['0.7.0-beta.1', '0.7.0-beta.2']);

function assertNotWithdrawn(version) {
  if (WITHDRAWN_VERSIONS.has(version)) throw new Error(`Withdrawn prerelease must not be republished: ${version}`);
}

export function shouldPublish(version, eventName, explicitPrerelease = false) {
  assertNotWithdrawn(version);
  const info = releaseInfo(version);
  return !info.prerelease || (eventName === 'workflow_dispatch' && explicitPrerelease === true);
}

export function releaseInfo(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(version)) {
    throw new Error('Release version must be major.minor.patch with an optional prerelease suffix');
  }
  const prerelease = version.includes('-') ? version.slice(version.indexOf('-') + 1) : '';
  if (prerelease.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) {
    throw new Error('Numeric prerelease identifiers cannot have leading zeros');
  }
  return { version, tag: `v${version}`, prerelease: Boolean(prerelease) };
}

export function assertPublishBranch(version, branch) {
  assertNotWithdrawn(version);
  const info = releaseInfo(version);
  if (typeof branch !== 'string' || !branch.trim()) {
    throw new Error('Publishing requires an identified source branch');
  }
  if (branch !== 'main' && !info.prerelease) {
    throw new Error('Only main can publish a stable version; other branches require a prerelease version');
  }
  return info;
}

export function releaseArguments({ version, targetSha, assets, notesFile }) {
  assertNotWithdrawn(version);
  const info = releaseInfo(version);
  if (typeof targetSha !== 'string' || !/^[a-f0-9]{40}$/i.test(targetSha)) {
    throw new Error('Release target must be an exact 40-character commit SHA');
  }
  if (!Array.isArray(assets) || assets.length === 0 || assets.some(path => typeof path !== 'string' || !path || path.startsWith('-'))) {
    throw new Error('Release assets must be explicit file paths');
  }
  const args = ['release', 'create', info.tag, ...assets, '--target', targetSha, '--title', info.tag];
  if (info.prerelease) args.push('--prerelease', '--latest=false');
  if (notesFile) args.push('--notes-file', notesFile);
  else args.push('--generate-notes');
  return args;
}

export function updateManifest({ version, name, pluginID, zotero, sha256 }) {
  const info = releaseInfo(version);
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('Invalid XPI SHA-256');
  return {
    addons: {
      [pluginID]: {
        updates: [{
          version: info.version,
          update_link: `https://github.com/Yyu-ang/zotero-skill-task-mcp/releases/download/${info.tag}/${name}-${info.version}.xpi`,
          update_hash: `sha256:${sha256}`,
          applications: {
            zotero: {
              strict_min_version: zotero.strict_min_version,
              strict_max_version: zotero.strict_max_version,
            },
          },
        }],
      },
    },
  };
}
