// Minimal order-preserving XML document model for Cemu's settings.xml and
// controller profiles. Cemu reads them with tinyxml2 / pugixml and rewrites
// settings.xml itself on exit, so OmniPC only needs element/text/attribute
// round-tripping: unknown elements, attributes and comments are preserved, and
// the output mirrors tinyxml2's default printer (4-space indent, <a/> for empty).

export type XmlNode = XmlElement | { type: 'text'; value: string } | { type: 'comment'; value: string };

export interface XmlElement {
  type: 'element';
  name: string;
  attrs: [string, string][];
  children: XmlNode[];
}

export interface XmlDocument {
  /** Raw prolog items before the root (declaration, comments). */
  prolog: string[];
  root: XmlElement;
}

const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    return String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });

const encodeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const encodeAttr = (s: string): string => encodeText(s).replace(/"/g, '&quot;');

export function element(name: string, children: XmlNode[] = [], attrs: [string, string][] = []): XmlElement {
  return { type: 'element', name, attrs, children };
}

/** Parses an XML document; throws with a readable message when it is malformed. */
export function parseXml(text: string): XmlDocument {
  const src = text.replace(/^﻿/, '');
  const prolog: string[] = [];
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < src.length) {
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i);
      if (end < 0) throw new Error('Unterminated processing instruction');
      if (!stack.length && !root) prolog.push(src.slice(i, end + 2));
      i = end + 2;
    } else if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i);
      if (end < 0) throw new Error('Unterminated comment');
      const value = src.slice(i + 4, end);
      if (stack.length) top().children.push({ type: 'comment', value });
      else if (!root) prolog.push(src.slice(i, end + 3));
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i);
      if (end < 0 || !stack.length) throw new Error('Misplaced CDATA section');
      top().children.push({ type: 'text', value: src.slice(i + 9, end) });
      i = end + 3;
    } else if (src.startsWith('<!', i)) {
      const end = src.indexOf('>', i);
      if (end < 0) throw new Error('Unterminated declaration');
      if (!root && !stack.length) prolog.push(src.slice(i, end + 1));
      i = end + 1;
    } else if (src.startsWith('</', i)) {
      const end = src.indexOf('>', i);
      if (end < 0) throw new Error('Unterminated closing tag');
      const name = src.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`Unexpected closing tag </${name}>${open ? ` (expected </${open.name}>)` : ''}`);
      if (!stack.length) root = open;
      i = end + 1;
    } else if (src[i] === '<') {
      const m = /^<([A-Za-z_][\w.\-:]*)((?:\s+[A-Za-z_][\w.\-:]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(src.slice(i));
      if (!m) throw new Error(`Malformed tag at offset ${i}`);
      if (root) throw new Error('More than one root element');
      const attrs: [string, string][] = [];
      for (const a of m[2].matchAll(/([A-Za-z_][\w.\-:]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs.push([a[1], decode(a[2] ?? a[3] ?? '')]);
      const el = element(m[1], [], attrs);
      if (stack.length) top().children.push(el);
      if (m[3]) {
        if (!stack.length) root = el;
      } else stack.push(el);
      i += m[0].length;
    } else {
      const end = src.indexOf('<', i);
      const raw = src.slice(i, end < 0 ? src.length : end);
      if (stack.length) top().children.push({ type: 'text', value: decode(raw) });
      else if (raw.trim()) throw new Error('Text outside the root element');
      i = end < 0 ? src.length : end;
    }
  }
  if (stack.length) throw new Error(`Unclosed tag <${top().name}> (file may be truncated)`);
  if (!root) throw new Error('No root element');
  return { prolog, root };
}

export function tryParseXml(text: string): { doc: XmlDocument | null; issues: string[] } {
  try {
    return { doc: parseXml(text), issues: [] };
  } catch (e) {
    return { doc: null, issues: [(e as Error).message] };
  }
}

function hasElementChildren(el: XmlElement): boolean {
  return el.children.some((c) => c.type === 'element' || c.type === 'comment');
}

function serializeElement(el: XmlElement, depth: number, out: string[]): void {
  const pad = '    '.repeat(depth);
  const attrs = el.attrs.map(([k, v]) => ` ${k}="${encodeAttr(v)}"`).join('');
  if (hasElementChildren(el)) {
    out.push(`${pad}<${el.name}${attrs}>`);
    for (const c of el.children) {
      if (c.type === 'element') serializeElement(c, depth + 1, out);
      else if (c.type === 'comment') out.push(`${pad}    <!--${c.value}-->`);
    }
    out.push(`${pad}</${el.name}>`);
    return;
  }
  const text = el.children.map((c) => (c.type === 'text' ? c.value : '')).join('');
  out.push(text.length ? `${pad}<${el.name}${attrs}>${encodeText(text)}</${el.name}>` : `${pad}<${el.name}${attrs}/>`);
}

export function serializeXml(doc: XmlDocument): string {
  const out: string[] = [...doc.prolog];
  serializeElement(doc.root, 0, out);
  return `${out.join('\n')}\n`;
}

export function childElements(el: XmlElement, name?: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => c.type === 'element' && (name === undefined || c.name === name));
}

export function child(el: XmlElement, name: string): XmlElement | null {
  return childElements(el, name)[0] ?? null;
}

export function textOf(el: XmlElement): string {
  return el.children.map((c) => (c.type === 'text' ? c.value : '')).join('').trim();
}

/** Element at `path` below `root` (first match per level), or null. */
export function getElement(root: XmlElement, path: string[]): XmlElement | null {
  let cur: XmlElement | null = root;
  for (const p of path) {
    if (!cur) return null;
    cur = child(cur, p);
  }
  return cur;
}

export function getText(root: XmlElement, path: string[]): string | null {
  const el = getElement(root, path);
  return el ? textOf(el) : null;
}

/** Creates missing elements along `path`. */
export function ensureElement(root: XmlElement, path: string[]): XmlElement {
  let cur = root;
  for (const p of path) {
    let next = child(cur, p);
    if (!next) {
      next = element(p);
      cur.children.push(next);
    }
    cur = next;
  }
  return cur;
}

/** Sets the text of the element at `path`; returns true when something changed. */
export function setText(root: XmlElement, path: string[], value: string): boolean {
  const existing = getElement(root, path);
  if (existing && !hasElementChildren(existing) && textOf(existing) === value) return false;
  const el = existing ?? ensureElement(root, path);
  el.children = value.length ? [{ type: 'text', value }] : [];
  return true;
}
