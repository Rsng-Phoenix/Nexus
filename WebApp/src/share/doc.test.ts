import { describe, expect, it } from 'vitest';
import { toStorage, type NoteBlock } from '../notes/codec';
import type { Task } from '../types';
import { fullDay, listShareDoc, shareDocText, shareFileName, taskShareDoc } from './doc';

const block = (type: NoteBlock['type'], text: string, extra: Partial<NoteBlock> = {}): NoteBlock => ({
  id: Math.random().toString(36),
  type,
  text,
  checked: false,
  indent: 0,
  bold: false,
  underline: false,
  localScale: 1,
  spans: [],
  sortKey: 0,
  ...extra
});

const task = (over: Partial<Task>): Task =>
  ({
    id: 1,
    taskUuid: 'u1',
    description: 'Pay GST return',
    notes: '',
    priority: 'HIGH',
    isCompleted: false,
    isWontDo: false,
    reminderTime: null,
    dueDate: '2026-09-26',
    dueAlerts: '-1,0',
    dueAlertTime: 540,
    deletedAt: 0,
    archivedAt: 0,
    ...over
  }) as Task;

describe('share text', () => {
  it('reads well in a chat: bold title, full dates (never "tomorrow"), ticks and bullets', () => {
    const notes = toStorage([
      block('TEXT', 'Before Friday'),
      block('CHECKBOX', 'Collect invoices', { checked: true }),
      block('CHECKBOX', 'File GSTR-1'),
      block('BULLET', 'Ask CA about ₹ late fee', { indent: 1 }),
      block('NUMBERED', 'Upload'),
      block('NUMBERED', 'Pay')
    ]);
    const text = shareDocText(taskShareDoc(task({ notes })));
    expect(text).toBe(
      [
        '*Pay GST return*',
        '🔴 High priority · Due Sat 26 Sep 2026',
        '',
        'Before Friday',
        '☑ Collect invoices',
        '☐ File GSTR-1',
        '   • Ask CA about ₹ late fee',
        '1. Upload',
        '2. Pay',
        '',
        '— Shared from Nexus'
      ].join('\n')
    );
  });

  it('says when a task is done and has no notes', () => {
    const text = shareDocText(taskShareDoc(task({ isCompleted: true, dueDate: '', priority: 'LOW' })));
    expect(text).toBe('*Pay GST return*\n🔵 Low priority · Done\n\n— Shared from Nexus');
  });

  it('a quadrant lists its tasks with their due dates', () => {
    const text = shareDocText(listShareDoc('High priority', 'HIGH', [task({}), task({ description: 'Call courier', dueDate: '' })]));
    expect(text).toContain('☐ Pay GST return  (due Sat 26 Sep 2026)');
    expect(text).toContain('☐ Call courier\n');
    expect(text).toContain('2 tasks');
  });
});

describe('share files', () => {
  it('are named after the task, without characters files can’t have', () => {
    expect(shareFileName(taskShareDoc(task({ description: 'Q3: GST / TDS "final"?' })), 'pdf')).toBe('Q3 GST TDS final.pdf');
    expect(shareFileName(taskShareDoc(task({ description: '   ' })), 'png')).toBe('Task.png');
  });
  it('writes days in full', () => {
    expect(fullDay('2026-10-05')).toBe('Mon 5 Oct 2026');
  });
});
