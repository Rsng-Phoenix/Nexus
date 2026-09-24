import { describe, expect, it } from 'vitest';
import { calendarProvider, calendarSourceLabel } from './linked';

describe('calendarProvider', () => {
  it('recognises each service from its link', () => {
    expect(calendarProvider('https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics').id).toBe('google');
    expect(calendarProvider('webcal://p42-caldav.icloud.com/published/2/abc').id).toBe('apple');
    expect(calendarProvider('https://calendar.zoho.in/ical/abc').id).toBe('zoho');
    expect(calendarProvider('https://outlook.office365.com/owa/calendar/abc/calendar.ics').id).toBe('outlook');
    expect(calendarProvider('https://outlook.live.com/owa/calendar/abc/calendar.ics').id).toBe('outlook');
  });
  it('falls back to the host, and never trusts look-alike hosts', () => {
    expect(calendarProvider('https://www.example.org/cal.ics')).toEqual({ id: 'other', label: 'example.org' });
    expect(calendarProvider('https://evilgoogle.com/x.ics').id).toBe('other');
    expect(calendarProvider('not a url')).toEqual({ id: 'other', label: 'Calendar' });
  });
  it('labels a calendar with its service and name', () => {
    expect(calendarSourceLabel({ name: 'Work', url: 'https://calendar.google.com/x.ics' })).toBe('Google · Work');
    expect(calendarSourceLabel({ name: 'google', url: 'https://calendar.google.com/x.ics' })).toBe('Google');
  });
});
