require('dotenv').config({ path: '.env' });
const { generateText } = require('ai');
const { createOpenAI } = require('@ai-sdk/openai');

async function main() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) { console.log('NO KEY'); return; }
  const openai = createOpenAI({ apiKey: key });
  const start = Date.now();
  try {
    const { text } = await generateText({
      model: openai('gpt-4o-mini'),
      prompt: 'Say hello in Bulgarian in one sentence.',
      maxOutputTokens: 100,
    });
    console.log('OK', Date.now() - start + 'ms', text);
  } catch (e) {
    console.log('ERR', Date.now() - start + 'ms', e.message);
  }
}
main();
