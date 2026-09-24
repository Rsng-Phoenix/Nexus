/**
 * Tiny SAX-style XML tokenizer for the OOXML parts of an .xlsx (DOMParser is not available in
 * workers or Node). Deliberately small and safe: DTDs are refused, only the five standard
 * entities and numeric character references are decoded, nothing is fetched or expanded.
 * Element names reach the handler without their namespace prefix ("x:c" → "c"); attribute keys
 * are kept as written ("r:id").
 */
export type XmlAttrs = Record<string, string>;

export interface XmlHandler {
  open?(name: string, attrs: XmlAttrs, selfClosing: boolean): void;
  close?(name: string): void;
  text?(text: string): void;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

/** Throw this from a handler to stop parsing early without an error. */
export const STOP_PARSING = Symbol('stop-parsing');

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const ATTR = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY, (_, ent: string) => {
    if (ent[0] !== '#') return NAMED[ent];
    const cp = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
    return valid ? String.fromCodePoint(cp) : '�';
  });
}

export function localName(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

/** Index of the '>' closing the tag that starts after `from`, skipping quoted attribute values. */
function tagEnd(xml: string, from: number): number {
  let quote = '';
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

export function parseXml(xml: string, h: XmlHandler): void {
  try {
    parseInner(xml, h);
  } catch (e) {
    if (e !== STOP_PARSING) throw e;
  }
}

function parseInner(xml: string, h: XmlHandler): void {
  const n = xml.length;
  let i = 0;
  const emitText = (raw: string) => {
    if (h.text && raw) h.text(decodeEntities(raw));
  };
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      emitText(xml.slice(i));
      return;
    }
    if (lt > i) emitText(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      if (e < 0) throw new XmlError('Unterminated comment');
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      if (e < 0) throw new XmlError('Unterminated CDATA section');
      if (h.text && e > lt + 9) h.text(xml.slice(lt + 9, e));
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      if (e < 0) throw new XmlError('Unterminated processing instruction');
      i = e + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) throw new XmlError('DTDs are not allowed');
    const gt = tagEnd(xml, lt + 1);
    if (gt < 0) throw new XmlError('Unterminated tag');
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '/') {
      h.close?.(localName(body.slice(1).trim()));
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const m = /^[^\s/>]+/.exec(inner);
    if (!m) throw new XmlError('Malformed tag');
    const name = localName(m[0]);
    if (h.open) {
      const attrs: XmlAttrs = {};
      const rest = inner.slice(m[0].length);
      ATTR.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = ATTR.exec(rest))) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
      h.open(name, attrs, selfClosing);
    }
    if (selfClosing) h.close?.(name);
  }
}
