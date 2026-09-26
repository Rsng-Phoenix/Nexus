import { signal } from '@preact/signals';
import { deskInfo, inNexusDesk } from '../state/desk';
import { isPc } from '../state/viewport';
import { Dialog, TextButton } from './kit';

/** Mac keyboards say ⌘ and ⌥; everyone else Ctrl and Alt. */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';
export const ALT = isMac ? '⌥' : 'Alt';

/** Open from anywhere ("?" on the matrix, Settings, the command palette). */
export const shortcutsOpen = signal(false);

/** Every shortcut, grouped. Keys are separated by spaces (one <kbd> each). */
export const SHORTCUT_GROUPS: Array<{ title: string; keys: [string, string][] }> = [
  {
    title: 'Anywhere',
    keys: [
      [`${MOD} K`, 'Command palette: find any task, run any action (also / on the matrix)'],
      ['⏎', 'New task (pick a priority, then type)'],
      ['N', 'New task'],
      ['1 2 3 4', 'Open High / Medium / Low / None'],
      ['C', 'Calendar'],
      ['M', 'Mini window (always on top)'],
      ['S', 'Sync now'],
      [',', 'Settings'],
      ['?', 'This list'],
      ['esc', 'Close / back']
    ]
  },
  {
    title: 'Matrix',
    keys: [
      ['↑ ↓', 'Move through the tasks (or J / K)'],
      ['← →', 'Jump to the quadrant beside (or H / L)'],
      ['esc', 'Clear the highlight']
    ]
  },
  {
    title: 'Task (highlighted)',
    keys: [
      ['⏎', 'Open'],
      ['E', 'Edit (same as open)'],
      ['space', 'Done / not done (or X)'],
      ['P', 'Pin / unpin'],
      ['⌫', 'Delete (Undo from the snackbar)'],
      [`${ALT} 1–4`, 'Move to High / Medium / Low / None']
    ]
  },
  {
    title: 'Add',
    keys: [
      ['⏎', 'Add and keep typing the next one'],
      ['⇧ ⏎', 'New line (each pasted line becomes a task)'],
      ['esc', 'Close'],
      ['!1 !2 !3 !4', 'Priority as you type (also !high, !med, !low, p1–p4)'],
      ['tomorrow 5pm', 'Date and reminder as you type: try "call CA tomorrow 5pm !1"']
    ]
  },
  {
    title: 'Palette',
    keys: [
      ['↑ ↓', 'Move'],
      ['⏎', 'Open the task / run the action'],
      [`${MOD} ⏎`, 'Mark the task done'],
      ['esc', 'Close']
    ]
  },
  {
    // Nexus Desk Quick Add panel (§4.2) — the global shortcut opens it from any app.
    title: 'Quick Add (Nexus Desk)',
    keys: [
      ['⏎', 'Add and close'],
      ['⇧ ⏎', 'Add and keep the panel open for the next one'],
      [`${MOD} 1–4`, `Priority High / Medium / Low / None (also ${ALT} 1–4)`],
      [`${MOD} ⏎`, 'Save'],
      ['esc', 'Clear what you typed · again closes'],
      [`${MOD} ⇧ V`, 'Paste as plain text'],
      ['tomorrow 5pm !1', 'Dates, reminders and priority as you type']
    ]
  },
  {
    // Widget composer (§4.3): idle pill → pick a priority → type.
    title: 'Widget',
    keys: [
      ['N ⏎', 'New task: pick a priority, then type'],
      ['1 2 3 4', 'Pick High / Medium / Low / None (or arrows, Tab)'],
      ['⏎', 'Confirm the priority · add the task'],
      ['esc', 'Back a step · close'],
      [`${MOD} ⇧ ⏎`, 'Add, then bring the widget forward to review']
    ]
  }
];

/** One line for the Settings row. */
export const SHORTCUTS_SUMMARY = `${MOD}K palette · ⏎ new task · 1–4 quadrants · ? shows them all`;

export const DESK_SHORTCUT_NOTE = 'Nexus Desk: ⌃⌥N (Mac) / Ctrl+Alt+N (Windows) opens a new task from any app';

/** The note with the shortcut the Desk actually has (it can be changed in Settings → Nexus Desk). */
export function deskShortcutNote(): string {
  const d = deskInfo.value;
  if (!inNexusDesk() || !d?.hotkey) return DESK_SHORTCUT_NOTE;
  return `Nexus Desk: ${d.hotkey} opens ${d.quickAddStyle === 'widget' ? 'the widget' : 'Quick Add'} from any app${d.hotkeyOn === false ? ' (off right now)' : ''} · change it in Settings → Nexus Desk`;
}

export function ShortcutsDialog() {
  const close = () => (shortcutsOpen.value = false);
  // Quick Add and widget keys only matter where the Desk exists; on a Mac/Windows browser they still say what the Desk offers.
  const showDesk = inNexusDesk() || isPc.value;
  const groups = SHORTCUT_GROUPS.filter((g) => showDesk || !/Quick Add|Widget/.test(g.title));
  return (
    <Dialog open={shortcutsOpen.value} onClose={close} title="Keyboard shortcuts" actions={<TextButton onClick={close}>Done</TextButton>} wide>
      <div class="nx-keys-groups">
        {groups.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <dl class="nx-keys">
              {g.keys.map(([k, d]) => (
                <div key={k + d}>
                  <dt>{k.split(' ').map((x, i) => <kbd key={i}>{x}</kbd>)}</dt>
                  <dd>{d}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p class="nx-keys-note">{deskShortcutNote()}</p>
      </div>
    </Dialog>
  );
}
