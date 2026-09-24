import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { dateToIso, DUE_OFFSET_CHOICES, formatAlertTime, isoToDate, offsetLabel } from '../calendar/deadline';
import { formatDueAlerts, isIsoDate, parseDueAlerts } from '../calendar/due';
import { haptic } from '../lib/haptics';
import { settingsSig } from '../settings/store';
import { allTasks, updateTask } from '../state/store';
import { offerUndo } from '../state/toasts';
import type { LayerProps } from './App';
import { animate, BOUNCY, STANDARD, useEnterExit } from './motion';
import { Calendar, DateHeader, TimePicker } from './ReminderWizard';

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/**
 * Deadline picker: the due day, which days before/after to be alerted, and at what time.
 * One screen (no steps): everything a deadline needs is visible at once.
 */
export function DeadlineSheet(p: LayerProps & { taskId: number; presetDate?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  useEnterExit(
    box,
    p.leaving,
    p.onExited,
    [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'scale(1)' }],
    [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.96)' }],
    { duration: 300, easing: BOUNCY },
    { duration: 170, easing: STANDARD }
  );
  useLayoutEffect(() => {
    animate(scrim.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: STANDARD });
  }, []);
  useLayoutEffect(() => {
    if (p.leaving) animate(scrim.current, [{ opacity: 1 }, { opacity: 0 }], { duration: 170, easing: STANDARD });
  }, [p.leaving]);

  const s = settingsSig.value;
  const task = allTasks.value.find((t) => t.id === p.taskId);
  const init = useMemo(() => {
    const has = task && isIsoDate(task.dueDate);
    const iso = p.presetDate && isIsoDate(p.presetDate) ? p.presetDate : has ? task!.dueDate : dateToIso(new Date(new Date().setDate(new Date().getDate() + 1)));
    return {
      day: isoToDate(iso).getTime(),
      offsets: has && task!.dueAlerts ? parseDueAlerts(task!.dueAlerts) : parseDueAlerts(s.defaultDueAlerts),
      time: has ? task!.dueAlertTime : s.defaultDueAlertTime,
      existing: has ? isoToDate(task!.dueDate).getTime() : null
    };
  }, []);
  const [day, setDay] = useState(init.day);
  const [offsets, setOffsets] = useState<number[]>(init.offsets);
  const [time, setTime] = useState(init.time);
  const today = startOfDay(Date.now());

  if (!task) return null;

  const toggle = (o: number) => {
    haptic('DRAG_TICK');
    setOffsets((cur) => (cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o].sort((a, b) => a - b)));
  };

  const save = () => {
    haptic('CHECK');
    void updateTask({ ...task, dueDate: dateToIso(new Date(day)), dueAlerts: formatDueAlerts(offsets), dueAlertTime: time });
    p.onDismiss();
  };
  const remove = () => {
    const before = task;
    void updateTask({ ...task, dueDate: '', dueAlerts: '' });
    offerUndo('Deadline removed', () => void updateTask({ ...before, updatedAt: Date.now() }));
    p.onDismiss();
  };

  const quick = [
    { label: 'Today', day: today },
    { label: 'Tomorrow', day: new Date(new Date(today).setDate(new Date(today).getDate() + 1)).getTime() },
    { label: 'In a week', day: new Date(new Date(today).setDate(new Date(today).getDate() + 7)).getTime() },
    { label: 'End of month', day: new Date(new Date(today).getFullYear(), new Date(today).getMonth() + 1, 0).getTime() }
  ];

  // Alerts that fall before now can never ring: show them as such.
  const alertMs = (o: number) => {
    const d = new Date(day);
    d.setDate(d.getDate() + o);
    d.setHours(Math.floor(time / 60), time % 60, 0, 0);
    return d.getTime();
  };

  return (
    <div class="nx-rw-wrap" data-leaving={p.leaving || undefined}>
      <div ref={scrim} class="nx-scrim nx-rw-scrim" onClick={p.onDismiss} />
      <div ref={box} class="nx-rw-card nx-dl-card" role="dialog" aria-modal="true" aria-label="Set deadline">
        <div class="nx-rw-content nx-dl-content">
          <h2 class="nx-rw-title">Deadline</h2>
          <div class="nx-dl-task">{task.description}</div>
          <div class="nx-dl-cols">
            <div class="nx-dl-col">
              <DateHeader label="Due on" value={day} />
              <div class="nx-dl-quick">
                {quick.map((q) => (
                  <button key={q.label} class={`nx-rw-chip press ${startOfDay(q.day) === day ? 'sel' : ''}`} onClick={() => setDay(startOfDay(q.day))}>
                    <span>{q.label}</span>
                  </button>
                ))}
              </div>
              <Calendar value={day} onChange={setDay} isDisabled={(d) => d < today && d !== init.existing} />
            </div>
            <div class="nx-dl-col">
              <div class="nx-rw-sub">Remind me</div>
              <div class="nx-dl-offsets" role="group" aria-label="Deadline alerts">
                {DUE_OFFSET_CHOICES.map((c) => {
                  const on = offsets.includes(c.offset);
                  const past = alertMs(c.offset) < Date.now();
                  return (
                    <button
                      key={c.offset}
                      role="checkbox"
                      aria-checked={on}
                      class={`nx-rw-chip press ${on ? 'sel' : ''} ${past ? 'past' : ''}`}
                      title={past ? 'This alert time has already passed' : undefined}
                      onClick={() => toggle(c.offset)}
                    >
                      <span>{c.label}</span>
                    </button>
                  );
                })}
              </div>
              {offsets.some((o) => !DUE_OFFSET_CHOICES.some((c) => c.offset === o)) && (
                <div class="nx-rw-hint">Also: {offsets.filter((o) => !DUE_OFFSET_CHOICES.some((c) => c.offset === o)).map(offsetLabel).join(', ')}</div>
              )}
              <div class="nx-rw-sub nx-dl-at">At</div>
              <TimePicker hour24={Math.floor(time / 60)} minute={time % 60} onChange={(h, m) => setTime(h * 60 + m)} />
              <div class="nx-rw-hint">
                {offsets.length === 0
                  ? 'No alerts — the deadline still shows on the calendar and the task.'
                  : `${offsets.length} alert${offsets.length === 1 ? '' : 's'} at ${formatAlertTime(time)}. Defaults are in Settings → Notifications.`}
              </div>
            </div>
          </div>
        </div>
        <div class="nx-rw-actions">
          {init.existing != null ? (
            <button class="nx-text-btn press nx-rw-secondary danger" onClick={remove}>
              Remove
            </button>
          ) : (
            <button class="nx-text-btn press nx-rw-secondary" onClick={p.onDismiss}>
              Cancel
            </button>
          )}
          <button class="nx-text-btn press" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
