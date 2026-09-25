import { describe, expect, it } from 'vitest';
import { parseSmartAdd, type SmartKind } from './smartAdd';

// Friday 25 Sep 2026, 10:00 local time (same clock as SmartAddTest.kt on Android).
const NOW = new Date(2026, 8, 25, 10, 0);
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const parse = (s: string, ignore: SmartKind[] = []) => parseSmartAdd(s, NOW, ignore);

describe('smart add: the headline example', () => {
  it('reads date, time and priority and strips them from the title', () => {
    const p = parse('call CA tomorrow 5pm !1');
    expect(p.title).toBe('call CA');
    expect(p.dueDate).toBe('2026-09-26');
    expect(p.reminderTime).toBe(at(2026, 9, 26, 17));
    expect(p.priority).toBe('HIGH');
    expect(p.chips).toEqual([
      { kind: 'date', text: 'tomorrow' },
      { kind: 'time', text: '5pm' },
      { kind: 'priority', text: '!1' }
    ]);
  });

  it('is case-insensitive', () => {
    const p = parse('Call CA TOMORROW 5PM !HIGH');
    expect(p.title).toBe('Call CA');
    expect(p.dueDate).toBe('2026-09-26');
    expect(p.reminderTime).toBe(at(2026, 9, 26, 17));
    expect(p.priority).toBe('HIGH');
  });
});

describe('smart add: ordinary titles are left alone', () => {
  it.each([
    'May Tan meeting',
    'buy 1/2 kg sugar',
    'fix the sat nav',
    'sun visor repair',
    '3 may be enough',
    'ratio 9:30 looks right',
    'room 5 booking',
    'hello!1',
    'backup1 restore',
    'call mum at 25',
    'read chapter 12'
  ])('%s', (s) => {
    const p = parse(s);
    expect(p.title).toBe(s);
    expect(p.dueDate).toBeNull();
    expect(p.reminderTime).toBeNull();
    expect(p.priority).toBeNull();
    expect(p.chips).toEqual([]);
  });

  it('a token on its own stays a plain title', () => {
    expect(parse('tomorrow')).toEqual({ title: 'tomorrow', dueDate: null, reminderTime: null, priority: null, chips: [] });
    expect(parse('!1').priority).toBeNull();
  });
});

describe('smart add: dates', () => {
  it('today / tonight / tomorrow / tmrw', () => {
    expect(parse('pay rent today').dueDate).toBe('2026-09-25');
    expect(parse('pay rent tonight').dueDate).toBe('2026-09-25');
    expect(parse('pay rent tomorrow').dueDate).toBe('2026-09-26');
    expect(parse('pay rent tmrw').dueDate).toBe('2026-09-26');
    expect(parse('pay rent tomorrow').title).toBe('pay rent');
  });

  it('weekdays: the next one, never today; full names anywhere', () => {
    expect(parse('submit report by friday')).toMatchObject({ title: 'submit report', dueDate: '2026-10-02' });
    expect(parse('Monday standup notes')).toMatchObject({ title: 'standup notes', dueDate: '2026-09-28' });
    expect(parse('on wednesday dentist')).toMatchObject({ title: 'dentist', dueDate: '2026-09-30' });
    expect(parse('next monday gym').dueDate).toBe('2026-09-28');
    expect(parse('this saturday gym').dueDate).toBe('2026-09-26');
  });

  it('short weekday names need a preposition or must end the title', () => {
    expect(parse('gym mon')).toMatchObject({ title: 'gym', dueDate: '2026-09-28' });
    expect(parse('wash car sat')).toMatchObject({ title: 'wash car', dueDate: '2026-09-26' });
    expect(parse('wash car sat 5pm')).toMatchObject({ title: 'wash car', dueDate: '2026-09-26', reminderTime: at(2026, 9, 26, 17) });
    expect(parse('call CA on fri')).toMatchObject({ title: 'call CA', dueDate: '2026-10-02' });
    expect(parse('sun visor repair').dueDate).toBeNull();
  });

  it('in N days / weeks', () => {
    expect(parse('water plants in 3 days')).toMatchObject({ title: 'water plants', dueDate: '2026-09-28' });
    expect(parse('renew passport in 2 weeks').dueDate).toBe('2026-10-09');
    expect(parse('renew passport in a week').dueDate).toBe('2026-10-02');
  });

  it('day and month, either order, next occurrence', () => {
    expect(parse('dentist 25 oct')).toMatchObject({ title: 'dentist', dueDate: '2026-10-25' });
    expect(parse('dentist oct 25')).toMatchObject({ title: 'dentist', dueDate: '2026-10-25' });
    expect(parse('dentist 25th october')).toMatchObject({ title: 'dentist', dueDate: '2026-10-25' });
    expect(parse('dentist Oct 25th, 2027').dueDate).toBe('2027-10-25');
    expect(parse('dentist 1 jan').dueDate).toBe('2027-01-01'); // already passed this year
    expect(parse('dentist 25 sep').dueDate).toBe('2026-09-25'); // today counts
    expect(parse('invoice #5 due 30 sep')).toMatchObject({ title: 'invoice #5', dueDate: '2026-09-30' });
    expect(parse('party 31 feb').dueDate).toBeNull();
  });

  it('"may" as a month needs context, like short weekdays', () => {
    expect(parse('3 may be enough').dueDate).toBeNull();
    expect(parse('exam 3 may')).toMatchObject({ title: 'exam', dueDate: '2027-05-03' });
    expect(parse('exam on 3 may').dueDate).toBe('2027-05-03');
  });

  it('numeric day/month, day first', () => {
    expect(parse('pay rent 5/10')).toMatchObject({ title: 'pay rent', dueDate: '2026-10-05' });
    expect(parse('pay rent on 5/10')).toMatchObject({ title: 'pay rent', dueDate: '2026-10-05' });
    expect(parse('pay rent 25/10/2026 to landlord')).toMatchObject({ title: 'pay rent to landlord', dueDate: '2026-10-25' });
    expect(parse('pay rent 25/10/26').dueDate).toBe('2026-10-25');
    expect(parse('meet 10/25')).toMatchObject({ dueDate: '2026-10-25' }); // month first when day first is impossible
    expect(parse('buy 1/2 kg sugar').dueDate).toBeNull();
    expect(parse('meet 25/10 at 5pm')).toMatchObject({ title: 'meet', dueDate: '2026-10-25', reminderTime: at(2026, 10, 25, 17) });
  });

  it('ISO days', () => {
    expect(parse('launch 2026-12-01')).toMatchObject({ title: 'launch', dueDate: '2026-12-01' });
  });

  it('only the leftmost date counts', () => {
    expect(parse('move tomorrow or friday')).toMatchObject({ title: 'move or friday', dueDate: '2026-09-26' });
  });
});

describe('smart add: times', () => {
  it('am/pm, with or without minutes and a space', () => {
    expect(parse('call mum 11am')).toMatchObject({ title: 'call mum', reminderTime: at(2026, 9, 25, 11), dueDate: null });
    expect(parse('call mum 5:30 pm').reminderTime).toBe(at(2026, 9, 25, 17, 30));
    expect(parse('call mum 5.30 pm').reminderTime).toBeNull();
    expect(parse('call mum 12pm').reminderTime).toBe(at(2026, 9, 25, 12));
    expect(parse('call mum 12am').reminderTime).toBe(at(2026, 9, 26, 0));
    expect(parse('call mum 9 a.m.').reminderTime).toBe(at(2026, 9, 26, 9));
  });

  it('a time that has passed today means tomorrow', () => {
    expect(parse('call mum 9am').reminderTime).toBe(at(2026, 9, 26, 9));
    expect(parse('call mum 10am').reminderTime).toBe(at(2026, 9, 26, 10)); // exactly now is not ahead
  });

  it('24-hour times need two digits; a bare 9:30 is left alone', () => {
    expect(parse('standup 17:00').reminderTime).toBe(at(2026, 9, 25, 17));
    expect(parse('standup 09:30').reminderTime).toBe(at(2026, 9, 26, 9, 30));
    expect(parse('standup 9:30').reminderTime).toBeNull();
    expect(parse('standup 25:00').reminderTime).toBeNull();
    expect(parse('standup 17:60').reminderTime).toBeNull();
  });

  it('"at N": 1–7 is the evening, 8–12 the morning', () => {
    expect(parse('dinner at 7')).toMatchObject({ title: 'dinner', reminderTime: at(2026, 9, 25, 19) });
    expect(parse('standup at 9').reminderTime).toBe(at(2026, 9, 26, 9));
    expect(parse('standup at 9:30').reminderTime).toBe(at(2026, 9, 26, 9, 30));
    expect(parse('lunch at 12').reminderTime).toBe(at(2026, 9, 25, 12));
    expect(parse('call at 5pm').reminderTime).toBe(at(2026, 9, 25, 17));
    expect(parse('call at 17').reminderTime).toBe(at(2026, 9, 25, 17));
  });

  it('noon, in N hours / minutes', () => {
    expect(parse('lunch at noon')).toMatchObject({ title: 'lunch', reminderTime: at(2026, 9, 25, 12) });
    expect(parse('lunch midday').reminderTime).toBe(at(2026, 9, 25, 12));
    expect(parse('check oven in 2 hours')).toMatchObject({ title: 'check oven', reminderTime: at(2026, 9, 25, 12), dueDate: null });
    expect(parse('check oven in 30 min').reminderTime).toBe(at(2026, 9, 25, 10, 30));
    expect(parse('check oven in an hour').reminderTime).toBe(at(2026, 9, 25, 11));
  });

  it('date + time: the reminder is on that day', () => {
    expect(parse('call CA friday 3pm')).toMatchObject({ dueDate: '2026-10-02', reminderTime: at(2026, 10, 2, 15) });
    expect(parse('call CA today 17:00')).toMatchObject({ dueDate: '2026-09-25', reminderTime: at(2026, 9, 25, 17) });
  });

  it('a time already passed on an explicit day is left in the title', () => {
    const p = parse('call CA today 9am');
    expect(p.dueDate).toBe('2026-09-25');
    expect(p.reminderTime).toBeNull();
    expect(p.title).toBe('call CA 9am');
    expect(p.chips).toEqual([{ kind: 'date', text: 'today' }]);
  });
});

describe('smart add: priority', () => {
  it.each([
    ['!1', 'HIGH'], ['!2', 'MEDIUM'], ['!3', 'LOW'], ['!4', 'NONE'],
    ['!high', 'HIGH'], ['!med', 'MEDIUM'], ['!medium', 'MEDIUM'], ['!low', 'LOW'], ['!none', 'NONE'],
    ['p1', 'HIGH'], ['p2', 'MEDIUM'], ['p3', 'LOW'], ['P4', 'NONE']
  ])('%s → %s', (tok, pri) => {
    const p = parse(`fix login ${tok}`);
    expect(p.priority).toBe(pri);
    expect(p.title).toBe('fix login');
  });

  it('needs to be its own word', () => {
    expect(parse('hello!1').priority).toBeNull();
    expect(parse('up1 server').priority).toBeNull();
    expect(parse('!5 things').priority).toBeNull();
  });
});

describe('smart add: ignoring a chip', () => {
  it('leaves the words in the title and re-reads the rest', () => {
    const p = parse('call CA tomorrow 5pm !1', ['date']);
    expect(p.title).toBe('call CA tomorrow');
    expect(p.dueDate).toBeNull();
    expect(p.reminderTime).toBe(at(2026, 9, 25, 17)); // time only: today, still ahead
    expect(p.priority).toBe('HIGH');
    expect(p.chips.map((c) => c.kind)).toEqual(['time', 'priority']);
  });

  it('ignoring everything returns the input untouched', () => {
    expect(parse('call CA tomorrow 5pm !1', ['date', 'time', 'priority']).title).toBe('call CA tomorrow 5pm !1');
  });
});

describe('smart add: title clean-up', () => {
  it('collapses spaces and dangling punctuation', () => {
    expect(parse('call CA, tomorrow').title).toBe('call CA');
    expect(parse('  call   CA tomorrow  ').title).toBe('call CA');
    expect(parse('tomorrow - call CA').title).toBe('call CA');
    expect(parse('call CA tomorrow, then email').title).toBe('call CA, then email');
  });
});
