import type { ThemeMode } from '../types';

export interface NexusPalette {
  bg: string;
  surface: string;
  surfaceEl: string;
  stroke: string;
  accent: string;
  textPri: string;
  textSec: string;
  textTer: string;
  notesText: string;
  numberAccent: string;
}

export const darkPalette: NexusPalette = {
  bg: '#080810',
  surface: '#0F0F1C',
  surfaceEl: '#161628',
  stroke: '#1E1E38',
  accent: '#6C63FF',
  textPri: '#F0F0FA',
  textSec: '#8A8AA8',
  textTer: '#4A4A68',
  notesText: '#D8D8EC',
  numberAccent: '#9B8CFF'
};

export const lightPalette: NexusPalette = {
  bg: '#F4F4FA',
  surface: '#FFFFFF',
  surfaceEl: '#FFFFFF',
  stroke: '#E2E2EE',
  accent: '#5B54E8',
  textPri: '#12121C',
  textSec: '#5C5C78',
  textTer: '#9898B0',
  notesText: '#2A2A3C',
  numberAccent: '#5B54E8'
};

export function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'DARK') return true;
  if (mode === 'LIGHT') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyPalette(p: NexusPalette): void {
  const r = document.documentElement;
  for (const [k, v] of Object.entries(p)) {
    r.style.setProperty(`--nx-${k}`, v);
  }
}
