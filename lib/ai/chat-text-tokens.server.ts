import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';

// Treat special-token spellings typed by a user as ordinary chat text.
const plainText = { disallowedSpecial: new Set<string>() };

/** Count plain chat text using the plan's fixed cl100k_base encoding. */
export function countChatTextTokens(text: string): number {
  return countTokens(text, plainText);
}
