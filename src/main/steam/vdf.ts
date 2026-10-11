// Valve KeyValues ("VDF") in its two encodings:
//  - binary, used by userdata/<id>/config/shortcuts.vdf. Every node is a type
//    byte, a NUL-terminated key and a value; maps end with 0x08. The parser
//    keeps entry order and the bytes of types it does not interpret, so
//    serialize(parse(x)) reproduces x byte for byte.
//  - text, used by config/loginusers.vdf ("key" "value" / "key" { ... }).

export const VdfType = {
  Map: 0x00,
  String: 0x01,
  Int32: 0x02,
  Float32: 0x03,
  Pointer: 0x04,
  Color: 0x06,
  UInt64: 0x07,
  End: 0x08,
  Int64: 0x0a,
} as const;

/** Fixed-size value types kept as raw bytes (never edited by OmniPC). */
const FIXED_SIZE: Record<number, number> = { [VdfType.Float32]: 4, [VdfType.Pointer]: 4, [VdfType.Color]: 4, [VdfType.UInt64]: 8, [VdfType.Int64]: 8 };

export type VdfNode =
  | { type: 'map'; entries: VdfEntry[] }
  /** `raw` holds the original bytes when they were not valid UTF-8, so they survive unchanged. */
  | { type: 'string'; value: string; raw?: Buffer }
  | { type: 'int32'; value: number }
  | { type: 'fixed'; tag: number; bytes: Buffer };

export interface VdfEntry {
  key: string;
  keyRaw?: Buffer;
  node: VdfNode;
}

export type VdfMap = Extract<VdfNode, { type: 'map' }>;

export interface BinaryVdf {
  root: VdfMap;
  /** Bytes after the root's end marker (normally none). */
  trailing: Buffer;
}

export class VdfError extends Error {}

export function parseBinaryVdf(buf: Buffer): BinaryVdf {
  let pos = 0;
  const cstring = (): { text: string; raw?: Buffer } => {
    const end = buf.indexOf(0, pos);
    if (end < 0) throw new VdfError(`unterminated string at byte ${pos}`);
    const raw = buf.subarray(pos, end);
    pos = end + 1;
    const text = raw.toString('utf8');
    return Buffer.from(text, 'utf8').equals(raw) ? { text } : { text, raw: Buffer.from(raw) };
  };
  const map = (depth: number): VdfMap => {
    if (depth > 64) throw new VdfError('nesting too deep');
    const entries: VdfEntry[] = [];
    for (;;) {
      if (pos >= buf.length) {
        // Truncated file: only tolerated for the root (an empty file is an empty map).
        if (depth === 0) return { type: 'map', entries };
        throw new VdfError('unexpected end of file');
      }
      const tag = buf[pos++];
      if (tag === VdfType.End) return { type: 'map', entries };
      const k = cstring();
      const entry = (node: VdfNode): VdfEntry => (k.raw ? { key: k.text, keyRaw: k.raw, node } : { key: k.text, node });
      if (tag === VdfType.Map) entries.push(entry(map(depth + 1)));
      else if (tag === VdfType.String) {
        const v = cstring();
        entries.push(entry(v.raw ? { type: 'string', value: v.text, raw: v.raw } : { type: 'string', value: v.text }));
      } else if (tag === VdfType.Int32) {
        if (pos + 4 > buf.length) throw new VdfError('unexpected end of file');
        entries.push(entry({ type: 'int32', value: buf.readInt32LE(pos) }));
        pos += 4;
      } else if (FIXED_SIZE[tag] !== undefined) {
        const n = FIXED_SIZE[tag];
        if (pos + n > buf.length) throw new VdfError('unexpected end of file');
        entries.push(entry({ type: 'fixed', tag, bytes: Buffer.from(buf.subarray(pos, pos + n)) }));
        pos += n;
      } else {
        throw new VdfError(`unknown value type 0x${tag.toString(16)} at byte ${pos - 1}`);
      }
    }
  };
  const root = map(0);
  return { root, trailing: Buffer.from(buf.subarray(pos)) };
}

export function serializeBinaryVdf(doc: BinaryVdf): Buffer {
  const parts: Buffer[] = [];
  const cstring = (text: string, raw?: Buffer) => {
    parts.push(raw ?? Buffer.from(text, 'utf8'), Buffer.from([0]));
  };
  const map = (m: VdfMap) => {
    for (const e of m.entries) {
      const n = e.node;
      const tag = n.type === 'map' ? VdfType.Map : n.type === 'string' ? VdfType.String : n.type === 'int32' ? VdfType.Int32 : n.tag;
      parts.push(Buffer.from([tag]));
      cstring(e.key, e.keyRaw && e.keyRaw.toString('utf8') === e.key ? e.keyRaw : undefined);
      if (n.type === 'map') map(n);
      else if (n.type === 'string') cstring(n.value, n.raw && n.raw.toString('utf8') === n.value ? n.raw : undefined);
      else if (n.type === 'int32') {
        const b = Buffer.alloc(4);
        b.writeInt32LE(n.value | 0);
        parts.push(b);
      } else parts.push(n.bytes);
    }
    parts.push(Buffer.from([VdfType.End]));
  };
  map(doc.root);
  parts.push(doc.trailing);
  return Buffer.concat(parts);
}

// ----------------------------------------------------------------- helpers

/** Case-insensitive lookup (Steam has written both "AppName" and "appname"). */
export function vdfGet(m: VdfMap, key: string): VdfEntry | undefined {
  const k = key.toLowerCase();
  return m.entries.find((e) => e.key.toLowerCase() === k);
}

export function vdfString(m: VdfMap, key: string): string | null {
  const n = vdfGet(m, key)?.node;
  return n?.type === 'string' ? n.value : null;
}

/** Sets a value, keeping the existing key spelling and position when present. */
export function vdfSet(m: VdfMap, key: string, node: VdfNode): void {
  const e = vdfGet(m, key);
  if (e) e.node = node;
  else m.entries.push({ key, node });
}

export const str = (value: string): VdfNode => ({ type: 'string', value });
export const int = (value: number): VdfNode => ({ type: 'int32', value: value | 0 });

// -------------------------------------------------------------------- text

export interface TextVdf {
  [key: string]: string | TextVdf;
}

/** Parses text KeyValues. Duplicate keys: the last one wins. Conditionals ([$WIN32]) are ignored. */
export function parseTextVdf(text: string): TextVdf {
  let pos = 0;
  const skip = () => {
    for (;;) {
      while (pos < text.length && /\s/.test(text[pos])) pos++;
      if (text.startsWith('//', pos)) {
        const nl = text.indexOf('\n', pos);
        pos = nl < 0 ? text.length : nl + 1;
      } else return;
    }
  };
  const token = (): string | null => {
    skip();
    if (pos >= text.length) return null;
    const ch = text[pos];
    if (ch === '{' || ch === '}') {
      pos++;
      return ch;
    }
    if (ch === '"') {
      pos++;
      let out = '';
      while (pos < text.length && text[pos] !== '"') {
        if (text[pos] === '\\' && pos + 1 < text.length) {
          const n = text[pos + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          pos += 2;
        } else out += text[pos++];
      }
      pos++;
      return out;
    }
    const start = pos;
    while (pos < text.length && !/[\s{}"]/.test(text[pos])) pos++;
    return text.slice(start, pos);
  };
  const block = (depth: number): TextVdf => {
    const obj: TextVdf = {};
    for (;;) {
      const key = token();
      if (key === null || key === '}') {
        if (key === null && depth > 0) throw new VdfError('unexpected end of file');
        return obj;
      }
      if (key === '{') throw new VdfError(`unexpected "{" at ${pos}`);
      const value = token();
      if (value === null) throw new VdfError('unexpected end of file');
      obj[key] = value === '{' ? block(depth + 1) : value;
      // Skip an optional conditional such as [$WIN32].
      skip();
      if (text[pos] === '[') pos = Math.max(pos, text.indexOf(']', pos) + 1);
    }
  };
  return block(0);
}

/** Case-insensitive member lookup in a text VDF object. */
export function textGet(obj: TextVdf | undefined, key: string): string | TextVdf | undefined {
  if (!obj) return undefined;
  const k = key.toLowerCase();
  const found = Object.keys(obj).find((x) => x.toLowerCase() === k);
  return found === undefined ? undefined : obj[found];
}
