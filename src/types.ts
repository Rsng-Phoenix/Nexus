export type Priority = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
export type ThemeMode = 'SYSTEM' | 'LIGHT' | 'DARK';
export type LayoutMode = 'auto' | 'phone' | 'desktop';

export interface Task {
  id: number;
  taskUuid: string;
  description: string;
  priority: Priority;
  position: number;
  isCompleted: boolean;
  isWontDo: boolean;
  isPinned: boolean;
  reminderTime: number | null;
  reminderDateOnly: boolean;
  reminderIntervalMinutes: number;
  reminderEndDate: number;
  reminderHistoryLabel: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number;
  completedAt: number;
  skippedAt: number;
}

export const PRIORITIES: Priority[] = ['HIGH', 'MEDIUM', 'LOW', 'NONE'];

export const PRIORITY_META: Record<
  Priority,
  { label: string; glyph: string; color: string }
> = {
  HIGH: { label: 'High', glyph: 'I', color: '#FF4060' },
  MEDIUM: { label: 'Medium', glyph: 'II', color: '#FFAA00' },
  LOW: { label: 'Low', glyph: 'III', color: '#3B9EFF' },
  NONE: { label: 'None', glyph: 'IV', color: '#00D084' }
};
