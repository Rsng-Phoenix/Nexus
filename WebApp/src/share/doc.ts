import { hasDeadline, isoToDate } from '../calendar/deadline';
import { fromStorage, numberedIndexInRun, type NoteBlock } from '../notes/codec';
import type { Priority, Task } from '../types';
import { PRIORITY_META } from '../types';

/**
 * What gets shared, independent of the format: text, image and PDF are all drawn from this, so
 * they always say the same thing. Dates are written out in full ("Fri 26 Sep 2026"), never
 * "tomorrow": whoever receives it may read it days later. Identical on Android (ShareHelper.kt).
 */
export type ShareLine =
  | { kind: 'text'; text: string; indent: number; bold: boolean }
  | { kind: 'check'; text: string; checked: boolean; indent: number }
  | { kind: 'bullet'; text: string; indent: number }
  | { kind: 'num'; text: string; n: number; indent: number }
  | { kind: 'task'; text: string; done: boolean; priority?: Priority; due?: string }
  | { kind: 'gap' };

export type ShareDoc = {
  title: string;
  /** Accent colour: the task's (or list's) priority. */
  priority?: Priority;
  /** Small facts under the title: "High priority", "Due Fri 26 Sep 2026", "Done". */
  meta: string[];
  lines: ShareLine[];
};

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 26 Sep 2026" */
export function fullDay(iso: string): string {
  const d = isoToDate(iso);
  return `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]} ${d.getFullYear()}`;
}

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function noteLines(blocks: NoteBlock[]): ShareLine[] {
  const out: ShareLine[] = [];
  blocks.forEach((b, i) => {
    const text = b.text.replace(/\s+$/g, '');
    if (!text.trim()) {
      if (out.length && out[out.length - 1].kind !== 'gap') out.push({ kind: 'gap' });
      return;
    }
    const indent = Math.max(0, Math.min(4, b.indent || 0));
    if (b.type === 'CHECKBOX') out.push({ kind: 'check', text, checked: b.checked, indent });
    else if (b.type === 'BULLET') out.push({ kind: 'bullet', text, indent });
    else if (b.type === 'NUMBERED') out.push({ kind: 'num', text, n: numberedIndexInRun(blocks, i), indent });
    else out.push({ kind: 'text', text, indent, bold: b.bold });
  });
  while (out.length && out[out.length - 1].kind === 'gap') out.pop();
  return out;
}

export function taskShareDoc(t: Task): ShareDoc {
  const meta = [`${PRIORITY_META[t.priority].label} priority`];
  if (hasDeadline(t)) meta.push(`Due ${fullDay(t.dueDate)}`);
  if (t.reminderTime != null) {
    const d = new Date(t.reminderTime);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    meta.push(`Reminder ${fullDay(iso)}, ${timeOf(t.reminderTime)}`);
  }
  if (t.isCompleted) meta.push('Done');
  else if (t.isWontDo) meta.push("Won't do");
  return { title: t.description.trim() || 'Task', priority: t.priority, meta, lines: noteLines(fromStorage(t.notes)) };
}

/** A quadrant's open tasks (FullScreen → Share). */
export function listShareDoc(title: string, priority: Priority, tasks: Task[]): ShareDoc {
  const lines: ShareLine[] = tasks.map((t) => ({
    kind: 'task',
    text: t.description,
    done: t.isCompleted,
    priority: t.priority,
    ...(hasDeadline(t) ? { due: fullDay(t.dueDate) } : {})
  }));
  return { title, priority, meta: [`${tasks.length} task${tasks.length === 1 ? '' : 's'}`], lines: lines.length ? lines : [{ kind: 'text', text: 'No open tasks', indent: 0, bold: false }] };
}

const PRIORITY_DOT: Record<Priority, string> = { HIGH: '🔴', MEDIUM: '🟠', LOW: '🔵', NONE: '🟢' };

/**
 * Chat-friendly text: *bold* title (WhatsApp, Telegram and Slack show it bold, elsewhere it
 * reads fine), one line of facts, then the notes with ☐/☑ ticks and bullets.
 */
export function shareDocText(d: ShareDoc): string {
  const out: string[] = [`*${d.title}*`];
  if (d.meta.length) out.push(`${d.priority ? `${PRIORITY_DOT[d.priority]} ` : ''}${d.meta.join(' · ')}`);
  if (d.lines.length) out.push('');
  for (const l of d.lines) {
    const pad = 'indent' in l ? '   '.repeat(l.indent) : '';
    if (l.kind === 'gap') out.push('');
    else if (l.kind === 'check') out.push(`${pad}${l.checked ? '☑' : '☐'} ${l.text}`);
    else if (l.kind === 'bullet') out.push(`${pad}• ${l.text}`);
    else if (l.kind === 'num') out.push(`${pad}${l.n}. ${l.text}`);
    else if (l.kind === 'task') out.push(`${l.done ? '☑' : '☐'} ${l.text}${l.due ? `  (due ${l.due})` : ''}`);
    else out.push(`${pad}${l.bold ? `*${l.text}*` : l.text}`);
  }
  out.push('', '— Shared from Nexus');
  return out.join('\n');
}

/** File names people can recognise: "Pay GST return.png" (unsafe characters dropped). */
export function shareFileName(d: ShareDoc, ext: string): string {
  const base = d.title.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Nexus';
  return `${base}.${ext}`;
}
