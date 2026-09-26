import { describe, expect, it } from 'vitest';
import { pickerKey } from './pickerKeys';

describe('pickerKey', () => {
  it('arrows move within the 2×2 grid without wrapping', () => {
    expect(pickerKey({ key: 'ArrowRight' }, 'HIGH')).toEqual({ type: 'move', priority: 'MEDIUM' });
    expect(pickerKey({ key: 'ArrowRight' }, 'MEDIUM')).toEqual({ type: 'move', priority: 'MEDIUM' });
    expect(pickerKey({ key: 'ArrowLeft' }, 'MEDIUM')).toEqual({ type: 'move', priority: 'HIGH' });
    expect(pickerKey({ key: 'ArrowLeft' }, 'HIGH')).toEqual({ type: 'move', priority: 'HIGH' });
    expect(pickerKey({ key: 'ArrowDown' }, 'HIGH')).toEqual({ type: 'move', priority: 'LOW' });
    expect(pickerKey({ key: 'ArrowDown' }, 'MEDIUM')).toEqual({ type: 'move', priority: 'NONE' });
    expect(pickerKey({ key: 'ArrowDown' }, 'NONE')).toEqual({ type: 'move', priority: 'NONE' });
    expect(pickerKey({ key: 'ArrowUp' }, 'NONE')).toEqual({ type: 'move', priority: 'MEDIUM' });
    expect(pickerKey({ key: 'ArrowUp' }, 'HIGH')).toEqual({ type: 'move', priority: 'HIGH' });
  });

  it('Tab cycles forward, Shift+Tab backward, wrapping', () => {
    expect(pickerKey({ key: 'Tab' }, 'HIGH')).toEqual({ type: 'move', priority: 'MEDIUM' });
    expect(pickerKey({ key: 'Tab' }, 'NONE')).toEqual({ type: 'move', priority: 'HIGH' });
    expect(pickerKey({ key: 'Tab', shiftKey: true }, 'HIGH')).toEqual({ type: 'move', priority: 'NONE' });
    expect(pickerKey({ key: 'Tab', shiftKey: true }, 'LOW')).toEqual({ type: 'move', priority: 'MEDIUM' });
  });

  it('1–4 choose a cell directly', () => {
    expect(pickerKey({ key: '1' }, 'NONE')).toEqual({ type: 'choose', priority: 'HIGH', text: '' });
    expect(pickerKey({ key: '2' }, 'NONE')).toEqual({ type: 'choose', priority: 'MEDIUM', text: '' });
    expect(pickerKey({ key: '3' }, 'HIGH')).toEqual({ type: 'choose', priority: 'LOW', text: '' });
    expect(pickerKey({ key: '4' }, 'HIGH')).toEqual({ type: 'choose', priority: 'NONE', text: '' });
  });

  it('Enter and space confirm the highlight', () => {
    expect(pickerKey({ key: 'Enter' }, 'LOW')).toEqual({ type: 'choose', priority: 'LOW', text: '' });
    expect(pickerKey({ key: ' ' }, 'MEDIUM')).toEqual({ type: 'choose', priority: 'MEDIUM', text: '' });
  });

  it('typing confirms the highlight and keeps the keystroke', () => {
    expect(pickerKey({ key: 'b' }, 'HIGH')).toEqual({ type: 'choose', priority: 'HIGH', text: 'b' });
    expect(pickerKey({ key: '5' }, 'LOW')).toEqual({ type: 'choose', priority: 'LOW', text: '5' });
    expect(pickerKey({ key: 'é' }, 'LOW')).toEqual({ type: 'choose', priority: 'LOW', text: 'é' });
  });

  it('leaves modifiers, repeats, composition and other keys alone', () => {
    expect(pickerKey({ key: '1', metaKey: true }, 'HIGH')).toBeNull();
    expect(pickerKey({ key: 'a', ctrlKey: true }, 'HIGH')).toBeNull();
    expect(pickerKey({ key: 'a', altKey: true }, 'HIGH')).toBeNull();
    expect(pickerKey({ key: 'ArrowDown', repeat: true }, 'HIGH')).toBeNull();
    expect(pickerKey({ key: 'a', isComposing: true }, 'HIGH')).toBeNull();
    expect(pickerKey({ key: 'Escape' }, 'HIGH')).toBeNull();
    expect(pickerKey({ key: 'Shift' }, 'HIGH')).toBeNull();
    expect(pickerKey({ key: 'Backspace' }, 'HIGH')).toBeNull();
  });
});
