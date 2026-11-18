import type { ChatTool } from '@/lib/chat-tools';
import type { ReminderInput } from './reminders';
import type { Attachment, Mode } from './workspace-types';

export type BranchFrom = { conversationId: string; messageId: string };

export interface ChatRequest {
  message: string;
  conversationId: string;
  requestId: string;
  mode: Mode;
  model?: string;
  reasoning?: string;
  uploadId?: string;
  toolId?: string;
  projectId?: string;
  branchFrom?: BranchFrom;
  reminder?: ReminderInput;
}

export interface PendingChatTurn {
  owner: string;
  scope: string;
  request: ChatRequest;
  input: string;
  attachment: Attachment | null;
  tool: ChatTool | null;
  problem: string;
  stopped?: boolean;
}

const storageKey = 'sharkai:pending-chat-turn:v1';

export function chatTurnScope(conversationId?: string, projectId?: string) {
  return JSON.stringify([conversationId ?? '', projectId ?? '']);
}

export function writePendingChatTurn(turn: PendingChatTurn | null) {
  try {
    if (turn) sessionStorage.setItem(storageKey, JSON.stringify(turn));
    else sessionStorage.removeItem(storageKey);
  } catch { /* Chat still works when browser storage is unavailable. */ }
}

export function readPendingChatTurn(owner: string | undefined, scope: string): PendingChatTurn | null {
  if (!owner) return null;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const turn = JSON.parse(raw) as PendingChatTurn;
    if (turn.owner !== owner) {
      writePendingChatTurn(null);
      return null;
    }
    if (turn.scope !== scope || typeof turn.input !== 'string' || typeof turn.problem !== 'string'
      || typeof turn.request?.message !== 'string' || typeof turn.request?.requestId !== 'string'
      || typeof turn.request?.conversationId !== 'string' || !['chat', 'work'].includes(turn.request.mode)) return null;
    return turn;
  } catch { return null; }
}
