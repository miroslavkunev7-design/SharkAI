export const MAX_MEMORY_NOTES = 12;
export const MAX_MEMORY_NOTE_LENGTH = 280;

export type MemoryNote = { id: string; text: string };
export type PersonalMemory = { enabled: boolean; revision: number; notes: MemoryNote[] };

export type MemoryChange =
  | { action: 'enable'; enabled: boolean }
  | { action: 'add'; text: string }
  | { action: 'edit'; id: string; text: string }
  | { action: 'delete'; id: string }
  | { action: 'clear' };
