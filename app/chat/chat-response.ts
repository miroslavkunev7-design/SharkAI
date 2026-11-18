import type { ChatToolResult } from '@/lib/chat-tools';
import type { Message, Mode } from './workspace-types';

export interface ChatResult {
  content: string;
  conversationId: string | null;
  title?: string;
  conversationMode?: Mode;
  messages?: Message[];
  toolResult?: ChatToolResult | null;
}

export async function readChatResponse(response: Response, onDelta: (delta: string) => void): Promise<ChatResult> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) throw new Error(body?.error || 'SharkAI не успя да обработи съобщението.');
    return body;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Връзката с отговора прекъсна.');
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ChatResult | undefined;

  function readLine(line: string) {
    if (!line.trim()) return;
    const chunk = JSON.parse(line);
    if (chunk.type === 'error') throw new Error(chunk.error || 'Връзката с отговора прекъсна.');
    if (chunk.type === 'delta') onDelta(chunk.text);
    if (chunk.type === 'done') result = chunk;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach(readLine);
      if (done) {
        readLine(buffer);
        break;
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new Error('Връзката с отговора прекъсна.');
  return result;
}
