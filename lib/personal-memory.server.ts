import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db';
import { MAX_MEMORY_NOTE_LENGTH, MAX_MEMORY_NOTES, type MemoryChange, type MemoryNote, type PersonalMemory } from './personal-memory';

const noteId = z.string().uuid();
const noteText = z.string().trim().min(1).max(MAX_MEMORY_NOTE_LENGTH);
const savedNotes = z.array(z.object({ id: noteId, text: noteText })).max(MAX_MEMORY_NOTES);
export const memoryInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable'), enabled: z.boolean() }),
  z.object({ action: z.literal('add'), text: noteText }),
  z.object({ action: z.literal('edit'), id: noteId, text: noteText }),
  z.object({ action: z.literal('delete'), id: noteId }),
  z.object({ action: z.literal('clear') }),
]).and(z.object({ revision: z.number().int().nonnegative() }));

export class MemoryError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const emptyMemory: PersonalMemory = { enabled: false, revision: 0, notes: [] };
const select = { enabled: true, revision: true, notes: true } as const;

function parseNotes(notes: Prisma.JsonValue): MemoryNote[] {
  const parsed = savedNotes.safeParse(notes);
  if (!parsed.success) throw new MemoryError('Личните бележки временно са недостъпни.', 503);
  return parsed.data;
}

export async function readPersonalMemory(userId: string): Promise<PersonalMemory> {
  const row = await prisma.personalMemory.findUnique({ where: { userId }, select });
  return row ? { ...row, notes: parseNotes(row.notes) } : emptyMemory;
}

function nextMemory(state: PersonalMemory, change: MemoryChange): PersonalMemory {
  const next = { ...state, revision: state.revision + 1 };
  switch (change.action) {
    case 'enable':
      return { ...next, enabled: change.enabled };
    case 'add':
      if (!state.enabled) throw new MemoryError('Включи личните бележки, за да добавиш нова.', 409);
      if (state.notes.length >= MAX_MEMORY_NOTES) throw new MemoryError('Достигнат е броят на личните бележки.', 409);
      return { ...next, notes: [...state.notes, { id: randomUUID(), text: change.text }] };
    case 'clear':
      return { ...next, notes: [] };
    case 'edit':
    case 'delete':
      if (!state.notes.some(({ id }) => id === change.id)) throw new MemoryError('Бележката не е намерена.', 404);
      return {
        ...next,
        notes: change.action === 'delete' ? state.notes.filter(({ id }) => id !== change.id)
          : state.notes.map((note) => note.id === change.id ? { ...note, text: change.text } : note),
      };
  }
}

export async function changePersonalMemory(userId: string, change: z.output<typeof memoryInput>) {
  const row = await prisma.personalMemory.findUnique({ where: { userId }, select });
  const state = row ? { ...row, notes: parseNotes(row.notes) } : emptyMemory;
  const conflict = () => new MemoryError('Бележките са обновени в друг прозорец. Прегледай новото състояние.', 409);
  if (change.revision !== state.revision) throw conflict();
  const data = nextMemory(state, change);
  if (row) {
    const result = await prisma.personalMemory.updateMany({ where: { userId, revision: change.revision }, data });
    if (!result.count) throw conflict();
  } else {
    try {
      await prisma.personalMemory.create({ data: { userId, ...data } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict();
      throw error;
    }
  }
  return data;
}

export async function readChatMemory(userId: string): Promise<string[]> {
  const row = await prisma.personalMemory.findUnique({ where: { userId, enabled: true }, select: { notes: true } });
  return row ? parseNotes(row.notes).map(({ text }) => text) : [];
}
