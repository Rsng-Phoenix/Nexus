import type { Priority } from '../types';
import { PRIORITY_META } from '../types';
import type { ShareDoc, ShareLine } from './doc';

/**
 * Draws a ShareDoc: a dark, branded card for sharing as an image, or light A4 pages for the PDF.
 * Everything is drawn with the device's own fonts, so any script, ₹ and emoji come out right
 * (the old PDF used a built-in font that turned them into garbage).
 */

const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Devanagari', 'Helvetica Neue', Arial, sans-serif`;
const ACCENT_FALLBACK = '#7C6CFF';

type Theme = {
  bg: string;
  text: string;
  sub: string;
  faint: string;
  line: string;
  chipBg: (accent: string) => string;
  chipText: (accent: string) => string;
  glow: boolean;
};

const DARK: Theme = {
  bg: '#0D0E18',
  text: '#F4F5FB',
  sub: 'rgba(244,245,251,0.72)',
  faint: 'rgba(244,245,251,0.42)',
  line: 'rgba(255,255,255,0.10)',
  chipBg: (a) => hexA(a, 0.18),
  chipText: (a) => a,
  glow: true
};
const LIGHT: Theme = {
  bg: '#FFFFFF',
  text: '#15161F',
  sub: '#4A4C5C',
  faint: '#8A8C99',
  line: '#E6E7EE',
  chipBg: (a) => hexA(a, 0.12),
  chipText: (a) => darken(a),
  glow: false
};

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function darken(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * 0.72);
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

// The Nexus mark (ui/nexus-logo.ts) as canvas paths.
const LOGO: { d: string; stroke?: string; fill?: string }[] = [
  { d: 'M256,32 A224,224 0 0,1 420,92', stroke: '#00C6FF' },
  { d: 'M420,92 A224,224 0 0,1 480,256', stroke: '#00FF94' },
  { d: 'M480,256 A224,224 0 0,1 420,420', stroke: '#FFD600' },
  { d: 'M420,420 A224,224 0 0,1 256,480', stroke: '#FF6A00' },
  { d: 'M256,480 A224,224 0 0,1 92,420', stroke: '#FF3D6B' },
  { d: 'M92,420 A224,224 0 0,1 32,256', stroke: '#4A90E2' },
  { d: 'M32,256 A224,224 0 0,1 92,92', stroke: '#00C48C' },
  { d: 'M92,92 A224,224 0 0,1 256,32', stroke: '#00C6FF' },
  { d: 'M256,40 L40,256 L256,256 Z', fill: '#FF3D6B' },
  { d: 'M256,40 L472,256 L256,256 Z', fill: '#FFA500' },
  { d: 'M40,256 L256,472 L256,256 Z', fill: '#00C48C' },
  { d: 'M472,256 L256,472 L256,256 Z', fill: '#4A90E2' }
];

function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 512, size / 512);
  for (const p of LOGO) {
    const path = new Path2D(p.d);
    if (p.fill) {
      ctx.fillStyle = p.fill;
      ctx.fill(path);
    } else {
      ctx.strokeStyle = p.stroke!;
      ctx.lineWidth = 20;
      ctx.stroke(path);
    }
  }
  ctx.restore();
}

/** Word wrap that also breaks words longer than the line (links, long numbers, no-space scripts). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  const fits = (s: string) => ctx.measureText(s).width <= width;
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (fits(line + word)) {
        line += word;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = word.trimStart();
      // A single word wider than the line: break it.
      while (line && !fits(line)) {
        let cut = line.length - 1;
        while (cut > 1 && !fits(line.slice(0, cut))) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out.length ? out : [''];
}

type Metrics = { W: number; pad: number; logo: number; brand: number; title: number; titleLH: number; chip: number; chipH: number; body: number; bodyLH: number; box: number; indent: number; gap: number; small: number };

const CARD: Metrics = { W: 1080, pad: 76, logo: 46, brand: 24, title: 60, titleLH: 72, chip: 26, chipH: 52, body: 34, bodyLH: 50, box: 34, indent: 44, gap: 22, small: 24 };
const PAGE: Metrics = { W: 1240, pad: 104, logo: 44, brand: 22, title: 56, titleLH: 68, chip: 24, chipH: 48, body: 30, bodyLH: 46, box: 30, indent: 40, gap: 20, small: 22 };
const PAGE_H = 1754; // A4 at 150 dpi

type Row = { h: number; draw: (ctx: CanvasRenderingContext2D, y: number) => void };

/** Everything below the header as rows, each knowing its height (so pages break between rows). */
function rows(doc: ShareDoc, m: Metrics, t: Theme, accent: string): Row[] {
  const meas = document.createElement('canvas').getContext('2d')!;
  const out: Row[] = [];
  const bodyFont = (bold = false) => `${bold ? '600 ' : ''}${m.body}px ${FONT}`;

  const textRow = (text: string, x: number, opts: { color: string; bold?: boolean; strike?: boolean; marker?: (ctx: CanvasRenderingContext2D, y: number) => void }) => {
    meas.font = bodyFont(opts.bold);
    const lines = wrap(meas, text, m.W - m.pad - x);
    return {
      h: lines.length * m.bodyLH + 10,
      draw: (ctx: CanvasRenderingContext2D, y: number) => {
        opts.marker?.(ctx, y);
        ctx.font = bodyFont(opts.bold);
        ctx.fillStyle = opts.color;
        ctx.textBaseline = 'alphabetic';
        lines.forEach((l, i) => {
          const by = y + m.body + i * m.bodyLH;
          ctx.fillText(l, x, by);
          if (opts.strike) {
            const w = ctx.measureText(l).width;
            ctx.fillRect(x, by - m.body * 0.32, w, Math.max(2, m.body / 14));
          }
        });
      }
    };
  };

  const checkbox = (x: number, checked: boolean, color: string) => (ctx: CanvasRenderingContext2D, y: number) => {
    const s = m.box;
    const top = y + (m.body - s) / 2 + 4;
    ctx.beginPath();
    ctx.roundRect(x, top, s, s, s * 0.28);
    if (checked) {
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = s / 9;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x + s * 0.26, top + s * 0.52);
      ctx.lineTo(x + s * 0.44, top + s * 0.7);
      ctx.lineTo(x + s * 0.76, top + s * 0.32);
      ctx.stroke();
    } else {
      ctx.strokeStyle = hexA(color, 0.9);
      ctx.lineWidth = s / 12;
      ctx.stroke();
    }
  };

  for (const l of doc.lines as ShareLine[]) {
    if (l.kind === 'gap') {
      out.push({ h: m.gap, draw: () => {} });
      continue;
    }
    const x0 = m.pad + ('indent' in l ? l.indent * m.indent : 0);
    if (l.kind === 'check') {
      out.push(textRow(l.text, x0 + m.box + 20, { color: l.checked ? t.faint : t.text, strike: l.checked, marker: checkbox(x0, l.checked, accent) }));
    } else if (l.kind === 'task') {
      const c = l.priority ? PRIORITY_META[l.priority].color : accent;
      const row = textRow(l.text, x0 + m.box + 20, { color: l.done ? t.faint : t.text, strike: l.done, marker: checkbox(x0, l.done, c) });
      if (l.due) {
        const due = l.due;
        out.push({
          h: row.h + m.small + 6,
          draw: (ctx, y) => {
            row.draw(ctx, y);
            ctx.font = `${m.small}px ${FONT}`;
            ctx.fillStyle = t.faint;
            ctx.fillText(`Due ${due}`, x0 + m.box + 20, y + row.h + m.small - 4);
          }
        });
      } else out.push(row);
    } else if (l.kind === 'bullet') {
      out.push(
        textRow(l.text, x0 + 34, {
          color: t.text,
          marker: (ctx, y) => {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.arc(x0 + 9, y + m.body * 0.62, m.body / 6.5, 0, Math.PI * 2);
            ctx.fill();
          }
        })
      );
    } else if (l.kind === 'num') {
      const label = `${l.n}.`;
      out.push(
        textRow(l.text, x0 + 50, {
          color: t.text,
          marker: (ctx, y) => {
            ctx.font = `700 ${m.body}px ${FONT}`;
            ctx.fillStyle = accent;
            ctx.fillText(label, x0, y + m.body);
          }
        })
      );
    } else out.push(textRow(l.text, x0, { color: t.sub, bold: l.bold }));
  }
  return out;
}

/** Brand line, title and chips; returns the height used. */
function header(ctx: CanvasRenderingContext2D, doc: ShareDoc, m: Metrics, t: Theme, accent: string, draw: boolean): number {
  let y = m.pad;
  if (draw) {
    drawLogo(ctx, m.pad, y, m.logo);
    ctx.font = `800 ${m.brand}px ${FONT}`;
    ctx.fillStyle = t.sub;
    ctx.textBaseline = 'middle';
    const spaced = 'N E X U S';
    ctx.fillText(spaced, m.pad + m.logo + 18, y + m.logo / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }
  y += m.logo + 40;
  ctx.font = `800 ${m.title}px ${FONT}`;
  const titleLines = wrap(ctx, doc.title, m.W - m.pad * 2).slice(0, 6);
  titleLines.forEach((l, i) => {
    if (draw) {
      ctx.fillStyle = t.text;
      ctx.fillText(l, m.pad, y + m.title + i * m.titleLH - 8);
    }
  });
  y += titleLines.length * m.titleLH + 22;
  // Chips, wrapping onto more rows when needed.
  ctx.font = `600 ${m.chip}px ${FONT}`;
  let x = m.pad;
  doc.meta.forEach((label, i) => {
    const w = ctx.measureText(label).width + m.chipH * 0.9;
    if (x + w > m.W - m.pad && x > m.pad) {
      x = m.pad;
      y += m.chipH + 12;
    }
    if (draw) {
      const c = i === 0 ? accent : t === DARK ? '#FFFFFF' : '#5B5D6B';
      ctx.fillStyle = i === 0 ? t.chipBg(accent) : t === DARK ? 'rgba(255,255,255,0.08)' : '#F1F2F6';
      ctx.beginPath();
      ctx.roundRect(x, y, w, m.chipH, m.chipH / 2);
      ctx.fill();
      ctx.fillStyle = i === 0 ? t.chipText(c) : t === DARK ? 'rgba(255,255,255,0.82)' : c;
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + m.chipH * 0.45, y + m.chipH / 2 + 1);
      ctx.textBaseline = 'alphabetic';
    }
    x += w + 12;
  });
  if (doc.meta.length) y += m.chipH;
  y += 34;
  if (draw) {
    ctx.fillStyle = t.line;
    ctx.fillRect(m.pad, y, m.W - m.pad * 2, 2);
  }
  return y + 34;
}

function paintBackground(ctx: CanvasRenderingContext2D, w: number, h: number, t: Theme, accent: string) {
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, w, h);
  if (t.glow) {
    const g = ctx.createRadialGradient(w * 0.1, 0, 0, w * 0.1, 0, w * 0.95);
    g.addColorStop(0, hexA(accent, 0.3));
    g.addColorStop(1, hexA(accent, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  // Accent edge.
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, w, t.glow ? 10 : 14);
}

const accentOf = (p?: Priority) => (p ? PRIORITY_META[p].color : ACCENT_FALLBACK);

/** The image: one tall dark card. */
export function renderShareCard(doc: ShareDoc): HTMLCanvasElement {
  const m = CARD;
  const accent = accentOf(doc.priority);
  const meas = document.createElement('canvas').getContext('2d')!;
  const top = header(meas, doc, m, DARK, accent, false);
  const body = rows(doc, m, DARK, accent);
  const footer = 110;
  const h = Math.min(16000, Math.max(640, top + body.reduce((s, r) => s + r.h, 0) + footer));
  const c = document.createElement('canvas');
  c.width = m.W;
  c.height = h;
  const ctx = c.getContext('2d')!;
  paintBackground(ctx, m.W, h, DARK, accent);
  let y = header(ctx, doc, m, DARK, accent, true);
  for (const r of body) {
    if (y + r.h > h - footer) break;
    r.draw(ctx, y);
    y += r.h;
  }
  ctx.font = `${m.small}px ${FONT}`;
  ctx.fillStyle = DARK.faint;
  ctx.fillText('Shared from Nexus', m.pad, h - m.pad + 20);
  return c;
}

/** The PDF: light A4 pages, breaking between lines, "page 1 of 3" at the bottom. */
export function renderSharePages(doc: ShareDoc): HTMLCanvasElement[] {
  const m = PAGE;
  const accent = accentOf(doc.priority);
  const body = rows(doc, m, LIGHT, accent);
  const bottom = PAGE_H - 150;
  const pages: HTMLCanvasElement[] = [];
  const newPage = () => {
    const c = document.createElement('canvas');
    c.width = m.W;
    c.height = PAGE_H;
    const ctx = c.getContext('2d')!;
    paintBackground(ctx, m.W, PAGE_H, LIGHT, accent);
    pages.push(c);
    return ctx;
  };
  let ctx = newPage();
  let y = header(ctx, doc, m, LIGHT, accent, true);
  for (const r of body) {
    if (y + r.h > bottom && y > m.pad + 10) {
      ctx = newPage();
      y = m.pad + 20;
    }
    r.draw(ctx, y);
    y += r.h;
  }
  pages.forEach((c, i) => {
    const p = c.getContext('2d')!;
    p.font = `${m.small}px ${FONT}`;
    p.fillStyle = LIGHT.faint;
    p.fillText('Shared from Nexus', m.pad, PAGE_H - 80);
    const label = `${i + 1} / ${pages.length}`;
    p.fillText(label, m.W - m.pad - p.measureText(label).width, PAGE_H - 80);
  });
  return pages;
}

// ─── PDF file ────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

/** A4 pages as JPEG images in a small, valid PDF (correct byte offsets, document title set). */
export async function pagesToPdf(pages: HTMLCanvasElement[], title: string): Promise<Blob> {
  const jpegs: Uint8Array[] = [];
  for (const c of pages) {
    const b = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.9));
    if (!b) throw new Error('Could not draw the PDF');
    jpegs.push(new Uint8Array(await b.arrayBuffer()));
  }
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const put = (x: string | Uint8Array) => {
    const bytes = typeof x === 'string' ? enc.encode(x) : x;
    chunks.push(bytes);
    pos += bytes.length;
  };
  const obj = (n: number, body: () => void) => {
    offsets[n] = pos;
    put(`${n} 0 obj\n`);
    body();
    put('\nendobj\n');
  };
  const W = 595.28;
  const H = 841.89;
  const n = pages.length;
  // 1 catalog, 2 pages, 3 info, then per page: page, contents, image.
  const pageObj = (i: number) => 4 + i * 3;
  // PDF text strings: UTF-16BE with BOM, so any title is kept.
  const pdfString = (s: string) => {
    let hex = 'FEFF';
    for (const ch of s.slice(0, 200)) {
      const cp = ch.codePointAt(0)!;
      const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
      for (const u of units) hex += u.toString(16).padStart(4, '0').toUpperCase();
    }
    return `<${hex}>`;
  };
  put('%PDF-1.4\n%âãÏÓ\n');
  obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => put(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`));
  obj(3, () => put(`<< /Title ${pdfString(title)} /Creator (Nexus) /Producer (Nexus) >>`));
  pages.forEach((c, i) => {
    const p = pageObj(i);
    obj(p, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${p + 1} 0 R /Resources << /XObject << /Im${i} ${p + 2} 0 R >> >> >>`));
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q`;
    obj(p + 1, () => put(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(p + 2, () => {
      put(`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegs[i].length} >>\nstream\n`);
      put(jpegs[i]);
      put('\nendstream');
    });
  });
  const total = 4 + n * 3;
  const xref = pos;
  put(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let k = 1; k < total; k++) put(`${String(offsets[k]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}
