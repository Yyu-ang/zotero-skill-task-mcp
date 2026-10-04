/**
 * src/preferences.ts — 插件设置面板逻辑（最小 JS）
 *
 * 由 Zotero.PreferencePanes.register 以 chrome 特权加载到设置窗口，
 * 打包为 addon/content/preferences.js。
 *
 * Green Frog 模式：简单设置项（租约时长、文件上限）走 xhtml 里的
 * preference 属性原生绑定，无需 JS；这里只保留需要业务逻辑的部分：
 * MCP 服务开关（启停要调 mcp.register/unregister）、访问凭据显示/重新生成、
 * 快捷键配置（校验 + 冲突提示）。
 * 静态文案走 <linkset> 挂载的 skill-task.ftl；动态文案走 src/utils/locale.ts
 * 的 getString()（构建时从 ftl 提取，中英双语）。
 * 凭据绝不写入日志。
 */

import { initLocale, getString } from './utils/locale';
import {
  prefs,
  PREFS,
  isMacPlatform,
  normalizeShortcutKey,
  isShortcutEnabled,
} from './prefs';
import { getPanelShortcutLabel, isShortcutKeyReserved } from './ui';

const FTL_FILE = 'skill-task.ftl';

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
  // 需求单 需求1：JS 侧 Fluent 国际化（构建时从 ftl 提取，同步 getString）
  initLocale();

  // 兜底注入 Fluent（<linkset> 正常时这行无副作用）
  try {
    (window as any).MozXULElement?.insertFTLIfNeeded(FTL_FILE);
  } catch {
    // ignore
  }

  // ── 快捷键配置（需求单 需求6；不依赖业务 API，核心未就绪时仍可用） ──
  initShortcutConfig();

  const api = getAPI();
  if (!api?.mcp) {
    showError(getString('prefs-api-missing'));
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
        showError(getString('prefs-save-fail', { error: errMsg(e) }));
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
        if (!ok) showError(getString('prefs-token-copy-fail'));
      } catch (e: any) {
        showError(getString('prefs-save-fail', { error: errMsg(e) }));
      }
    });
  }

  // ── 访问凭据：重新生成 ──
  const regenBtn = $('st-mcp-token-regen');
  if (regenBtn) {
    regenBtn.addEventListener('command', () => {
      clearError();
      try {
        if (!window.confirm(getString('prefs-regen-confirm'))) return;
        const token = api.mcp.regenerateToken();
        if (tokenInput) {
          tokenInput.value = token;
          (tokenInput as HTMLElement).hidden = false;
          tokenInput.select();
        }
        if (tokenState) tokenState.textContent = '••••••••';
        showError(getString('prefs-regen-done'));
      } catch (e: any) {
        showError(getString('prefs-save-fail', { error: errMsg(e) }));
      }
    });
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '');
}

// ──────────── 快捷键配置（需求单 需求6） ────────────

function showShortcutError(msg: string): void {
  const el = $('st-shortcut-err');
  if (!el) return;
  el.textContent = msg;
  (el as HTMLElement).hidden = false;
}

function clearShortcutError(): void {
  const el = $('st-shortcut-err');
  if (!el) return;
  (el as HTMLElement).hidden = true;
  el.textContent = '';
}

/**
 * 快捷键配置区初始化：
 * - 启用开关 / Mac-Win 按键字母：读偏好回填，修改即写偏好（实时生效，
 *   ui.ts 的 keydown handler 每次触发时重读偏好，无需重新注册）
 * - 非法输入（非单个字母/数字）拒绝保存并给出可见提示
 * - 按键命中已知 Zotero 占用组合时给出可见冲突提示（不静默失效）
 */
function initShortcutConfig(): void {
  const enableEl = $('st-shortcut-enabled') as any;
  const macEl = $('st-shortcut-key-mac') as HTMLInputElement | null;
  const winEl = $('st-shortcut-key-win') as HTMLInputElement | null;
  const warnEl = $('st-shortcut-warn');
  const labelEl = $('st-shortcut-key');
  if (!enableEl && !macEl && !winEl) return;

  const refreshLabel = (): void => {
    if (labelEl) {
      try {
        labelEl.textContent = getPanelShortcutLabel();
      } catch {
        // ignore
      }
    }
  };

  /** 当前平台生效按键是否冲突 → 可见提示 */
  const refreshWarn = (): void => {
    if (!warnEl) return;
    let cur: string;
    try {
      cur = isMacPlatform()
        ? normalizeShortcutKey(macEl?.value ?? prefs.get(PREFS.SHORTCUT_KEY_MAC, 'J'))
        : normalizeShortcutKey(winEl?.value ?? prefs.get(PREFS.SHORTCUT_KEY_WIN, 'J'));
    } catch {
      cur = 'J';
    }
    if (isShortcutKeyReserved(cur)) {
      warnEl.textContent = getString('prefs-shortcut-conflict-warn', { key: cur });
      (warnEl as HTMLElement).hidden = false;
    } else {
      (warnEl as HTMLElement).hidden = true;
      warnEl.textContent = '';
    }
  };

  const bindKeyInput = (
    input: HTMLInputElement | null,
    prefKey: string
  ): void => {
    if (!input) return;
    input.addEventListener('change', () => {
      clearShortcutError();
      const c = String(input.value ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]$/.test(c)) {
        showShortcutError(getString('prefs-shortcut-invalid'));
        try {
          input.value = normalizeShortcutKey(prefs.get(prefKey, 'J'));
        } catch {
          // ignore
        }
        refreshWarn();
        return;
      }
      try {
        prefs.set(prefKey, c);
        input.value = c;
      } catch (e) {
        showShortcutError(getString('prefs-save-fail', { error: errMsg(e) }));
      }
      refreshLabel();
      refreshWarn();
    });
    // 输入过程中即时刷新冲突提示
    input.addEventListener('input', () => refreshWarn());
  };

  try {
    if (enableEl) (enableEl as any).checked = isShortcutEnabled();
    if (macEl) macEl.value = normalizeShortcutKey(prefs.get(PREFS.SHORTCUT_KEY_MAC, 'J'));
    if (winEl) winEl.value = normalizeShortcutKey(prefs.get(PREFS.SHORTCUT_KEY_WIN, 'J'));
  } catch {
    // 偏好不可读时保持 xhtml 默认值
  }

  if (enableEl) {
    enableEl.addEventListener('command', () => {
      clearShortcutError();
      try {
        prefs.set(PREFS.SHORTCUT_ENABLED, !!enableEl.checked);
      } catch (e) {
        showShortcutError(getString('prefs-save-fail', { error: errMsg(e) }));
        try {
          enableEl.checked = isShortcutEnabled();
        } catch {
          // ignore
        }
      }
      refreshLabel();
    });
  }

  bindKeyInput(macEl, PREFS.SHORTCUT_KEY_MAC);
  bindKeyInput(winEl, PREFS.SHORTCUT_KEY_WIN);

  refreshLabel();
  refreshWarn();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
