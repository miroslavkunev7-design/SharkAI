import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createNativeToolRouter, NativeToolSelectionError, streamWorkspaceReply } from '../lib/ai/workspace-tool-routing';
import { inferChatTool } from '../lib/chat-tools.server';
import type { ChatTool } from '../lib/chat-tools';

const registry = [
  ['document-export', true], ['text-file-create', true], ['image-properties', true], ['image-transform', true],
  ['document-read', true], ['document-edit', true], ['dataset-analysis', true], ['deep-research', true],
  ['image-generate', true], ['prompt-software', true], ['web-search', true], ['image-edit', true],
  ['spreadsheet-export', true], ['spreadsheet-edit', true],
].map(([id, available]): ChatTool => ({ id: String(id), available: Boolean(available), group: 'QA', input: 'prompt', label: String(id), description: '', platforms: ['web-desktop'] }));

const usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

function testModel(parts: LanguageModelV3StreamPart[], finish: 'stop' | 'tool-calls' = 'stop') {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: [
        { type: 'stream-start', warnings: [] },
        ...parts,
        { type: 'finish', finishReason: { unified: finish, raw: finish }, usage },
      ] }),
    }),
  });
}

function call(model: MockLanguageModelV3, options: Partial<Parameters<typeof streamWorkspaceReply>[0]> = {}) {
  return streamWorkspaceReply({ model, system: 'Fixture', messages: [{ role: 'user', content: 'Fixture' }], signal: new AbortController().signal, maxOutputTokens: 100, ...options });
}

test('only advertises available, strictly local tools compatible with the source file', () => {
  const router = createNativeToolRouter(registry, 'image/png', false)!;
  assert.deepEqual(Object.keys(router.tools), ['inspect_image', 'transform_image']);
  assert.deepEqual(router.validate('transform_image', { command: 'rotate by 90' }), { toolId: 'image-transform', prompt: 'rotate by 90', needsFile: true });
  assert.equal(router.validate('transform_image', { command: 'Fetch a remote background and add it' }), null);
  assert.equal(router.validate('inspect_image', { uploadId: 'foreign-upload' }), null);
  assert.equal(router.validate('deep-research', {}), null);
  const disabled = registry.map((tool) => ({ ...tool, available: false }));
  assert.equal(createNativeToolRouter(disabled, 'image/png'), undefined);
  const pdf = createNativeToolRouter(registry, 'application/pdf', false)!;
  assert.deepEqual(Object.keys(pdf.tools), ['edit_document']);
  assert.equal(pdf.validate('edit_document', { command: 'replace "A" with "B"' }), null);
  assert.equal(pdf.validate('edit_document', { command: 'rotate page 2 by 90' })?.toolId, 'document-edit');
  assert.equal(pdf.validate('edit_document', { command: 'add text to page 2 top right: Checked' })?.toolId, 'document-edit');
});

test('routes explicit spreadsheet output and edits separately from ordinary tabular answers', () => {
  assert.equal(inferChatTool('Моля, можеш ли да направиш таблица в Excel с имената и цените?', false), 'spreadsheet-export');
  assert.equal(inferChatTool('Create a file report.csv with data:\nItem,Price\nTea,2', false), 'spreadsheet-export');
  assert.equal(inferChatTool('Направи таблица с две колони.', false), undefined);
  assert.equal(inferChatTool('Промени клетка B2 на 125', true, 'text/csv'), 'spreadsheet-edit');
  assert.equal(inferChatTool('Начертай графика по колона Цена', true, 'text/csv'), 'dataset-analysis');

  const prompt = 'Може ли изтегляем XLSX с колони Име и Цена? Добави Чай със стойност 2.5.';
  const router = createNativeToolRouter(registry, 'text/csv', true, prompt)!;
  const selected = router.validate('export_spreadsheet', {});
  assert.equal(selected?.toolId, 'spreadsheet-export');
  assert.equal(selected?.prompt, prompt);
  assert.equal(router.validate('export_spreadsheet', { format: 'pdf', content: 'untrusted' }), null);
  assert.equal(createNativeToolRouter(registry, 'text/csv', true, 'Дай ми таблица в отговора.')?.validate('export_spreadsheet', {}), null);
  assert.equal(router.validate('edit_spreadsheet', { command: 'Set cell B2 to 4', fileId: 'foreign' }), null);
  assert.equal(router.validate('edit_spreadsheet', { command: 'Set cell B2 to 4' })?.needsFile, true);
});

test('suppresses text around a tool call, captures usage and emits one validated action', async () => {
  const model = testModel([
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: 'premature filler' },
    { type: 'text-end', id: 'text' },
    { type: 'tool-call', toolCallId: 'one', toolName: 'export_document', input: '{"format":"docx","content":"Проверен материал"}' },
  ], 'tool-calls');
  const deltas: string[] = [];
  const result = await call(model, { router: createNativeToolRouter(registry), onDelta: (text) => deltas.push(text) });
  assert.deepEqual(result, {
    text: '', tokens: 20, selection: { toolId: 'document-export', needsFile: false, prompt: 'Създай DOCX със съдържание:\nПроверен материал' },
  });
  assert.deepEqual(deltas, []);
  assert.equal(model.doGenerateCalls.length, 0);
  assert.equal(model.doStreamCalls.length, 1);
});

test('uses one completion for ordinary Work text and keeps streaming unassisted Chat deltas', async () => {
  const parts: LanguageModelV3StreamPart[] = [
    { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'Real ' },
    { type: 'text-delta', id: 'text', delta: 'answer' }, { type: 'text-end', id: 'text' },
  ];
  const model = testModel(parts);
  const deltas: string[] = [];
  const work = await call(model, { router: createNativeToolRouter(registry), onDelta: (text) => deltas.push(text) });
  assert.equal(work.text, 'Real answer');
  assert.equal(work.selection, null);
  assert.equal(model.doStreamCalls.length, 1);
  assert.deepEqual(deltas, ['Real answer']);
  deltas.length = 0;
  const normal = await call(testModel(parts), { onDelta: (text) => deltas.push(text) });
  assert.equal(normal.text, work.text);
  assert.deepEqual(deltas, ['Real ', 'answer']);
});

test('rejects unknown, provider-executed, invalid and multiple tool calls', async () => {
  const editor = { type: 'tool-call', toolCallId: 'first', toolName: 'edit_document', input: '{"command":"remove page 2"}' } as const;
  const router = createNativeToolRouter(registry, 'application/pdf', false);
  for (const parts of [
    [{ ...editor, toolName: 'publish_external' }],
    [{ ...editor, providerExecuted: true }],
    [{ ...editor, input: '{"command":"recover the file password"}' }],
    [editor, { ...editor, toolCallId: 'second' }],
    [],
  ]) {
    await assert.rejects(call(testModel(parts, 'tool-calls'), { router }), NativeToolSelectionError);
  }
});
