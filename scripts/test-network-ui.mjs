/** Exercise the actual MCP settings UI, including asynchronous save failures. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML, DOMParser } from 'linkedom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'skilltask-network-ui-'));
try {
  const { window, document } = parseHTML('<!doctype html><html><body><div id="error-box" hidden><span id="error-text"></span></div><div id="tab-mcp"></div></body></html>');
  Object.defineProperty(document, 'readyState', { value: 'loading' });
  Object.assign(globalThis, { document, window, DOMParser, Event: window.Event,
    HTMLInputElement: window.HTMLInputElement, Node: window.Node, Zotero: { locale: 'en-US' } });
  window.confirm = () => false;
  const source = readFileSync(join(root, 'src/panel.ts'), 'utf8');
  const output = join(temp, 'panel.mjs');
  await build({ stdin: {
    contents: source + '\nexport { renderMcp };\nexport function setNetworkUIAPI(value) { api = value; }',
    resolveDir: join(root, 'src'), loader: 'ts', sourcefile: 'panel.ts',
  }, bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent' });
  const { renderMcp, setNetworkUIAPI } = await import(pathToFileURL(output).href);
  const tab = document.getElementById('tab-mcp');
  const field = (id) => document.getElementById(id);
  const addressValues = () => [...tab.querySelectorAll('.url-box')].map((element) => element.textContent);
  const localURL = 'http://127.0.0.1:23123/skilltask/mcp';
  const lanURL = 'http://<LAN-IP>:23123/skilltask/mcp';
  const publicOrigin = 'https://mcp.example.com';
  async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
  function change(id, value) {
    const input = field(id); input.checked = value;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  function mount(overrides = {}) {
    const state = { enabled: true, allowRemote: false, oauthEnabled: false, oauthPublicOrigin: publicOrigin,
      networkError: null, actualMode: null, ...overrides };
    const calls = [];
    const serviceCalls = [];
    let networkSave = null;
    let serviceSave = null;
    let revocations = 0;
    function status() {
      const mode = state.actualMode || (!state.enabled ? 'stopped' : !state.allowRemote ? 'loopback' : state.oauthEnabled ? 'internet' : 'lan');
      const local = mode !== 'stopped'; const lan = mode === 'lan' || mode === 'internet'; const oauth = mode === 'internet';
      return { ...state, mode, host: '127.0.0.1', path: '/skilltask/mcp', port: local ? 23123 : null,
        url: local ? localURL : null, lanAccessible: lan, lanPort: lan ? 23123 : null, lanUrl: lan ? lanURL : null,
        oauthAccessible: oauth, oauthPort: oauth ? 23124 : null, oauthUrl: oauth ? state.oauthPublicOrigin + '/skilltask/mcp' : null };
    }
    const mcp = {
      getStatus: status,
      async setNetworkOptions(options) {
        calls.push({ ...options });
        if (networkSave) return await networkSave(options);
        Object.assign(state, options, { oauthPublicOrigin: options.oauthPublicOrigin.trim(), actualMode: null });
      },
      async setEnabled(value) {
        serviceCalls.push(value);
        if (serviceSave) return await serviceSave(value);
        state.enabled = value; state.actualMode = null;
      },
      revokeOAuthAuthorizations() { revocations++; },
      isTokenEnabled() { throw new Error('Legacy token UI must not be used'); },
      ensureToken() { throw new Error('Legacy token UI must not be used'); },
      regenerateToken() { throw new Error('Legacy token UI must not be used'); },
    };
    setNetworkUIAPI({ mcp, tasks: { list: () => [] } });
    field('error-box').hidden = true;
    field('error-text').textContent = '';
    renderMcp();
    return { state, calls, serviceCalls, status, setNetworkSave: fn => { networkSave = fn; },
      setServiceSave: fn => { serviceSave = fn; }, revocations: () => revocations };
  }

  // Saved switch positions and actual addresses are independent dimensions.
  for (const [allowRemote, oauthEnabled, label, addresses] of [
    [false, false, 'Loopback only', [localURL]],
    [false, true, 'Loopback only', [localURL]],
    [true, false, 'Local and LAN', [localURL, lanURL]],
    [true, true, 'LAN and OAuth internet access', [localURL, lanURL, publicOrigin + '/skilltask/mcp']],
  ]) {
    mount({ allowRemote, oauthEnabled });
    assert.equal(field('mcp-allow-remote').checked, allowRemote);
    assert.equal(field('mcp-oauth-enabled').checked, oauthEnabled);
    assert.equal(tab.querySelector('.badge').textContent, label);
    assert.deepEqual(addressValues(), addresses);
    assert.equal(tab.querySelectorAll('input[type="checkbox"]').length, 3, 'master, remote and OAuth switches only');
    assert.equal(tab.querySelector('[id*="token"]'), null, 'no obsolete token controls');
  }

  let f = mount();
  change('mcp-oauth-enabled', true); await settle();
  assert.deepEqual(f.calls, [{ allowRemote: false, oauthEnabled: true, oauthPublicOrigin: publicOrigin }]);
  assert.deepEqual(addressValues(), [localURL], 'OAuth alone must keep only the local address');
  change('mcp-allow-remote', true); await settle();
  assert.deepEqual(f.calls.at(-1), { allowRemote: true, oauthEnabled: true, oauthPublicOrigin: publicOrigin });
  assert.deepEqual(addressValues(), [localURL, lanURL, publicOrigin + '/skilltask/mcp']);
  change('mcp-oauth-enabled', false); await settle();
  assert.deepEqual(f.calls.at(-1), { allowRemote: true, oauthEnabled: false, oauthPublicOrigin: publicOrigin });
  assert.deepEqual(addressValues(), [localURL, lanURL]);

  // Save button and Enter both submit the current origin, including unsaved input.
  f = mount({ allowRemote: true, oauthEnabled: true });
  field('mcp-oauth-origin').value = 'https://remote.example:443';
  tab.querySelector('.network-origin-row button').click(); await settle();
  assert.deepEqual(f.calls.at(-1), { allowRemote: true, oauthEnabled: true, oauthPublicOrigin: 'https://remote.example:443' });
  assert.equal(field('mcp-oauth-origin').value, 'https://remote.example:443');
  assert.ok(addressValues().includes('https://remote.example:443/skilltask/mcp'));
  field('mcp-oauth-origin').value = 'https://other.example';
  const enter = new window.Event('keydown', { bubbles: true, cancelable: true }); enter.key = 'Enter';
  field('mcp-oauth-origin').dispatchEvent(enter); await settle();
  assert.equal(enter.defaultPrevented, true);
  assert.equal(f.calls.at(-1).oauthPublicOrigin, 'https://other.example');

  // During a pending apply, all related inputs are disabled. On failure the UI
  // must re-read actual backend values, because it can fall back to loopback.
  f = mount({ allowRemote: true, oauthEnabled: false });
  let rejectSave;
  f.setNetworkSave(() => new Promise((_, reject) => { rejectSave = reject; }));
  change('mcp-oauth-enabled', true);
  for (const id of ['mcp-service-enabled', 'mcp-allow-remote', 'mcp-oauth-enabled', 'mcp-oauth-origin']) assert.equal(field(id).disabled, true);
  assert.equal(tab.querySelector('.network-origin-row button').disabled, true);
  assert.equal(f.calls.length, 1);
  Object.assign(f.state, { allowRemote: false, oauthEnabled: true, actualMode: 'loopback', networkError: 'OAuth port occupied' });
  rejectSave(new Error('OAuth port occupied')); await settle();
  assert.equal(field('mcp-allow-remote').checked, false);
  assert.equal(field('mcp-oauth-enabled').checked, true);
  assert.equal(field('mcp-allow-remote').disabled, false);
  assert.equal(field('mcp-oauth-enabled').disabled, false);
  assert.equal(field('mcp-oauth-origin').disabled, false);
  assert.deepEqual(addressValues(), [localURL]);
  assert.equal(field('error-box').hidden, false);
  assert.match(field('error-text').textContent, /Could not apply network settings.*OAuth port occupied/);
  assert.match(tab.textContent, /OAuth port occupied/);

  // Input validation errors likewise restore the last accepted public origin.
  f = mount({ allowRemote: true, oauthEnabled: true });
  f.setNetworkSave(async () => { await Promise.resolve(); throw new Error('HTTPS origin required'); });
  field('mcp-oauth-origin').value = 'http://unsecured.example/path';
  tab.querySelector('.network-origin-row button').click(); await settle();
  assert.equal(f.calls.at(-1).oauthPublicOrigin, 'http://unsecured.example/path');
  assert.equal(field('mcp-oauth-origin').value, publicOrigin);
  assert.equal(field('error-box').hidden, false);
  assert.match(field('error-text').textContent, /HTTPS origin required/);
  assert.ok(addressValues().includes(publicOrigin + '/skilltask/mcp'));

  // Never show usable URLs when the backend reports that binding failed.
  mount({ allowRemote: true, oauthEnabled: true, actualMode: 'stopped', networkError: 'Base port occupied' });
  assert.deepEqual(addressValues(), []);
  assert.equal(tab.querySelector('.badge').textContent, 'Stopped');
  assert.match(tab.textContent, /Base port occupied/);
  mount({ enabled: false, allowRemote: true, oauthEnabled: true });
  assert.deepEqual(addressValues(), []);
  assert.equal(field('mcp-stopped-notice').hidden, false);

  // Revocation still needs the local confirmation and reports completion.
  f = mount({ allowRemote: true, oauthEnabled: true });
  const revoke = [...tab.querySelectorAll('button')].find(button => button.textContent.includes('Revoke all OAuth'));
  revoke.click(); await settle(); assert.equal(f.revocations(), 0);
  window.confirm = () => true;
  revoke.click(); await settle(); assert.equal(f.revocations(), 1);
  assert.match(tab.querySelector('[role="status"]').textContent, /Revoked/);

  // A failed master-switch action must not falsely imply the listener stopped.
  f = mount();
  f.setServiceSave(async () => { await Promise.resolve(); throw new Error('Stop failed'); });
  change('mcp-service-enabled', false); await settle();
  assert.equal(field('error-box').hidden, false);
  assert.match(field('error-text').textContent, /Stop failed/);
  assert.equal(field('mcp-service-enabled').checked, true, 'failed stop must restore the actual enabled state');

  console.log('Network UI: four modes, addresses, save/Enter, async rollback, revocation and service errors passed.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
