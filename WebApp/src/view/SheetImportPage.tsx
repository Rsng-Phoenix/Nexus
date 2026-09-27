import '../styles/calendar.css';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { DUE_OFFSET_CHOICES, formatAlertTime, isoToDate } from '../calendar/deadline';
import { parseDueAlerts } from '../calendar/due';
import { columnLetter, isEmptyRow, type Cell } from '../import/cell';
import { csvRowsToCells, parseCsv } from '../import/csv';
import { detectDayFirst, detectHeaderRow, suggestDateColumn } from '../import/dates';
import { fetchSheetRows, linkSheet, parseSheetUrl, SheetError, sheetFileName, type SheetRef } from '../import/liveSheet';
import { chooseSheetInDrive, pickerAvailable, takePendingSheet } from '../import/picker';
import { buildImportPlan, cellText, type ImportPlan, type ImportPriority } from '../import/plan';
import { readXlsx } from '../import/xlsx';
import { haptic } from '../lib/haptics';
import { getSettings, sheetRefreshLabel } from '../settings/store';
import { allTasks, importTasks } from '../state/store';
import { offerUndo, showSnack } from '../state/toasts';
import type { Priority } from '../types';
import { PRIORITIES, PRIORITY_META } from '../types';
import type { LayerProps } from './App';
import { Icon } from './icons';
import { Page, PageHeader, PrimaryButton, Segmented, Switch } from './kit';
import { TimePicker } from './ReminderWizard';

type Book = { sheets: { name: string; rows: Cell[][]; truncated: boolean }[]; date1904: boolean };
const STEPS = ['Data', 'Columns', 'Alerts', 'Review'] as const;
const PREVIEW_ROWS = 6;

/**
 * Excel / CSV → tasks with deadlines. The file is read on this device only (never uploaded).
 * Every row with a valid date becomes a task due that day; alerts ring on the chosen days.
 * Without a file it starts by asking for a Google Sheet link, which can keep updating its tasks
 * (import/liveSheet.ts).
 */
export function SheetImportPage(p: LayerProps & { file?: File }) {
  const s = getSettings();
  const [book, setBook] = useState<Book | null>(null);
  // Google Sheet source: the pasted link, the parsed address once read, and whether to keep it updating.
  // A link kept across a Google sign-in that left the page (picker.ts) is read again right away.
  const [pendingLink] = useState(() => (p.file ? '' : takePendingSheet()));
  const [sheetLink, setSheetLink] = useState(pendingLink);
  const [sheetRef, setSheetRef] = useState<SheetRef | null>(null);
  const [reading, setReading] = useState(false);
  const [keepUpdating, setKeepUpdating] = useState(true);
  const [sheetName, setSheetName] = useState('');
  const [loadError, setLoadError] = useState('');
  // The sheet is private to its organisation: offer "Choose in Google Drive" (import/picker.ts).
  const [needsPick, setNeedsPick] = useState(false);
  const [picking, setPicking] = useState(false);
  const [step, setStep] = useState(0);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [hasHeader, setHasHeader] = useState(true);
  const [headerRow, setHeaderRow] = useState(0);
  const [titleCols, setTitleCols] = useState<number[]>([]);
  const [titleText, setTitleText] = useState('');
  const [dateCol, setDateCol] = useState(-1);
  const [notesCols, setNotesCols] = useState<number[]>([]);
  const [prioMode, setPrioMode] = useState<'fixed' | 'column'>('fixed');
  const [fixedPrio, setFixedPrio] = useState<Priority>('MEDIUM');
  const [prioCol, setPrioCol] = useState(-1);
  const [dayFirst, setDayFirst] = useState(true);
  const [offsets, setOffsets] = useState<number[]>(parseDueAlerts(s.defaultDueAlerts));
  const [time, setTime] = useState(s.defaultDueAlertTime);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState(false);

  const readSheet = async (link = sheetLink) => {
    const ref = parseSheetUrl(link);
    if (!ref) {
      setLoadError('Paste the link from Google Sheets (Share → Copy link). It starts with https://docs.google.com/spreadsheets/d/…');
      return;
    }
    setLoadError('');
    setNeedsPick(false);
    setReading(true);
    try {
      const rows = await fetchSheetRows(ref);
      if (!rows.some((r) => !isEmptyRow(r))) throw new Error('This sheet tab is empty.');
      setSheetRef(ref);
      setBook({ sheets: [{ name: '', rows, truncated: rows.length >= 5000 }], date1904: false });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'This sheet could not be read.');
      setNeedsPick(e instanceof SheetError && e.needsPick);
    } finally {
      setReading(false);
    }
  };
  useEffect(() => {
    if (pendingLink) void readSheet(pendingLink);
  }, []);

  // "Choose in Google Drive": the Picker grants Nexus this one file, then the sheet is read again.
  const chooseInDrive = async () => {
    const ref = parseSheetUrl(sheetLink);
    if (!ref) return;
    setPicking(true);
    try {
      if (await chooseSheetInDrive(ref, sheetLink)) await readSheet();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Choosing the sheet failed.');
    } finally {
      setPicking(false);
    }
  };

  // Read the file.
  useEffect(() => {
    if (!p.file) return;
    const file = p.file;
    void (async () => {
      try {
        if (file.size > 25 * 1024 * 1024) throw new Error('That file is over 25 MB. Split it or save only the sheet you need.');
        if (/\.xls$/i.test(file.name)) throw new Error('Old .xls files aren’t supported. In Excel choose File → Save As → Excel Workbook (.xlsx).');
        if (/\.(csv|tsv|txt)$/i.test(file.name) || file.type.startsWith('text/')) {
          const r = parseCsv(await file.text());
          setBook({ sheets: [{ name: '', rows: csvRowsToCells(r.rows), truncated: r.truncated }], date1904: false });
        } else {
          const wb = await readXlsx(await file.arrayBuffer());
          const sheets = wb.sheets.filter((x) => !x.hidden && x.rows.some((r) => !isEmptyRow(r)));
          if (!sheets.length) throw new Error('This workbook has no data.');
          setBook({ sheets, date1904: wb.date1904 });
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'This file could not be read.');
      }
    })();
  }, []);

  const sheet = book?.sheets[sheetIdx];
  const rows = sheet?.rows ?? [];
  const hr = hasHeader ? headerRow : -1;
  const width = useMemo(() => rows.reduce((w, r) => Math.max(w, r.length), 0), [rows]);
  const text = (c: Cell | undefined) => cellText(c, { date1904: book?.date1904 });
  const colName = (i: number) => (hr >= 0 && text(rows[hr]?.[i]).trim()) || `Column ${columnLetter(i)}`;
  const sample = (i: number) => {
    for (let r = hr + 1; r < Math.min(rows.length, hr + 30); r++) {
      const t = text(rows[r]?.[i]).trim();
      if (t) return t;
    }
    return '';
  };
  const cols = Array.from({ length: Math.min(width, 200) }, (_, i) => i).filter((i) => rows.some((r, ri) => ri > hr && text(r[i]).trim()));

  // Sensible defaults when the sheet (or header choice) changes.
  useEffect(() => {
    if (!sheet) return;
    const h = detectHeaderRow(sheet.rows);
    setHasHeader(h >= 0);
    setHeaderRow(Math.max(0, h));
  }, [sheet]);
  useEffect(() => {
    if (!sheet) return;
    const d = suggestDateColumn(rows, hr);
    setDateCol(d);
    const textCol = cols.find((c) => c !== d && isNaN(Number(sample(c))) && sample(c).length > 1);
    setTitleCols(textCol != null ? [textCol] : []);
    setNotesCols([]);
    const pc = cols.find((c) => /priority|urgency|importance/i.test(colName(c)));
    setPrioMode(pc != null ? 'column' : 'fixed');
    setPrioCol(pc ?? -1);
  }, [sheet, hr]);
  useEffect(() => {
    if (dateCol < 0) return;
    const vals = rows.slice(hr + 1).map((r) => text(r[dateCol])).filter(Boolean).slice(0, 500);
    const df = detectDayFirst(vals);
    setDayFirst(df === 'ambiguous' ? true : df);
  }, [dateCol, sheet, hr]);
  const ambiguous = useMemo(() => {
    if (dateCol < 0) return false;
    return detectDayFirst(rows.slice(hr + 1).map((r) => text(r[dateCol])).filter(Boolean).slice(0, 500)) === 'ambiguous';
  }, [dateCol, sheet, hr]);

  const priority: ImportPriority = prioMode === 'column' && prioCol >= 0 ? { col: prioCol, fallback: fixedPrio } : fixedPrio;

  // Build the plan for the review step.
  useEffect(() => {
    if (step !== 3 || !sheet) return;
    setPlan(null);
    void buildImportPlan({
      fileName: sheetRef ? sheetFileName(sheetRef) : (p.file?.name ?? ''),
      sheetName: sheetRef ? sheetRef.gid : sheet.name,
      rows,
      headerRow: hr,
      // Left-to-right column order (not tap order), so re-imports give the same ids (as Android).
      titleCols: [...titleCols].sort((a, b) => a - b),
      titleText: titleText.trim(),
      dateCol,
      notesCols: [...notesCols].sort((a, b) => a - b),
      priority,
      offsets,
      alertTime: time,
      dayFirst,
      date1904: book?.date1904,
      existingUuids: new Set(allTasks.value.filter((t) => t.deletedAt === 0).map((t) => t.taskUuid))
    }).then(setPlan);
  }, [step]);

  const canNext = step === 0 ? rows.length > 0 : step === 1 ? (titleCols.length > 0 || titleText.trim() !== '') && dateCol >= 0 : true;
  const toggleIn = (list: number[], v: number) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const run = async () => {
    if (!plan) return;
    setBusy(true);
    haptic('CHECK');
    if (sheetRef && keepUpdating && sheet) {
      try {
        const mapping = {
          headerRow: hr,
          titleCols,
          titleText: titleText.trim(),
          dateCol,
          notesCols,
          priority,
          offsets,
          alertTime: time,
          dayFirst
        };
        const { link, result } = await linkSheet(sheetRef, sheetName, mapping, sheet.rows);
        p.onDismiss();
        const parts = [result.added && `${result.added} added`, result.updated && `${result.updated} updated`].filter(Boolean);
        showSnack(`“${link.name}” linked · ${parts.join(' · ') || 'up to date'} · it keeps updating`, undefined, 5000);
      } catch (e) {
        setBusy(false);
        showSnack(`Linking failed: ${e instanceof Error ? e.message : 'unknown error'}.`, undefined, 5000);
      }
      return;
    }
    let r: Awaited<ReturnType<typeof importTasks>>;
    try {
      r = await importTasks(
      plan.items.map((i) => ({
        taskUuid: i.taskUuid,
        description: i.description.slice(0, 500),
        notes: i.notes.slice(0, 5000),
        priority: i.priority,
        dueDate: i.dueDate,
        dueAlerts: i.dueAlerts,
        dueAlertTime: i.dueAlertTime
      }))
    );
    } catch (e) {
      setBusy(false);
      showSnack(`Import failed: ${e instanceof Error ? e.message : 'unknown error'}. Nothing was changed.`, undefined, 5000);
      return;
    }
    p.onDismiss();
    const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.skipped && `${r.skipped} unchanged`].filter(Boolean);
    offerUndo(`Imported · ${parts.join(' · ') || 'nothing new'}`, () => void r.undo());
  };

  const body = (() => {
    if (!p.file && !book)
      return (
        <div class="nx-imp-link">
          <p class="lead">Paste the link to a Google Sheet. Each row with a date becomes a task, and Nexus keeps them updated as the sheet changes.</p>
          <input
            class="nx-input"
            type="url"
            inputMode="url"
            placeholder="https://docs.google.com/spreadsheets/d/…"
            value={sheetLink}
            onInput={(e) => setSheetLink(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && void readSheet()}
            aria-label="Google Sheet link"
          />
          {loadError && <p class="err">{loadError}</p>}
          {needsPick && pickerAvailable() ? (
            <PrimaryButton icon="cloud" disabled={picking || reading} onClick={() => void chooseInDrive()}>
              {picking ? 'Waiting for Google Drive…' : 'Choose in Google Drive'}
            </PrimaryButton>
          ) : (
            <PrimaryButton icon="link" disabled={reading || !sheetLink.trim()} onClick={() => void readSheet()}>
              {reading ? 'Reading…' : 'Read sheet'}
            </PrimaryButton>
          )}
          <p class="hint">
            The sheet must be shared as “Anyone with the link” (Viewer): in Google Sheets, Share → General access. Nexus reads it straight from
            Google on this device; to open the tab you want, copy the link while that tab is showing.
            {needsPick && pickerAvailable() && ' A sheet that’s private to your organisation can’t be shared that way: choose it in Google Drive once instead, and Nexus (here and on your phone) reads it with your account.'}
          </p>
          {needsPick && !pickerAvailable() && import.meta.env.DEV && <p class="hint">Org-restricted sheets need the Google Picker key (see config.ts).</p>}
        </div>
      );
    if (loadError) return <p class="err">{loadError}</p>;
    if (!book || !sheet) return <p class="lead">Reading {p.file?.name}…</p>;
    if (step === 0)
      return (
        <>
          {book.sheets.length > 1 && (
            <div class="nx-imp-field">
              <span class="lbl">Sheet</span>
              <div class="nx-imp-chips">
                {book.sheets.map((sh, i) => (
                  <button key={sh.name} class={`nx-imp-chip press ${i === sheetIdx ? 'on' : ''}`} onClick={() => setSheetIdx(i)}>
                    {sh.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label class="nx-imp-switch">
            <span>
              <b>First row is the header</b>
              <small>{hasHeader ? `Row ${headerRow + 1} names the columns` : 'Every row is data'}</small>
            </span>
            <Switch checked={hasHeader} onChange={setHasHeader} label="First row is the header" />
          </label>
          <PreviewTable rows={rows} hr={hr} cols={cols} colName={colName} text={text} />
          <p class="hint">
            {rows.length - (hr + 1)} rows{sheet.truncated ? ' (only the first 5,000 are read)' : ''} · {p.file ? 'the file stays on this device' : 'read from Google Sheets on this device'}.
          </p>
        </>
      );
    if (step === 1)
      return (
        <>
          <div class="nx-imp-field">
            <span class="lbl">Same title for every row (optional)</span>
            <input
              class="nx-input"
              placeholder="e.g. Appointment"
              maxLength={80}
              value={titleText}
              onInput={(e) => setTitleText(e.currentTarget.value)}
              aria-label="Same title for every row"
            />
            <p class="hint">Every task starts with these words. Leave empty to use columns only; rows on the same day then become one task that lists them all.</p>
          </div>
          <ColumnPicker
            label={titleText.trim() ? 'Add to the title (optional)' : 'Task title'}
            hint={titleText.trim() ? `Shown after “${titleText.trim()}”, joined with “·”` : 'Pick one or more — they’re joined with “·”'}
            cols={cols}
            colName={colName}
            sample={sample}
            selected={titleCols}
            onToggle={(c) => setTitleCols(toggleIn(titleCols, c))}
          />
          <ColumnPicker label="Date" hint="Each row is reminded around this date" cols={cols} colName={colName} sample={sample} selected={dateCol >= 0 ? [dateCol] : []} onToggle={(c) => setDateCol(c)} />
          {ambiguous && (
            <label class="nx-imp-switch">
              <span>
                <b>Dates are day first</b>
                <small>{dayFirst ? '03/10 means 3 October' : '03/10 means March 10'}</small>
              </span>
              <Switch checked={dayFirst} onChange={setDayFirst} label="Dates are day first" />
            </label>
          )}
          <ColumnPicker label="Notes (optional)" hint="Added to the description as “Column: value”" cols={cols.filter((c) => !titleCols.includes(c) && c !== dateCol)} colName={colName} sample={sample} selected={notesCols} onToggle={(c) => setNotesCols(toggleIn(notesCols, c))} />
          <div class="nx-imp-field">
            <span class="lbl">Priority</span>
            <Segmented options={[['fixed', 'Same for all'], ['column', 'From a column']]} value={prioMode} onChange={setPrioMode} />
            {prioMode === 'fixed' ? (
              <Segmented options={PRIORITIES.map((x) => [x, PRIORITY_META[x].label] as [Priority, string])} value={fixedPrio} onChange={setFixedPrio} />
            ) : (
              <div class="nx-imp-chips">
                {cols.map((c) => (
                  <button key={c} class={`nx-imp-chip press ${c === prioCol ? 'on' : ''}`} onClick={() => setPrioCol(c)}>
                    {colName(c)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      );
    if (step === 2)
      return (
        <>
          <div class="nx-imp-field">
            <span class="lbl">Remind me</span>
            <div class="nx-imp-chips">
              {DUE_OFFSET_CHOICES.map((c) => (
                <button key={c.offset} role="checkbox" aria-checked={offsets.includes(c.offset)} class={`nx-imp-chip press ${offsets.includes(c.offset) ? 'on' : ''}`} onClick={() => setOffsets(toggleIn(offsets, c.offset).sort((a, b) => a - b))}>
                  {c.label}
                </button>
              ))}
            </div>
            <p class="hint">
              Each row gets its own task. When several rows share a date, their alerts arrive together in one notification that lists every task.
            </p>
          </div>
          <div class="nx-imp-field">
            <span class="lbl">At</span>
            <TimePicker hour24={Math.floor(time / 60)} minute={time % 60} onChange={(h, m) => setTime(h * 60 + m)} />
          </div>
        </>
      );
    if (!plan) return <p class="lead">Checking rows…</p>;
    const updates = plan.items.filter((i) => i.exists).length;
    return (
      <>
        <div class="nx-imp-stats">
          <div><b>{plan.items.length - updates}</b><span>new tasks</span></div>
          <div><b>{updates}</b><span>already here · will update</span></div>
          <div class={plan.invalid.length ? 'warn' : ''}><b>{plan.invalid.length}</b><span>rows skipped</span></div>
          {plan.duplicates > 0 && <div><b>{plan.duplicates}</b><span>rows with the same title and date combined (their notes kept)</span></div>}
        </div>
        {sheetRef && (
          <div class="nx-imp-keep">
            <label class="nx-imp-switch">
              <span>
                <b>Keep updating from this sheet</b>
                <small>
                  {keepUpdating
                    ? s.sheetRefreshMinutes === 0
                      ? 'Updates when you tap Update now in Settings (you chose no automatic reads); your ticks and edits stay'
                      : `New and changed rows update their tasks every ${sheetRefreshLabel(s.sheetRefreshMinutes)} while Nexus is open; your ticks and edits stay`
                    : 'Import once, like a file'}
                </small>
              </span>
              <Switch checked={keepUpdating} onChange={setKeepUpdating} label="Keep updating from this sheet" />
            </label>
            {keepUpdating && (
              <input class="nx-input" placeholder="Name (e.g. RTO tracker)" value={sheetName} maxLength={60} onInput={(e) => setSheetName(e.currentTarget.value)} aria-label="Name for this sheet" />
            )}
          </div>
        )}
        <p class="hint">
          Alerts: {offsets.length ? offsets.map((o) => DUE_OFFSET_CHOICES.find((c) => c.offset === o)?.label ?? `${o} d`).join(', ') : 'none'} at {formatAlertTime(time)}.
        </p>
        <ul class="nx-import-list compact">
          {plan.items.slice(0, 50).map((i) => (
            <li key={i.taskUuid} style={{ '--c': PRIORITY_META[i.priority].color } as never}>
              <span class="pdot" />
              <span class="txt">
                <b>{i.description}</b>
                <small>
                  {isoToDate(i.dueDate).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                  {i.exists ? ' · update' : ''}
                </small>
              </span>
            </li>
          ))}
          {plan.items.length > 50 && <li class="more">…and {plan.items.length - 50} more</li>}
        </ul>
        {plan.invalid.length > 0 && (
          <details class="nx-imp-invalid">
            <summary>Skipped rows ({plan.invalid.length})</summary>
            <ul>
              {plan.invalid.slice(0, 100).map((r) => (
                <li key={r.rowIndex}>Row {r.rowIndex + 1}: {r.reason}</li>
              ))}
            </ul>
          </details>
        )}
      </>
    );
  })();

  return (
    <Page leaving={p.leaving} onExited={p.onExited} onDismiss={p.onDismiss} class="nx-imp">
      <PageHeader title={p.file ? 'Import from a sheet' : 'Link a Google Sheet'} subtitle={p.file?.name ?? (sheetRef ? 'Google Sheets' : undefined)} onBack={() => (step > 0 ? setStep(step - 1) : p.onDismiss())} />
      <div class="nx-imp-steps" role="list">
        {STEPS.map((label, i) => (
          <span key={label} role="listitem" class={i === step ? 'on' : i < step ? 'done' : ''}>
            <i>{i < step ? <Icon name="check" size={12} /> : i + 1}</i>
            {label}
          </span>
        ))}
      </div>
      <div class="nx-page-scroll narrow nx-imp-body">{body}</div>
      {!loadError && book && (
        <div class="nx-imp-actions">
          <button class="nx-text-btn press" onClick={() => (step > 0 ? setStep(step - 1) : p.onDismiss())}>
            {step > 0 ? 'Back' : 'Cancel'}
          </button>
          <span class="grow" />
          {step < 3 ? (
            <PrimaryButton onClick={() => setStep(step + 1)} disabled={!canNext}>
              Next
            </PrimaryButton>
          ) : (
            <PrimaryButton icon="download" onClick={() => void run()} disabled={busy || !plan || plan.items.length === 0}>
              {busy ? 'Importing…' : sheetRef && keepUpdating ? `Link and import ${plan?.items.length ?? ''} tasks` : `Import ${plan?.items.length ?? ''} tasks`}
            </PrimaryButton>
          )}
        </div>
      )}
    </Page>
  );
}

function PreviewTable({ rows, hr, cols, colName, text }: {
  rows: Cell[][];
  hr: number;
  cols: number[];
  colName: (i: number) => string;
  text: (c: Cell | undefined) => string;
}) {
  const shown = cols.slice(0, 12);
  const body = rows.slice(hr + 1, hr + 1 + PREVIEW_ROWS);
  return (
    <div class="nx-imp-table-wrap">
      <table class="nx-imp-table">
        <thead>
          <tr>
            {shown.map((c) => (
              <th key={c}>{colName(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {shown.map((c) => (
                <td key={c}>{text(r[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ColumnPicker({ label, hint, cols, colName, sample, selected, onToggle }: {
  label: string;
  hint: string;
  cols: number[];
  colName: (i: number) => string;
  sample: (i: number) => string;
  selected: number[];
  onToggle: (c: number) => void;
}) {
  return (
    <div class="nx-imp-field">
      <span class="lbl">{label}</span>
      <div class="nx-imp-cols">
        {cols.map((c) => (
          <button key={c} class={`nx-imp-col press ${selected.includes(c) ? 'on' : ''}`} aria-pressed={selected.includes(c)} onClick={() => onToggle(c)}>
            <b>{colName(c)}</b>
            <small>{sample(c) || '—'}</small>
          </button>
        ))}
      </div>
      <p class="hint">{hint}</p>
    </div>
  );
}
