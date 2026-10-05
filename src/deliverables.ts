/**
 * src/deliverables.ts — 交付物纯逻辑（无 Zotero 依赖，可在 Node 下测试）
 *
 * 覆盖：
 * - 交付物配置校验与归一化（assertValidDeliverable / normalizeDeliverable）
 * - 文件名消毒（sanitizeFileName：防目录穿越、防非法字符）
 * - base64 解码（base64ToBytes）
 * - 提交参数校验（validateSubmitParams：按交付物类型归一化提交）
 * - markdown → 笔记 HTML 的最小安全转换（markdownToNoteHtml）
 * - 面板展示用本地化标签（deliverableLabel，走 getString）
 */

import type { SkillDeliverable } from './types';
import { LIMITS } from './utils';
import { getString } from './utils/locale';
import { getDeliverableMaxBytes } from './prefs';

/** 文件交付物默认扩展名白名单（小写、无点） */
export const DEFAULT_ALLOWED_EXTENSIONS = [
  'pdf',
  'md',
  'txt',
  'csv',
  'json',
  'png',
  'jpg',
  'jpeg',
] as const;

/** 受控输出目录名（Zotero 数据目录 skilltask 下） */
export const DELIVERABLES_DIR_NAME = 'deliverables';

/** Windows 保留文件名（写盘时拒绝，避免跨平台问题） */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

type FileDeliverable = Extract<SkillDeliverable, { type: 'file' }>;
type MarkdownDeliverable = Extract<SkillDeliverable, { type: 'markdown' }>;

/**
 * 校验交付物配置并返回归一化拷贝；非法时抛中文错。
 * 供 skillGroupStore 在 create/update 时调用（第二道防线）。
 */
export function assertValidDeliverable(input: unknown): SkillDeliverable {
  const d = input as Partial<SkillDeliverable> | undefined;
  if (!d || typeof d !== 'object') {
    throw new Error('交付物配置无效');
  }
  if (d.type === 'note') {
    return { type: 'note' };
  }
  if (d.type === 'file') {
    const fd = d as Partial<FileDeliverable>;
    const out: FileDeliverable = { type: 'file' };
    if (fd.attachToItem !== undefined) {
      if (typeof fd.attachToItem !== 'boolean') {
        throw new Error('交付物配置无效：attachToItem 须为布尔值');
      }
      out.attachToItem = fd.attachToItem;
    }
    if (fd.allowedExtensions !== undefined) {
      if (
        !Array.isArray(fd.allowedExtensions) ||
        fd.allowedExtensions.length === 0
      ) {
        throw new Error('交付物配置无效：allowedExtensions 须为非空数组');
      }
      out.allowedExtensions = fd.allowedExtensions.map((e) => {
        const s = String(e ?? '')
          .trim()
          .toLowerCase()
          .replace(/^\./, '');
        if (!/^[a-z0-9]{1,10}$/.test(s)) {
          throw new Error(`交付物配置无效：扩展名 "${String(e)}" 非法`);
        }
        return s;
      });
    }
    if (fd.maxBytes !== undefined) {
      if (!Number.isInteger(fd.maxBytes) || fd.maxBytes <= 0) {
        throw new Error('交付物配置无效：maxBytes 须为正整数');
      }
      out.maxBytes = fd.maxBytes;
    }
    if (fd.targetFileName !== undefined) {
      out.targetFileName = sanitizeFileName(fd.targetFileName);
      const ext = getExtension(out.targetFileName);
      if (!resolveAllowedExtensions(out).includes(ext)) {
        throw new Error(`交付物配置无效：目标文件扩展名 .${ext} 不在允许列表中`);
      }
    }
    if (fd.existingAttachmentPolicy !== undefined) {
      if (
        fd.existingAttachmentPolicy !== 'overwrite' &&
        fd.existingAttachmentPolicy !== 'skip'
      ) {
        throw new Error('交付物配置无效：同名附件策略须为 overwrite 或 skip');
      }
      out.existingAttachmentPolicy = fd.existingAttachmentPolicy;
    }
    return out;
  }
  if (d.type === 'markdown') {
    const md = d as Partial<MarkdownDeliverable>;
    if (md.target !== 'note' && md.target !== 'file') {
      throw new Error('交付物配置无效：markdown 的 target 须为 note 或 file');
    }
    const out: MarkdownDeliverable = { type: 'markdown', target: md.target };
    if (md.attachToItem !== undefined) {
      if (typeof md.attachToItem !== 'boolean') {
        throw new Error('交付物配置无效：attachToItem 须为布尔值');
      }
      out.attachToItem = md.attachToItem;
    }
    if (md.targetFileName !== undefined) {
      if (md.target !== 'file') {
        throw new Error('交付物配置无效：仅 Markdown→文件 可设置目标文件名');
      }
      out.targetFileName = sanitizeFileName(md.targetFileName);
      if (getExtension(out.targetFileName) !== 'md') {
        throw new Error('交付物配置无效：Markdown 目标文件名必须以 .md 结尾');
      }
    }
    if (md.existingAttachmentPolicy !== undefined) {
      if (
        md.existingAttachmentPolicy !== 'overwrite' &&
        md.existingAttachmentPolicy !== 'skip'
      ) {
        throw new Error('交付物配置无效：同名附件策略须为 overwrite 或 skip');
      }
      out.existingAttachmentPolicy = md.existingAttachmentPolicy;
    }
    return out;
  }
  throw new Error(`不支持的交付物类型：${String((d as { type?: unknown }).type)}`);
}

/**
 * 防御性归一化：配置损坏/缺失时降级为 note，保证提交流程不抛错。
 * （与 buildMaterialPackage 对 materials 缺失的降级策略一致）
 */
export function normalizeDeliverable(input: unknown): SkillDeliverable {
  try {
    return assertValidDeliverable(input);
  } catch {
    return { type: 'note' };
  }
}

/** 解析文件交付物的实际大小上限（字节）：技能组自配优先，否则走偏好设置 */
export function resolveMaxBytes(d: FileDeliverable): number {
  if (
    typeof d.maxBytes === 'number' &&
    Number.isInteger(d.maxBytes) &&
    d.maxBytes > 0
  ) {
    return d.maxBytes;
  }
  return getDeliverableMaxBytes();
}

/** 解析文件交付物的实际扩展名白名单（小写） */
export function resolveAllowedExtensions(d: FileDeliverable): string[] {
  if (Array.isArray(d.allowedExtensions) && d.allowedExtensions.length > 0) {
    return d.allowedExtensions.map((e) => e.toLowerCase());
  }
  return [...DEFAULT_ALLOWED_EXTENSIONS];
}

/** 取文件名扩展名（小写、无点）；无扩展名返回 '' */
export function getExtension(fileName: string): string {
  const base = fileName.split('.').pop() ?? '';
  return fileName.includes('.') ? base.toLowerCase() : '';
}

/**
 * 文件名消毒：防目录穿越、防非法字符、防保留名。
 * 返回可安全拼接到受控目录的文件名；非法时抛中文错。
 */
export function sanitizeFileName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new Error('文件名必须是字符串');
  }
  // 取 basename：丢弃任何目录成分（防御性；上层已做白名单校验）
  let base = name.split(/[\\/]/).pop() ?? '';
  base = base.trim().replace(/^\.+/, '');
  // 只保留字母数字（含 CJK）、._- 和空格，其余替换为 _
  base = base.replace(/[^\p{L}\p{N}._\- ]/gu, '_');
  // 压缩连续的 _ 与 .
  base = base.replace(/_{2,}/g, '_').replace(/\.{2,}/g, '.');
  if (!base || base === '.' || base === '..') {
    throw new Error('文件名无效');
  }
  if (WINDOWS_RESERVED.test(base)) {
    throw new Error(`文件名 "${base}" 为系统保留名`);
  }
  if (base.length > LIMITS.deliverableFileName) {
    throw new Error(
      `文件名过长（最多 ${LIMITS.deliverableFileName} 字符）`
    );
  }
  if (!getExtension(base)) {
    throw new Error('文件名缺少扩展名');
  }
  return base;
}

/**
 * 校验文件大小与扩展名；非法时抛中文错。
 * @param byteLength 解码后实际字节数
 */
export function validateFileBytes(
  d: FileDeliverable,
  fileName: string,
  byteLength: number
): void {
  const maxBytes = resolveMaxBytes(d);
  if (byteLength > maxBytes) {
    throw new Error(
      `文件过大（${(byteLength / 1048576).toFixed(1)}MB，上限 ` +
        `${(maxBytes / 1048576).toFixed(1)}MB）`
    );
  }
  const ext = getExtension(fileName);
  const allowed = resolveAllowedExtensions(d);
  if (!allowed.includes(ext)) {
    throw new Error(
      `不支持的文件扩展名 .${ext}（允许：${allowed.map((e) => '.' + e).join('、')}）`
    );
  }
}

/** base64 解码为字节数组；非法输入抛中文错（不依赖 atob，可在 Node 下测试） */
export function base64ToBytes(b64: string): Uint8Array {
  const s = b64.replace(/\s+/g, '');
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new Error('文件内容不是合法的 base64');
  }
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Map<string, number>();
  for (let i = 0; i < chars.length; i++) {
    lookup.set(chars[i], i);
  }
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const outLen = (s.length / 4) * 3 - pad;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = lookup.get(s[i]) ?? 0;
    const b = lookup.get(s[i + 1]) ?? 0;
    const c = s[i + 2] === '=' ? 0 : (lookup.get(s[i + 2]) ?? 0);
    const d = s[i + 3] === '=' ? 0 : (lookup.get(s[i + 3]) ?? 0);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < outLen) out[o++] = (n >> 16) & 0xff;
    if (o < outLen) out[o++] = (n >> 8) & 0xff;
    if (o < outLen) out[o++] = n & 0xff;
  }
  return out;
}

/** HTML 转义（markdown→note 的最小转换用） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * markdown → 笔记 HTML 的最小安全转换：
 * 先做 HTML 转义（防注入），空行分段、单换行转 <br/>。
 * 注：这是轻量转换，不做完整 markdown 解析；如需完整渲染应由 AI 直接提交 HTML（note 类型）。
 */
export function markdownToNoteHtml(md: string): string {
  const paras = md
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paras.length) {
    return '';
  }
  return paras
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

/** 交付物本地化标签（面板展示用；走 getString，未初始化语言时回退中文） */
export function deliverableLabel(d: SkillDeliverable | undefined): string {
  const norm = normalizeDeliverable(d);
  if (norm.type === 'note') {
    return getString('panel-deliverable-note');
  }
  if (norm.type === 'file') {
    return (
      getString('panel-deliverable-file') +
      (norm.attachToItem ? getString('panel-deliverable-file-attach') : '')
    );
  }
  return getString('panel-deliverable-markdown', {
    target: getString(
      norm.target === 'note' ? 'panel-deliverable-note' : 'panel-deliverable-file'
    ),
  });
}

/** 校验后的提交（纯数据，不含 IO） */
export type ValidatedSubmission =
  | { ok: true; kind: 'note'; html: string }
  | { ok: true; kind: 'markdown-note'; html: string }
  | { ok: true; kind: 'file'; fileName: string; bytes: Uint8Array }
  | { ok: true; kind: 'markdown-file'; fileName: string; text: string }
  | { ok: false; error: string };

/**
 * 按交付物 schema 校验 MCP 提交参数；通过时返回归一化提交，失败返回错误码。
 * 错误码为英文短码（mcpServer 直接透传给客户端），与现有 submit 错误码风格一致。
 */
export function validateSubmitParams(
  deliverable: SkillDeliverable,
  params: any,
  taskId: string
): ValidatedSubmission {
  const d = normalizeDeliverable(deliverable);
  if (d.type === 'note') {
    const raw = params?.noteHtml;
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: 'missing-noteHtml' };
    }
    if (raw.length > LIMITS.noteHtml) {
      return { ok: false, error: 'note-too-large' };
    }
    return { ok: true, kind: 'note', html: raw };
  }
  if (d.type === 'markdown') {
    const raw = params?.markdown;
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: 'missing-markdown' };
    }
    if (raw.length > LIMITS.noteHtml) {
      return { ok: false, error: 'note-too-large' };
    }
    if (d.target === 'note') {
      const html = markdownToNoteHtml(raw);
      if (!html) {
        return { ok: false, error: 'empty-markdown' };
      }
      return { ok: true, kind: 'markdown-note', html };
    }
    // target === 'file'：存为 .md 文件
    const rawName =
      typeof d.targetFileName === 'string' && d.targetFileName.trim()
        ? d.targetFileName
        : typeof params?.fileName === 'string' && params.fileName.trim()
          ? params.fileName
          : `task-${taskId}.md`;
    let fileName: string;
    try {
      fileName = sanitizeFileName(rawName);
    } catch (e) {
      return { ok: false, error: `invalid-fileName:${errShort(e)}` };
    }
    if (getExtension(fileName) !== 'md') {
      return { ok: false, error: 'markdown-file-must-be-md' };
    }
    return { ok: true, kind: 'markdown-file', fileName, text: raw };
  }
  // d.type === 'file'
  const rawName =
    typeof d.targetFileName === 'string' && d.targetFileName.trim()
      ? d.targetFileName
      : params?.fileName;
  const rawB64 = params?.contentBase64;
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return { ok: false, error: 'missing-fileName' };
  }
  if (typeof rawB64 !== 'string' || !rawB64.trim()) {
    return { ok: false, error: 'missing-contentBase64' };
  }
  let fileName: string;
  try {
    fileName = sanitizeFileName(rawName);
  } catch (e) {
    return { ok: false, error: `invalid-fileName:${errShort(e)}` };
  }
  const maxBytes = resolveMaxBytes(d);
  // base64 体积约为原文 4/3；先做廉价预检，避免超大字符串进解码
  if (rawB64.length > maxBytes * 2) {
    return { ok: false, error: 'file-too-large' };
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(rawB64);
  } catch {
    return { ok: false, error: 'invalid-base64' };
  }
  try {
    validateFileBytes(d, fileName, bytes.length);
  } catch (e) {
    const msg = errShort(e);
    return {
      ok: false,
      error: msg.includes('过大') ? 'file-too-large' : `invalid-file:${msg}`,
    };
  }
  return { ok: true, kind: 'file', fileName, bytes };
}

/** 取错误短信息（中文校验错直接透传原文） */
function errShort(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 120 ? m.slice(0, 120) + '…' : m;
}
