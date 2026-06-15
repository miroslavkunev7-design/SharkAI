import { supremeConversation } from './supreme-conversation';
import type { ImageProfile } from '../vision-local';

interface ChatContext {
  history: Array<{ role: string; content: string }>;
}

export function localChatReply(
  message: string,
  context: ChatContext,
  hasImage?: boolean,
  imageProfile?: ImageProfile | null
) {
  return supremeConversation(message, context, hasImage, imageProfile);
}

export function isInstantMessage(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  if (t.length < 18 && !t.includes('?')) return true;
  return /^(здрав|привет|как си|какво става|благодар|thanks|hello|hi|hey|чао|ок|да|не|хаха|лол|lol|йо|yo)$/i.test(t);
}
