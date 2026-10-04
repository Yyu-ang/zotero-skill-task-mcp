/**
 * src/preferences.ts — 插件设置面板逻辑
 *
 * 由 Zotero.PreferencePanes.register 以 chrome 特权加载到设置窗口，
 * 打包为 addon/content/preferences.js。
 *
 * 内容：MCP 服务开关/地址/凭据重置、任务默认（租约时长/文件上限）、
 * 快捷键说明。所有设置走 Zotero.Prefs（extensions.zotero-skill-task.*），
 * 修改实时生效；凭据绝不写入日志。
 */

const PREF_MCP_ENABLED = 'extensions.zotero-skill-task.mcp.enabled';
const PREF_LEASE_MINUTES = 'extensions.zotero-skill-task.task.leaseMinutes';
const PREF_MAX_FILE_MB = 'extensions.zotero-skill-task.deliverable.maxFileMB';
const FTL_FILE = 'skill-task.ftl';

/** 动态文案（错误/确认框用），静态标签走 data-l10n-id + 中文兜底 */
const STR: Record<string, Record<string, string>> = {
  'zh': {
    apiMissing: '插件核心未就绪，请先打开 Zotero 主窗口。',
    tokenCopied: '凭据已复制到剪贴板',
    tokenCopyFail: '自动复制失败，请手动复制输入框中的凭据',
    regenConfirm: '重新生成访问凭据？旧凭据将立即失效。',
    regenDone: '新凭据已生成，旧凭据已失效',
    badNumber: '请输入有效数字',
    saveFail: '保存失败：',
  },
  'en': {
    apiMissing: 'Plugin core is not ready. Please open the Zotero main window first.',
    tokenCopied: 'Token copied to clipboard',
    tokenCopyFail: 'Auto-copy failed. Please copy the token from the input box manually',
    regenConfirm: 'Regenerate the access token? The old token will stop working immediately.',
    regenDone: 'New token generated; the old one is now invalid',
    badNumber: 'Please enter a valid number',
    saveFail: 'Save failed: ',
  },
};

function lang(): string {
  try {
    const loc = String((Zotero as any)?.locale || '');
    return loc.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

function t(key: string): string {
  const L = lang();
  return (STR[L] && STR[L][key]) || STR['zh'][key] || key;
}

/** 插件业务 API（core.ts 在 startup 时挂载到 Zotero.SkillTask） */
function getAPI(): any {
  try {
    return (Zotero as any)?.SkillTask ?? null;
  } catch {
    return null;
  }
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function showError(msg: string): void {
  const el = $('st-err');
  if (!el) return;
  el.textContent = msg;
  (el as HTMLElement).hidden = false;
}

function clearError(): void {
  const el = $('st-err');
  if (!el) return;
  (el as HTMLElement).hidden = true;
  el.textContent = '';
}

function getPref(key: string, def: any): any {
  try {
    const v = (Zotero as any).Prefs.get(key, true);
    return v !== undefined ? v : def;
  } catch {
    return def;
  }
}

function setPref(key: string, value: boolean | string | number): void {
  (Zotero as any).Prefs.set(key, value, true);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await (navigator as any).clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function refreshMcpStatus(): void {
  const api = getAPI();
  const addrEl = $('st-mcp-addr');
  const enableEl = $('st-mcp-enabled') as HTMLInputElement | null;
  if (!api?.mcp) {
    if (addrEl) addrEl.textContent = '—';
    return;
  }
  try {
    const st = api.mcp.getStatus();
    if (addrEl) {
      addrEl.textContent =
        st && st.port ? `http://127.0.0.1:${st.port}/skilltask/mcp` : '—';
    }
    if (enableEl) enableEl.checked = !!st?.enabled;
  } catch {
    if (addrEl) addrEl.textContent = '—';
  }
}

function init(): void {
  // 注入 Fluent，使 data-l10n-id 生效（失败则保留中文默认文本）
  try {
    (window as any).MozXULElement?.insertFTLIfNeeded(FTL_FILE);
  } catch {
    // ignore
  }

  // 快捷键标签：macOS 显示 ⌘
  try {
    const isMac = /mac/i.test((navigator as any).platform || '');
    const keyEl = $('st-shortcut-key');
    if (keyEl) keyEl.textContent = isMac ? '⌘+Shift+J' : 'Ctrl+Shift+J';
  } catch {
    // ignore
  }

  const api = getAPI();
  if (!api?.mcp) {
    showError(t('apiMissing'));
    return;
  }

  // ── MCP 启用开关 ──
  const enableEl = $('st-mcp-enabled') as HTMLInputElement | null;
  if (enableEl) {
    enableEl.checked = !!api.mcp.isEnabled?.();
    enableEl.addEventListener('change', () => {
      clearError();
      try {
        api.mcp.setEnabled(enableEl.checked);
      } catch (e: any) {
        showError(t('saveFail') + (e?.message || e));
        enableEl.checked = !!api.mcp.isEnabled?.();
      }
      refreshMcpStatus();
    });
  }
  refreshMcpStatus();

  // ── 访问凭据：显示并复制 ──
  const tokenInput = $('st-mcp-token-value') as HTMLInputElement | null;
  const tokenState = $('st-mcp-token-state');
  const showBtn = $('st-mcp-token-show');
  if (showBtn) {
    showBtn.addEventListener('click', async () => {
      clearError();
      try {
        // 注意：token 只做展示与复制，绝不写入日志
        const token = api.mcp.ensureToken();
        if (tokenInput) {
          tokenInput.value = token;
          (tokenInput as HTMLElement).hidden = false;
          tokenInput.select();
        }
        if (tokenState) tokenState.textContent = '••••••••';
        const ok = await copyText(token);
        if (!ok) showError(t('tokenCopyFail'));
      } catch (e: any) {
        showError(t('saveFail') + (e?.message || e));
      }
    });
  }

  // ── 访问凭据：重新生成 ──
  const regenBtn = $('st-mcp-token-regen');
  if (regenBtn) {
    regenBtn.addEventListener('click', () => {
      clearError();
      try {
        if (!window.confirm(t('regenConfirm'))) return;
        const token = api.mcp.regenerateToken();
        if (tokenInput) {
          tokenInput.value = token;
          (tokenInput as HTMLElement).hidden = false;
          tokenInput.select();
        }
        if (tokenState) tokenState.textContent = '••••••••';
        showError(t('regenDone'));
      } catch (e: any) {
        showError(t('saveFail') + (e?.message || e));
      }
    });
  }

  // ── 租约时长（分钟） ──
  const leaseEl = $('st-lease-minutes') as HTMLInputElement | null;
  if (leaseEl) {
    leaseEl.value = String(getPref(PREF_LEASE_MINUTES, 30));
    leaseEl.addEventListener('change', () => {
      clearError();
      const v = Math.floor(Number(leaseEl.value));
      if (!Number.isFinite(v) || v < 1 || v > 1440) {
        showError(t('badNumber'));
        leaseEl.value = String(getPref(PREF_LEASE_MINUTES, 30));
        return;
      }
      try {
        setPref(PREF_LEASE_MINUTES, v);
      } catch (e: any) {
        showError(t('saveFail') + (e?.message || e));
      }
    });
  }

  // ── 文件交付大小上限（MB） ──
  const maxEl = $('st-maxfile-mb') as HTMLInputElement | null;
  if (maxEl) {
    maxEl.value = String(getPref(PREF_MAX_FILE_MB, 50));
    maxEl.addEventListener('change', () => {
      clearError();
      const v = Math.floor(Number(maxEl.value));
      if (!Number.isFinite(v) || v < 1 || v > 200) {
        showError(t('badNumber'));
        maxEl.value = String(getPref(PREF_MAX_FILE_MB, 50));
        return;
      }
      try {
        setPref(PREF_MAX_FILE_MB, v);
      } catch (e: any) {
        showError(t('saveFail') + (e?.message || e));
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
