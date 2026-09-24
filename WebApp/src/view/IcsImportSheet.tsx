import { useEffect, useMemo, useState } from 'preact/hooks';
import { isoToDate, todayIso } from '../calendar/deadline';
import { icsEventToTaskUuid, IcsError, nextOccurrence, parseIcs, type IcsDateTime, type IcsEvent } from '../calendar/ics';
import { getSettings } from '../settings/store';
import { importTasks, type ImportRow } from '../state/store';
import { offerUndo, showSnack } from '../state/toasts';
import type { Priority } from '../types';
import { PRIORITIES, PRIORITY_META } from '../types';
import type { LayerProps } from './App';
import { PrimaryButton, Segmented, Sheet } from './kit';

type Row = { ev: IcsEvent; when: IcsDateTime; upcoming: boolean };

const fmt = (w: IcsDateTime) =>
  w.allDay
    ? isoToDate(w.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : new Date(w.time!).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Preview of a .ics file: pick which events become tasks (with a deadline on the event day). */
export function IcsImportSheet(p: LayerProps & { fileName: string; text: string }) {
  const parsed = useMemo(() => {
    try {
      const now = new Date();
      const rows: Row[] = parseIcs(p.text).map((ev) => {
        const next = nextOccurrence(ev, now);
        return { ev, when: next ?? ev.start, upcoming: !!next };
      });
      rows.sort((a, b) => Number(b.upcoming) - Number(a.upcoming) || a.when.date.localeCompare(b.when.date));
      return { rows, error: '' };
    } catch (e) {
      return { rows: [] as Row[], error: e instanceof IcsError ? e.message : 'This file could not be read as a calendar.' };
    }
  }, []);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(parsed.rows.map((r, i) => (r.upcoming ? i : -1)).filter((i) => i >= 0)));
  const [priority, setPriority] = useState<Priority>('MEDIUM');
  const [busy, setBusy] = useState(false);
  const [showPast, setShowPast] = useState(false);

  useEffect(() => {
    if (parsed.error) showSnack(parsed.error);
  }, []);

  const toggle = (i: number) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  const run = async () => {
    setBusy(true);
    const s = getSettings();
    const now = Date.now();
    const rows: ImportRow[] = [];
    for (const i of picked) {
      const { ev, when } = parsed.rows[i];
      rows.push({
        taskUuid: await icsEventToTaskUuid(ev),
        description: (ev.summary || 'Calendar event').slice(0, 500),
        notes: [ev.description, ev.location ? `Location: ${ev.location}` : ''].filter(Boolean).join('\n').slice(0, 5000),
        priority,
        dueDate: when.date,
        dueAlerts: s.defaultDueAlerts,
        dueAlertTime: s.defaultDueAlertTime,
        // A timed event also rings at its start time.
        ...(!when.allDay && when.time && when.time > now ? { reminderTime: when.time, reminderDateOnly: false } : {})
      });
    }
    let r: Awaited<ReturnType<typeof importTasks>>;
    try {
      r = await importTasks(rows);
    } catch (e) {
      setBusy(false);
      showSnack(`Import failed: ${e instanceof Error ? e.message : 'unknown error'}. Nothing was changed.`, undefined, 5000);
      return;
    }
    p.onDismiss();
    const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.skipped && `${r.skipped} unchanged`].filter(Boolean);
    offerUndo(`Imported · ${parts.join(' · ') || 'nothing new'}`, () => void r.undo());
  };

  const visible = parsed.rows.map((r, i) => ({ r, i })).filter(({ r }) => showPast || r.upcoming);
  const pastCount = parsed.rows.filter((r) => !r.upcoming).length;

  return (
    <Sheet leaving={p.leaving} onExited={p.onExited} onDismiss={p.onDismiss} class="nx-import" maxHeight="94%">
      <div class="nx-import-body">
        <h2>Import calendar</h2>
        <p class="lead">
          {p.fileName} · {parsed.rows.length} event{parsed.rows.length === 1 ? '' : 's'}. Each one becomes a task due on its day. Importing the same file
          again updates them instead of making copies.
        </p>
        {parsed.error ? (
          <p class="err">{parsed.error}</p>
        ) : (
          <>
            <div class="nx-import-bar">
              <button class="nx-text-btn press" onClick={() => setPicked(new Set(visible.map((v) => v.i)))}>Select all</button>
              <button class="nx-text-btn press" onClick={() => setPicked(new Set())}>None</button>
              <span class="grow" />
              {pastCount > 0 && (
                <button class="nx-text-btn press" onClick={() => setShowPast(!showPast)}>
                  {showPast ? 'Hide' : 'Show'} {pastCount} past
                </button>
              )}
            </div>
            <ul class="nx-import-list">
              {visible.map(({ r, i }) => (
                <li key={i} class={picked.has(i) ? 'on' : ''} onClick={() => toggle(i)}>
                  <input type="checkbox" class="nx-note-cb" checked={picked.has(i)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(i)} />
                  <span class="txt">
                    <b>{r.ev.summary || '(No title)'}</b>
                    <small>
                      {fmt(r.when)}
                      {r.ev.rrule ? ' · repeats (next one)' : ''}
                      {!r.upcoming ? ' · past' : r.when.date === todayIso() ? ' · today' : ''}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
            <div class="nx-import-foot">
              <span class="lbl">Priority</span>
              <Segmented options={PRIORITIES.map((x) => [x, PRIORITY_META[x].label] as [Priority, string])} value={priority} onChange={setPriority} />
              <PrimaryButton icon="download" onClick={() => void run()} disabled={busy || picked.size === 0}>
                {busy ? 'Importing…' : `Import ${picked.size} task${picked.size === 1 ? '' : 's'}`}
              </PrimaryButton>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
