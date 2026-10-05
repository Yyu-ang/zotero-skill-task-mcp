/**
 * scripts/test-deliverables.mjs — 交付物纯逻辑测试
 *
 * 用 esbuild 把 src/deliverables.ts 打包到 /tmp 后在 Node 下跑 node:test。
 * 覆盖：配置校验/归一化、文件名消毒、base64、提交参数校验、markdown 转换。
 *
 * 用法：node scripts/test-deliverables.mjs  （或 npm test）
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const tmp = mkdtempSync(join(tmpdir(), 'deliv-test-'));
const bundle = join(tmp, 'deliverables.bundle.mjs');
// 用 esbuild JS API（跨平台；Windows 下直接调 .bin/esbuild 二进制路径不可靠）
const esbuild = await import('esbuild');
await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'deliverables.ts')],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
});
const D = await import(bundle);

// —— 辅助 ——
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

describe('assertValidDeliverable', () => {
  test('note 通过', () => {
    assert.deepEqual(D.assertValidDeliverable({ type: 'note' }), { type: 'note' });
  });
  test('file 默认配置通过', () => {
    assert.deepEqual(D.assertValidDeliverable({ type: 'file' }), { type: 'file' });
  });
  test('file 配置归一化（扩展名小写去点）', () => {
    const d = D.assertValidDeliverable({
      type: 'file',
      attachToItem: true,
      allowedExtensions: ['PDF', '.Md'],
      maxBytes: 10 * 1048576,
    });
    assert.deepEqual(d.allowedExtensions, ['pdf', 'md']);
    assert.equal(d.attachToItem, true);
    assert.equal(d.maxBytes, 10 * 1048576);
  });
  test('file 空扩展名数组抛错', () => {
    assert.throws(() => D.assertValidDeliverable({ type: 'file', allowedExtensions: [] }), /非空数组/);
  });
  test('file 非法扩展名抛错', () => {
    assert.throws(
      () => D.assertValidDeliverable({ type: 'file', allowedExtensions: ['exe;rm'] }),
      /非法/
    );
  });
  test('file maxBytes 超过 200MB 拒绝', () => {
    assert.throws(
      () => D.assertValidDeliverable({ type: 'file', maxBytes: 201 * 1048576 }),
      /200MB/
    );
    const d = D.assertValidDeliverable({ type: 'file', maxBytes: 200 * 1048576 });
    assert.equal(d.maxBytes, 200 * 1048576);
  });
  test('markdown target=note/file 通过', () => {
    assert.deepEqual(
      D.assertValidDeliverable({ type: 'markdown', target: 'note' }),
      { type: 'markdown', target: 'note' }
    );
    const d = D.assertValidDeliverable({ type: 'markdown', target: 'file', attachToItem: true });
    assert.equal(d.attachToItem, true);
  });
  test('markdown 非法 target 抛错', () => {
    assert.throws(() => D.assertValidDeliverable({ type: 'markdown', target: 'x' }), /target/);
  });
  test('未知类型/空配置抛错', () => {
    assert.throws(() => D.assertValidDeliverable({ type: 'weird' }), /不支持/);
    assert.throws(() => D.assertValidDeliverable({}), /不支持/);
    assert.throws(() => D.assertValidDeliverable(null), /无效/);
  });
});

describe('normalizeDeliverable（防御性降级）', () => {
  test('损坏配置降级为 note', () => {
    assert.deepEqual(D.normalizeDeliverable(null), { type: 'note' });
    assert.deepEqual(D.normalizeDeliverable({ type: 'file', maxBytes: -1 }), { type: 'note' });
    assert.deepEqual(D.normalizeDeliverable(undefined), { type: 'note' });
  });
});

describe('sanitizeFileName', () => {
  test('目录穿越被剥离', () => {
    assert.equal(D.sanitizeFileName('../../etc/passwd.pdf'), 'passwd.pdf');
    assert.equal(D.sanitizeFileName('a/b\\c.pdf'), 'c.pdf');
    // 无扩展名的 basename 照样拒绝（扩展名白名单需要它）
    assert.throws(() => D.sanitizeFileName('../../etc/passwd'), /缺少扩展名/);
  });
  test('中文名与空格保留', () => {
    assert.equal(D.sanitizeFileName('  报告 v2.PDF '), '报告 v2.PDF');
  });
  test('非法字符替换', () => {
    assert.equal(D.sanitizeFileName('a<b>.pdf'), 'a_b_.pdf');
  });
  test('空名/无扩展名/保留名/超长抛错', () => {
    assert.throws(() => D.sanitizeFileName(''), /无效/);
    assert.throws(() => D.sanitizeFileName('   '), /无效/);
    assert.throws(() => D.sanitizeFileName('.hidden'), /缺少扩展名/);
    assert.throws(() => D.sanitizeFileName('noext'), /缺少扩展名/);
    assert.throws(() => D.sanitizeFileName('NUL.pdf'), /保留名/);
    assert.throws(() => D.sanitizeFileName('a'.repeat(200) + '.pdf'), /过长/);
    assert.throws(() => D.sanitizeFileName(123), /字符串/);
  });
});

describe('base64ToBytes', () => {
  test('正常解码', () => {
    const bytes = D.base64ToBytes(b64('hello'));
    assert.equal(Buffer.from(bytes).toString('utf8'), 'hello');
  });
  test('空白容忍', () => {
    const bytes = D.base64ToBytes('aG Vs\nbG8=');
    assert.equal(Buffer.from(bytes).toString('utf8'), 'hello');
  });
  test('非法输入抛错', () => {
    assert.throws(() => D.base64ToBytes('!!!'), /base64/);
    assert.throws(() => D.base64ToBytes('abc'), /base64/);
  });
});

describe('validateSubmitParams', () => {
  const note = { type: 'note' };
  const file10 = { type: 'file', maxBytes: 10 };
  const mdNote = { type: 'markdown', target: 'note' };
  const mdFile = { type: 'markdown', target: 'file' };

  test('note 缺参数/超大', () => {
    assert.equal(D.validateSubmitParams(note, {}, 't1').error, 'missing-noteHtml');
    assert.equal(
      D.validateSubmitParams(note, { noteHtml: 'x'.repeat(2_000_001) }, 't1').error,
      'note-too-large'
    );
    const ok = D.validateSubmitParams(note, { noteHtml: '<p>hi</p>' }, 't1');
    assert.equal(ok.ok, true);
    assert.equal(ok.kind, 'note');
  });
  test('file 缺参数', () => {
    assert.equal(D.validateSubmitParams(file10, {}, 't1').error, 'missing-fileName');
    assert.equal(
      D.validateSubmitParams(file10, { fileName: 'a.pdf' }, 't1').error,
      'missing-contentBase64'
    );
  });
  test('file 非法扩展名拒绝', () => {
    const r = D.validateSubmitParams(
      { type: 'file', allowedExtensions: ['pdf'] },
      { fileName: 'a.exe', contentBase64: b64('x') },
      't1'
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /^invalid-file/);
  });
  test('file 超大拒绝（含 base64 预检）', () => {
    // 解码后超限
    const r1 = D.validateSubmitParams(
      file10,
      { fileName: 'a.pdf', contentBase64: b64('0123456789ABCDEF') },
      't1'
    );
    assert.equal(r1.error, 'file-too-large');
    // base64 字符串本身过大，直接预检拒绝
    const r2 = D.validateSubmitParams(
      file10,
      { fileName: 'a.pdf', contentBase64: 'A'.repeat(100) },
      't1'
    );
    assert.equal(r2.error, 'file-too-large');
  });
  test('file 非法 base64 拒绝', () => {
    const r = D.validateSubmitParams(
      file10,
      { fileName: 'a.pdf', contentBase64: '!!!' },
      't1'
    );
    assert.equal(r.error, 'invalid-base64');
  });
  test('file 合法通过并解码', () => {
    const r = D.validateSubmitParams(
      file10,
      { fileName: '../a.pdf', contentBase64: b64('0123456789') },
      't1'
    );
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'file');
    assert.equal(r.fileName, 'a.pdf');
    assert.equal(r.bytes.length, 10);
  });
  test('markdown 缺参数/转笔记', () => {
    assert.equal(D.validateSubmitParams(mdNote, {}, 't1').error, 'missing-markdown');
    const r = D.validateSubmitParams(mdNote, { markdown: '# 标题\n\n正文' }, 't1');
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'markdown-note');
    assert.match(r.html, /<p>/);
  });
  test('markdown 存文件：默认文件名与扩展名约束', () => {
    const r1 = D.validateSubmitParams(mdFile, { markdown: 'hi' }, 'task9');
    assert.equal(r1.ok, true);
    assert.equal(r1.kind, 'markdown-file');
    assert.equal(r1.fileName, 'task-task9.md');
    const r2 = D.validateSubmitParams(
      mdFile,
      { markdown: 'hi', fileName: 'a.txt' },
      't1'
    );
    assert.equal(r2.error, 'markdown-file-must-be-md');
  });
});

describe('markdownToNoteHtml', () => {
  test('转义注入并分段', () => {
    const html = D.markdownToNoteHtml('<script>alert(1)</script>\n\nhello');
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /<p>.*<\/p><p>.*<\/p>/);
  });
  test('空输入返回空串', () => {
    assert.equal(D.markdownToNoteHtml('   \n  '), '');
  });
});

describe('deliverableLabel', () => {
  test('各类型中文标签', () => {
    assert.equal(D.deliverableLabel({ type: 'note' }), '内建笔记');
    assert.equal(D.deliverableLabel({ type: 'file' }), '文件');
    assert.equal(
      D.deliverableLabel({ type: 'file', attachToItem: true }),
      '文件（自动挂附件）'
    );
    assert.equal(
      D.deliverableLabel({ type: 'markdown', target: 'file' }),
      'Markdown→文件'
    );
    assert.equal(D.deliverableLabel(undefined), '内建笔记');
  });
});

describe('resolveMaxBytes / resolveAllowedExtensions', () => {
  test('自定义生效，非法回退默认', () => {
    assert.equal(D.resolveMaxBytes({ type: 'file', maxBytes: 1024 }), 1024);
    assert.equal(
      D.resolveMaxBytes({ type: 'file', maxBytes: -5 }),
      200 * 1024 * 1024
    );
    assert.deepEqual(D.resolveAllowedExtensions({ type: 'file', allowedExtensions: ['PDF'] }), ['pdf']);
    assert.ok(D.resolveAllowedExtensions({ type: 'file' }).includes('pdf'));
  });
});
