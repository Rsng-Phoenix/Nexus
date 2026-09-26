import { describe, expect, it } from 'vitest';
import { clampFocus, moveFocus, neighbour } from './keynav';

const counts = { HIGH: 3, MEDIUM: 0, LOW: 2, NONE: 1 };

describe('neighbour', () => {
  it('follows the 2×2 layout', () => {
    expect(neighbour('HIGH', 'right')).toBe('MEDIUM');
    expect(neighbour('HIGH', 'down')).toBe('LOW');
    expect(neighbour('NONE', 'up')).toBe('MEDIUM');
    expect(neighbour('NONE', 'left')).toBe('LOW');
    expect(neighbour('HIGH', 'up')).toBeNull();
    expect(neighbour('MEDIUM', 'right')).toBeNull();
  });
});

describe('clampFocus', () => {
  it('keeps the index inside the rows that exist', () => {
    expect(clampFocus({ priority: 'HIGH', index: 9 }, counts)).toEqual({ priority: 'HIGH', index: 2 });
    expect(clampFocus({ priority: 'HIGH', index: -1 }, counts)).toEqual({ priority: 'HIGH', index: 0 });
    expect(clampFocus({ priority: 'MEDIUM', index: 0 }, counts)).toBeNull();
    expect(clampFocus(null, counts)).toBeNull();
  });
});

describe('moveFocus', () => {
  it('starts on the first quadrant with rows', () => {
    expect(moveFocus(null, 'down', counts)).toEqual({ priority: 'HIGH', index: 0 });
    expect(moveFocus(null, 'left', { HIGH: 0, MEDIUM: 0, LOW: 2, NONE: 1 })).toEqual({ priority: 'LOW', index: 0 });
    expect(moveFocus(null, 'up', { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 })).toBeNull();
  });

  it('walks rows and continues into the quadrant below / above', () => {
    expect(moveFocus({ priority: 'HIGH', index: 0 }, 'down', counts)).toEqual({ priority: 'HIGH', index: 1 });
    expect(moveFocus({ priority: 'HIGH', index: 2 }, 'down', counts)).toEqual({ priority: 'LOW', index: 0 });
    expect(moveFocus({ priority: 'LOW', index: 0 }, 'up', counts)).toEqual({ priority: 'HIGH', index: 2 });
    expect(moveFocus({ priority: 'LOW', index: 1 }, 'down', counts)).toEqual({ priority: 'LOW', index: 1 }); // bottom edge
    expect(moveFocus({ priority: 'HIGH', index: 0 }, 'up', counts)).toEqual({ priority: 'HIGH', index: 0 }); // top edge
  });

  it('jumps sideways keeping the row, skipping empty quadrants', () => {
    expect(moveFocus({ priority: 'LOW', index: 1 }, 'right', counts)).toEqual({ priority: 'NONE', index: 0 });
    expect(moveFocus({ priority: 'NONE', index: 0 }, 'left', counts)).toEqual({ priority: 'LOW', index: 0 });
    expect(moveFocus({ priority: 'HIGH', index: 1 }, 'right', counts)).toEqual({ priority: 'HIGH', index: 1 }); // Medium is empty
    expect(moveFocus({ priority: 'NONE', index: 0 }, 'up', counts)).toEqual({ priority: 'NONE', index: 0 });
  });

  it('re-clamps a stale focus before moving', () => {
    expect(moveFocus({ priority: 'HIGH', index: 7 }, 'up', counts)).toEqual({ priority: 'HIGH', index: 1 });
  });
});
