import { signal } from '@preact/signals';
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
  }
];

/** One line for the Settings row. */
export const SHORTCUTS_SUMMARY = `${MOD}K palette · ⏎ new task · 1–4 quadrants · ? shows them all`;

export const DESK_SHORTCUT_NOTE = 'Nexus Desk: ⌃⌥N (Mac) / Ctrl+Alt+N (Windows) opens a new task from any app';

export function ShortcutsDialog() {
  const close = () => (shortcutsOpen.value = false);
  return (
    <Dialog open={shortcutsOpen.value} onClose={close} title="Keyboard shortcuts" actions={<TextButton onClick={close}>Done</TextButton>} wide>
      <div class="nx-keys-groups">
        {SHORTCUT_GROUPS.map((g) => (
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
        <p class="nx-keys-note">{DESK_SHORTCUT_NOTE}</p>
      </div>
    </Dialog>
  );
}
