/**
 * src/preferences.ts — 插件设置面板逻辑（最小 JS）
 *
 * 由 Zotero.PreferencePanes.register 以 chrome 特权加载到设置窗口，
 * 打包为 addon/content/preferences.js。
 *
 * Green Frog 模式：简单设置项（租约时长、文件上限）走 xhtml 里的
 * preference 属性原生绑定，无需 JS；这里只保留需要业务逻辑的部分：
 * MCP 服务开关（启停要调 mcp.register/unregister）、访问凭据显示/重新生成。
 * 静态文案走 <linkset> 挂载的 skill-task.ftl；动态文案（确认框/报错）中英双语。
 * 凭据绝不写入日志。
 */

const FTL_FILE = 'skill-task.ftl';

/** 动态文案（错误/确认框用），静态标签走 data-l10n-id + 中文兜底 */
const STR: Record<string, Record<string, string>> = {
  zh: {
    apiMissing: '插件核心未就绪，请先打开 Zotero 主窗口。',
    tokenCopied: '凭据已复制到剪贴板',
    tokenCopyFail: '自动复制失败，请手动复制输入框中的凭据',
    regenConfirm: '重新生成访问凭据？旧凭据将立即失效。',
    regenDone: '新凭据已生成，旧凭据已失效',
    saveFail: '保存失败：',
  },
  en: {
    apiMissing: 'Plugin core is not ready. Please open the Zotero main window first.',
    tokenCopied: 'Token copied to clipboard',
    tokenCopyFail: 'Auto-copy failed. Please copy the token from the input box manually',
    regenConfirm: 'Regenerate the access token? The old token will stop working immediately.',
    regenDone: 'New token generated; the old one is now invalid',
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
    // XUL checkbox 用 checked 属性；原生 preference 绑定未使用（启停需调 register/unregister）
    if (enableEl) (enableEl as any).checked = !!st?.enabled;
  } catch {
    if (addrEl) addrEl.textContent = '—';
  }
}

function init(): void {
  // 兜底注入 Fluent（<linkset> 正常时这行无副作用）
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

  // ── MCP 启用开关（JS 驱动：除写偏好外还要 register/unregister 服务） ──
  const enableEl = $('st-mcp-enabled') as any;
  if (enableEl) {
    enableEl.checked = !!api.mcp.isEnabled?.();
    enableEl.addEventListener('command', () => {
      clearError();
      try {
        api.mcp.setEnabled(!!enableEl.checked);
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
    showBtn.addEventListener('command', async () => {
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
    regenBtn.addEventListener('command', () => {
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
