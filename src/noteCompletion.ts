/** Generic completion checks against a parent's built-in Zotero child notes. */

export interface NoteMatchCondition {
  field: 'tag' | 'title' | 'text';
  operator: 'equals' | 'contains' | 'startsWith';
  value: string;
}

export interface NoteCompletionRule {
  enabled: boolean;
  type: 'builtin-note';
  match: {
    operator: 'all' | 'any';
    conditions: NoteMatchCondition[];
    exclude?: NoteMatchCondition[];
    requireContent?: boolean;
    minContentLength?: number;
  };
}

export interface NoteCompletionFacts {
  key: string;
  title: string;
  /** Visible note text, including its title. No HTML or hidden text. */
  text: string;
  tags: string[];
  dateModified?: string | number;
}

export interface NoteCompletionEvaluation {
  matches: boolean;
  matchedConditions: number[];
  excluded: boolean;
  /** Unicode characters, excluding whitespace and zero-width formatting. */
  contentLength: number;
}

export type NoteCompletionResult =
  | { status: 'matched'; noteKey: string; title: string; matchedConditions: number[] }
  | { status: 'not-matched' }
  | { status: 'error'; error: string };

const MAX_CONDITIONS = 50;
const MAX_VALUE_LENGTH = 1000;
const MAX_CONTENT_LENGTH = 1_000_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Literal, case-sensitive matching; normalization is shared by rules and notes. */
export function normalizeNoteText(value: string): string {
  return value.normalize('NFC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\s+/gu, ' ').trim();
}

function conditions(value: unknown, name: string): NoteMatchCondition[] {
  if (!Array.isArray(value) || value.length > MAX_CONDITIONS) {
    throw new Error(`completionRule.match.${name} must be an array of at most ${MAX_CONDITIONS} conditions`);
  }
  return value.map((item: unknown, index: number) => {
    const prefix = `completionRule.match.${name}[${index}]`;
    if (!record(item)) throw new Error(`${prefix} must be an object`);
    if (item.field !== 'tag' && item.field !== 'title' && item.field !== 'text') {
      throw new Error(`${prefix}.field must be tag, title or text`);
    }
    if (item.operator !== 'equals' && item.operator !== 'contains' && item.operator !== 'startsWith') {
      throw new Error(`${prefix}.operator must be equals, contains or startsWith`);
    }
    if (item.field === 'tag' && item.operator !== 'equals') {
      throw new Error(`${prefix}: tag conditions support equals only`);
    }
    if (typeof item.value !== 'string' || item.value.length > MAX_VALUE_LENGTH) {
      throw new Error(`${prefix}.value must be a string of at most ${MAX_VALUE_LENGTH} characters`);
    }
    const value = normalizeNoteText(item.value);
    if (!value) throw new Error(`${prefix}.value must not be empty`);
    return { field: item.field, operator: item.operator, value };
  });
}

/** Validate both UI and MCP input. Missing rules preserve pre-beta behavior. */
export function assertValidCompletionRule(input: unknown): NoteCompletionRule | undefined {
  if (input === undefined || input === null) return undefined;
  if (!record(input)) throw new Error('completionRule must be an object');
  if (typeof input.enabled !== 'boolean') throw new Error('completionRule.enabled must be boolean');
  if (input.type !== 'builtin-note') throw new Error('completionRule.type must be builtin-note');
  const match = input.match;
  if (!record(match)) {
    if (!input.enabled && match === undefined) {
      return {
        enabled: false,
        type: 'builtin-note',
        match: { operator: 'all', conditions: [], exclude: [], requireContent: true, minContentLength: 1 },
      };
    }
    throw new Error('completionRule.match must be an object');
  }
  if (match.operator !== 'all' && match.operator !== 'any') {
    throw new Error('completionRule.match.operator must be all or any');
  }
  const positive = conditions(match.conditions, 'conditions');
  if (input.enabled && positive.length === 0) {
    throw new Error('Enabled completion rules require at least one positive condition');
  }
  const exclude = match.exclude === undefined ? [] : conditions(match.exclude, 'exclude');
  if (match.requireContent !== undefined && typeof match.requireContent !== 'boolean') {
    throw new Error('completionRule.match.requireContent must be boolean');
  }
  const minContentLength = match.minContentLength === undefined ? (match.requireContent === false ? 0 : 1) : match.minContentLength;
  if (typeof minContentLength !== 'number' || !Number.isSafeInteger(minContentLength) || minContentLength < 0 || minContentLength > MAX_CONTENT_LENGTH) {
    throw new Error(`completionRule.match.minContentLength must be an integer between 0 and ${MAX_CONTENT_LENGTH}`);
  }
  return {
    enabled: input.enabled,
    type: 'builtin-note',
    match: {
      operator: match.operator,
      conditions: positive,
      exclude,
      requireContent: match.requireContent ?? true,
      minContentLength,
    },
  };
}

function matchesCondition(condition: NoteMatchCondition, note: NoteCompletionFacts): boolean {
  if (condition.field === 'tag') {
    return note.tags.some((tag) => normalizeNoteText(tag) === condition.value);
  }
  const value = normalizeNoteText(condition.field === 'title' ? note.title : note.text);
  switch (condition.operator) {
    case 'equals': return value === condition.value;
    case 'contains': return value.includes(condition.value);
    case 'startsWith': return value.startsWith(condition.value);
  }
}

function evaluateValidated(rule: NoteCompletionRule, note: NoteCompletionFacts): NoteCompletionEvaluation {
  const text = normalizeNoteText(note.text);
  const contentLength = Array.from(text.replace(/\s/gu, '')).length;
  const excluded = (rule.match.exclude ?? []).some((condition) => matchesCondition(condition, note));
  const matchedConditions: number[] = [];
  if (rule.enabled && !excluded) {
    rule.match.conditions.forEach((condition, index) => {
      if (matchesCondition(condition, note)) matchedConditions.push(index);
    });
  }
  const predicatesMatch = rule.match.operator === 'all'
    ? matchedConditions.length === rule.match.conditions.length && matchedConditions.length > 0
    : matchedConditions.length > 0;
  const minimum = Math.max(rule.match.requireContent === false ? 0 : 1, rule.match.minContentLength ?? (rule.match.requireContent === false ? 0 : 1));
  return {
    matches: rule.enabled && !excluded && predicatesMatch && contentLength >= minimum,
    matchedConditions,
    excluded,
    contentLength,
  };
}

/** Every predicate and exclusion is evaluated against this one note only. */
export function evaluateNoteCompletion(rule: NoteCompletionRule, note: NoteCompletionFacts): NoteCompletionEvaluation {
  return evaluateValidated(assertValidCompletionRule(rule)!, note);
}

const BLOCK_ELEMENTS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

/** Parse inert HTML using Zotero's DOMParser; never interpret markup as a marker. */
export function noteHtmlToText(html: string): string {
  if (typeof html !== 'string') throw new Error('Note HTML is not a string');
  const Parser = (globalThis as any).DOMParser;
  if (typeof Parser !== 'function') throw new Error('DOMParser is unavailable for note completion checks');
  const doc = new Parser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  if (!doc?.body) throw new Error('Cannot read note HTML');
  for (const element of Array.from(doc.querySelectorAll(
    'script,style,template,noscript,iframe,object,embed,head,meta,link,[hidden],[aria-hidden="true"]'
  )) as any[]) element.remove();
  for (const element of Array.from(doc.body.querySelectorAll('[style]')) as any[]) {
    const display = String(element.style?.getPropertyValue('display') ?? '').trim().toLowerCase();
    const visibility = String(element.style?.getPropertyValue('visibility') ?? '').trim().toLowerCase();
    const opacity = String(element.style?.getPropertyValue('opacity') ?? '').trim();
    if (display === 'none' || visibility === 'hidden' || visibility === 'collapse' || (opacity !== '' && Number(opacity) === 0)) {
      element.remove();
    }
  }
  // Iterative traversal handles deeply nested notes; block boundaries remain spaces.
  const output: string[] = [];
  const nodes: Array<any | string> = [doc.body];
  while (nodes.length) {
    const node = nodes.pop();
    if (typeof node === 'string') { output.push(node); continue; }
    if (node.nodeType === 3) { output.push(node.nodeValue ?? ''); continue; }
    if (node.nodeType !== 1) continue;
    const block = BLOCK_ELEMENTS.has(String(node.tagName).toUpperCase());
    if (block) output.push(' ');
    if (block) nodes.push(' ');
    const children = node.childNodes;
    for (let i = children.length - 1; i >= 0; i--) nodes.push(children[i]);
  }
  return normalizeNoteText(output.join(''));
}

function modifiedTime(value: string | number | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const utc = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  const parsed = Date.parse(utc);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Read direct child notes only. An incomplete read cannot establish a negative result. */
export async function findMatchingBuiltinNote(parent: any, input: NoteCompletionRule | undefined): Promise<NoteCompletionResult> {
  try {
    const rule = assertValidCompletionRule(input);
    if (!rule?.enabled) return { status: 'not-matched' };
    if (!parent || typeof parent.getNotes !== 'function' || !Number.isInteger(parent.id) || !Number.isInteger(parent.libraryID)) {
      throw new Error('Parent item is unavailable for note completion checks');
    }
    if (parent.deleted) return { status: 'not-matched' };
    // Items.getAsync loads primary data; these getters require additional data types.
    if (typeof parent.loadDataType === 'function') await parent.loadDataType('childItems');
    const ids: unknown = parent.getNotes();
    if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id))) {
      throw new Error('Cannot read child note IDs');
    }
    if (!ids.length) return { status: 'not-matched' };
    const Z = (globalThis as any).Zotero;
    if (typeof Z?.Items?.getAsync !== 'function') throw new Error('Zotero note reader is unavailable');
    const matches: Array<{ facts: NoteCompletionFacts; evaluation: NoteCompletionEvaluation }> = [];
    const errors: string[] = [];
    for (const id of Array.from(new Set(ids))) {
      try {
        const note = await Z.Items.getAsync(id);
        if (!note) throw new Error('Child note is unavailable');
        if (note.deleted) continue;
        if (typeof note.isNote !== 'function') throw new Error('Cannot determine child item type');
        if (!note.isNote()) continue;
        if (!Number.isInteger(note.parentID) || !Number.isInteger(note.libraryID)) {
          throw new Error('Child note parent or library is unavailable');
        }
        if (note.parentID !== parent.id || note.libraryID !== parent.libraryID) continue;
        if (typeof note.key !== 'string' || !note.key) throw new Error('Child note has no key');
        if (typeof note.getNoteTitle !== 'function' || typeof note.getNote !== 'function' || typeof note.getTags !== 'function') {
          throw new Error('Child note fields are unavailable');
        }
        if (typeof note.loadDataType === 'function') {
          for (const dataType of ['itemData', 'note', 'tags']) await note.loadDataType(dataType);
        }
        if (note.deleted || note.parentID !== parent.id || note.libraryID !== parent.libraryID) continue;
        const title: unknown = note.getNoteTitle();
        const html: unknown = note.getNote();
        const tags: unknown = note.getTags();
        if (typeof title !== 'string' || typeof html !== 'string' || !Array.isArray(tags) || tags.some((tag) => !record(tag) || typeof tag.tag !== 'string')) {
          throw new Error('Cannot read child note fields');
        }
        const facts: NoteCompletionFacts = {
          key: note.key,
          title,
          text: noteHtmlToText(html),
          tags: tags.map((tag) => tag.tag),
          dateModified: note.dateModified,
        };
        const evaluation = evaluateValidated(rule, facts);
        if (evaluation.matches) matches.push({ facts, evaluation });
      } catch (e) {
        errors.push(`note ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    matches.sort((a, b) => modifiedTime(b.facts.dateModified) - modifiedTime(a.facts.dateModified)
      || (a.facts.key < b.facts.key ? -1 : a.facts.key > b.facts.key ? 1 : 0));
    const found = matches[0];
    if (found) return { status: 'matched', noteKey: found.facts.key, title: found.facts.title, matchedConditions: found.evaluation.matchedConditions };
    if (errors.length) return { status: 'error', error: errors.join('; ').slice(0, 1000) };
    return { status: 'not-matched' };
  } catch (e) {
    return { status: 'error', error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) };
  }
}

const CONDITION_SCHEMA = {
  type: 'object',
  properties: {
    field: { type: 'string', enum: ['tag', 'title', 'text'] },
    operator: { type: 'string', enum: ['equals', 'contains', 'startsWith'] },
    value: { type: 'string', minLength: 1, maxLength: MAX_VALUE_LENGTH },
  },
  required: ['field', 'operator', 'value'],
  description: 'Literal, case-sensitive condition. Tags support equals only. All conditions apply to the same child note.',
};

/** Shared tool schema; runtime validation additionally enforces tag operators and nonempty positive rules. */
export const NOTE_COMPLETION_RULE_SCHEMA = {
  type: 'object',
  description: 'Optional generic completion detection from built-in Zotero child notes. Disabled when omitted.',
  properties: {
    enabled: { type: 'boolean' },
    type: { type: 'string', enum: ['builtin-note'] },
    match: {
      type: 'object',
      properties: {
        operator: { type: 'string', enum: ['all', 'any'] },
        conditions: { type: 'array', maxItems: MAX_CONDITIONS, items: CONDITION_SCHEMA },
        exclude: { type: 'array', maxItems: MAX_CONDITIONS, items: CONDITION_SCHEMA },
        requireContent: { type: 'boolean', default: true },
        minContentLength: {
          type: 'integer', minimum: 0, maximum: MAX_CONTENT_LENGTH,
          description: 'Minimum non-whitespace Unicode characters in visible note text, including its title. Defaults to 1, or 0 when requireContent is false.',
        },
      },
      required: ['operator', 'conditions'],
    },
  },
  required: ['enabled', 'type', 'match'],
};
