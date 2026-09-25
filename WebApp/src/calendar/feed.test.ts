import { describe, expect, it, vi } from 'vitest';
vi.mock('../db/tasks', () => ({}));
vi.mock('../sync/drive', () => ({}));
import type { Task } from '../types';
import { buildFeed, feedLinks, feedTasks, newFeedCreds } from './feed';
import { parseIcs } from './ics';

const base: Task = {
  id: 1, taskUuid: 'u1', description: 'Send invoice', priority: 'HIGH', position: 0, isCompleted: false, isWontDo: false, isPinned: false,
  reminderTime: null, reminderDateOnly: false, reminderIntervalMinutes: 0, reminderEndDate: 0, reminderHistoryLabel: '',
  notes: 'secret notes', createdAt: 1, updatedAt: 1, deletedAt: 0, completedAt: 0, skippedAt: 0, archivedAt: 0,
  dueDate: '2026-10-05', dueAlerts: '-1,0', dueAlertTime: 540
};
const t = (p: Partial<Task>): Task => ({ ...base, ...p });

describe('live calendar feed', () => {
  it('shows open tasks with a deadline or reminder, nothing else', () => {
    const tasks = [
      t({ taskUuid: 'due' }),
      t({ taskUuid: 'rem', dueDate: '', reminderTime: Date.UTC(2026, 9, 6, 9) }),
      t({ taskUuid: 'plain', dueDate: '' }),
      t({ taskUuid: 'done', isCompleted: true }),
      t({ taskUuid: 'wont', isWontDo: true }),
      t({ taskUuid: 'gone', deletedAt: 5 }),
      t({ taskUuid: 'arch', archivedAt: 5 })
    ];
    expect(feedTasks(tasks).map((x) => x.taskUuid)).toEqual(['due', 'rem']);
  });

  it('keeps notes out unless asked, and is a calendar Apple and Google accept', () => {
    const ics = buildFeed([t({}), t({ taskUuid: 'rem', dueDate: '', reminderTime: Date.UTC(2026, 9, 6, 9), description: 'Call, Rahul; re: “Q4”' })], false, 0);
    expect(ics).not.toContain('secret notes');
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toMatch(/END:VCALENDAR\r\n$/);
    for (const k of ['VERSION:2.0', 'PRODID:', 'X-WR-CALNAME:Nexus', 'METHOD:PUBLISH']) expect(ics).toContain(k);
    // Every line CRLF-terminated and at most 75 octets (RFC 5545), every event has UID + DTSTAMP.
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    const blocks = ics.split('BEGIN:VEVENT').slice(1);
    expect(blocks.length).toBe(2);
    for (const b of blocks) {
      expect(b).toContain('UID:');
      expect(b).toContain('DTSTAMP:');
    }
    // Round-trips through our own reader (the one that reads Google / iCloud / Outlook).
    expect(parseIcs(ics).map((e) => e.summary).sort()).toEqual(['Call, Rahul; re: “Q4”', 'Send invoice']);
    expect(buildFeed([t({})], true, 0)).toContain('secret notes');
  });

  it('builds the subscribe links', () => {
    const c = { id: 'A'.repeat(43) };
    const l = feedLinks(c, 'https://nexus-push.example.workers.dev');
    expect(l.https).toBe(`https://nexus-push.example.workers.dev/feed/${'A'.repeat(43)}.ics`);
    expect(l.webcal).toBe(`webcal://nexus-push.example.workers.dev/feed/${'A'.repeat(43)}.ics`);
    expect(l.google).toBe(`https://calendar.google.com/calendar/render?cid=${encodeURIComponent(l.webcal)}`);
    expect(l.outlook).toContain(encodeURIComponent(l.https));
  });

  it('makes unguessable 256-bit addresses and keys', () => {
    const a = newFeedCreds();
    const b = newFeedCreds();
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(a.key);
  });
});
