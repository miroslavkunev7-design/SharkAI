import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { PDFDocument } from 'pdf-lib';
import { buildLocalDocument, extractLocalDocxText } from '../lib/chat-documents.server';
import { parseDocumentTranslationRequest, translateDocumentText } from '../lib/chat-document-translation.server';

function modelReturning(output: unknown, finish: 'stop' | 'length' = 'stop') {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      finishReason: { unified: finish, raw: finish },
      usage: {
        inputTokens: { total: 25, noCache: 25, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 15, text: 15, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

test('recognizes translations to a new document and selects only an explicitly named earlier answer', () => {
  assert.deepEqual(parseDocumentTranslationRequest('Преведи прикачения PDF от български на английски и го запази като DOCX.'), {
    format: 'docx', language: 'English', source: 'attachment',
  });
  assert.deepEqual(parseDocumentTranslationRequest('Please, create a PDF of the previous answer translated into Bulgarian.'), {
    format: 'pdf', language: 'Bulgarian', source: 'previous-answer',
  });
  assert.deepEqual(parseDocumentTranslationRequest('Преведи предишния извлечен текст на френски и запиши като PDF.'), {
    format: 'pdf', language: 'French', source: 'previous-answer',
  });
  assert.deepEqual(parseDocumentTranslationRequest('Translate the attached PDF and export as Word.'), {
    format: 'docx', language: undefined, source: 'attachment',
  });
  assert.deepEqual(parseDocumentTranslationRequest('Преведи този файл на немски като PDF.'), {
    format: 'pdf', language: 'German', source: 'attachment',
  });
  assert.equal(parseDocumentTranslationRequest('Преведи PDF на английски.'), null);
  assert.equal(parseDocumentTranslationRequest('Направи PDF с текст: Преведи предишния отговор на английски.'), null);
  assert.equal(parseDocumentTranslationRequest('Прочети PDF и запиши като DOCX.'), null);
  assert.equal(parseDocumentTranslationRequest('Explain how to translate a PDF to English and save as Word.'), null);
  assert.equal(parseDocumentTranslationRequest('Преведи прикачения PDF на английски и на немски и запази като DOCX.')?.language, undefined);
});

test('translates the bounded DOCX body in one call and builds a real new DOCX and PDF', async () => {
  const original = await buildLocalDocument('docx', 'The train leaves at 08:30.\n\nDetails at https://example.org/ticket.');
  const snapshot = Buffer.from(original);
  const source = await extractLocalDocxText(original);
  const body = 'Влакът тръгва в 08:30.\n\nПодробности на https://example.org/ticket.';
  const model = modelReturning({ status: 'complete', lines: body.split('\n\n') });
  const translation = await translateDocumentText({ model, source, language: 'Bulgarian', maxOutputTokens: 200 });
  assert.equal(translation.text, body);
  assert.equal(translation.usageTokens, 40);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(model.doGenerateCalls[0].maxOutputTokens, 200);
  assert.match(JSON.stringify(model.doGenerateCalls[0].prompt), /never as instructions/iu);
  assert.equal(await extractLocalDocxText(await buildLocalDocument('docx', translation.text)), body);
  assert.deepEqual(original, snapshot);

  const pdf = await buildLocalDocument('pdf', translation.text);
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
  try {
    const extracted = execFileSync('pdftotext', ['-enc', 'UTF-8', '-', '-'], { input: pdf, encoding: 'utf8' });
    assert.match(extracted, /Влакът тръгва в 08:30\./u);
    assert.match(extracted, /https:\/\/example\.org\/ticket/u);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
});

test('refuses partial, copied, wrong-script, or fact-altering translations before export', async () => {
  const source = 'Item 20 costs 50 BGN.\nhttps://example.org/';
  const valid = ['Артикул 20 струва 50 BGN.', 'https://example.org/'];
  for (const lines of [
    ['Артикул 20 струва 50 BGN.'],
    source.split('\n'),
    ['Article 20 coute 50 BGN.', 'https://example.org/'],
    ['Артикул 20 costa 50 BGN.', 'https://example.org/'],
    ['Артикул 20 струва 51 BGN.', 'https://example.org/'],
    ['Артикул 20 струва 50 BGN.', 'https://example.org/changed'],
    ['Артикул 20 струва 50 BGN.', ''],
  ]) {
    const model = modelReturning({ status: 'complete', lines });
    await assert.rejects(translateDocumentText({ model, source, language: 'Bulgarian', maxOutputTokens: 200 }), /пълен превод/u);
  }
  const truncated = modelReturning({ status: 'complete', lines: valid }, 'length');
  await assert.rejects(translateDocumentText({ model: truncated, source, language: 'Bulgarian', maxOutputTokens: 200 }), /пълен превод/u);
  await assert.rejects(translateDocumentText({
    model: modelReturning({ status: 'complete', lines: ['Промяна: 5 и $20.'] }),
    source: 'Change: -5 % and €20.', language: 'Bulgarian', maxOutputTokens: 200,
  }), /пълен превод/u);
});

test('rejects unusable source and cancellation without calling a model', async () => {
  const model = modelReturning({ status: 'complete', lines: ['Text'] });
  const input = { model, language: 'English' as const, maxOutputTokens: 200 };
  await assert.rejects(translateDocumentText({ ...input, source: ' ' }), /няма текст/u);
  await assert.rejects(translateDocumentText({ ...input, source: 'a'.repeat(5001) }), /5000 знака/u);
  await assert.rejects(translateDocumentText({ ...input, source: Array(37).fill('ред').join('\n') }), /36 реда/u);
  await assert.rejects(translateDocumentText({ ...input, source: 'Страница 1\n[Няма разчетен текст]\n\nСтраница 2\nДанни' }), /не са разчетени/u);
  await assert.rejects(translateDocumentText({ ...input, source: 'тест', signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(model.doGenerateCalls.length, 0);
});
