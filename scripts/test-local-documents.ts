import assert from 'node:assert/strict';
import test from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { ZipArchive } from 'archiver';
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, StandardFonts, decodePDFRawStream, degrees } from 'pdf-lib';
import {
  applyLocalDocumentEdit, buildLocalDocument, editDocxWithModel, extractLocalDocxText, hasExplicitDocumentBody,
  isLocalDocumentEdit, LocalDocumentError,
} from '../lib/chat-documents.server';
import { readZipEntries } from '../lib/document-archive.server';

const mainPart = 'word/document.xml';

function zip(entries: Map<string, Buffer>) {
  return new Promise<Buffer>((resolve, reject) => {
    const archive = new ZipArchive();
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, bytes] of entries) archive.append(bytes, { name });
    void archive.finalize().catch(reject);
  });
}

test('creates a real DOCX and reads literal Bulgarian text with XML characters', async () => {
  assert.equal(hasExplicitDocumentBody('Създай DOCX със съдържание:\nПърви ред'), true);
  const body = 'Проверка: цена < 10 & количество > 3\nТест\tКолона';
  const content = await buildLocalDocument('docx', body);
  const entries = await readZipEntries(content);
  assert.ok(entries.has('[Content_Types].xml'));
  assert.equal(await extractLocalDocxText(content), body);
});

test('replaces DOCX text across formatting runs and preserves unrelated parts', async () => {
  const fixture = await buildLocalDocument('docx', 'Старо име и Старо име на същия ред.');
  const entries = await readZipEntries(fixture);
  const originalMain = entries.get(mainPart)!.toString().replace(
    '<w:r><w:t xml:space="preserve">Старо име и Старо име на същия ред.</w:t></w:r>',
    '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Старо </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>име и Старо име на същия ред.</w:t></w:r>',
  );
  entries.set(mainPart, Buffer.from(originalMain));
  entries.set('docProps/other.xml', Buffer.from('<original>Unrelated package part</original>'));
  const original = await zip(entries);
  const updated = await applyLocalDocumentEdit('docx', original, 'Редактирай DOCX: Замени „Старо име“ с „& ново“');
  assert.ok(updated);
  assert.equal(await extractLocalDocxText(original), 'Старо име и Старо име на същия ред.');
  assert.equal(await extractLocalDocxText(updated), '& ново и & ново на същия ред.');
  const revisedEntries = await readZipEntries(updated);
  const revisedMain = revisedEntries.get(mainPart)!.toString();
  assert.match(revisedMain, /<w:b\//u);
  assert.match(revisedMain, /<w:i\//u);
  assert.deepEqual(revisedEntries.get('docProps/other.xml'), entries.get('docProps/other.xml'));
  const appended = await applyLocalDocumentEdit('docx', updated, 'Добави в края:\nДопълнение');
  assert.ok(appended);
  assert.match(await extractLocalDocxText(appended), /\nДопълнение$/u);
  await assert.rejects(applyLocalDocumentEdit('docx', original, 'Замени „Липсва“ с „Текст“'), LocalDocumentError);
});

test('writes real PDFs and rotates, appends and removes pages in a new copy', async () => {
  assert.equal(isLocalDocumentEdit('Завърти страница 1 с 90°', 'application/pdf'), true);
  assert.equal(isLocalDocumentEdit('Замени „А“ с „Б“', 'application/pdf'), false);
  const original = await buildLocalDocument('pdf', 'Отчет на български.');
  assert.equal(original.subarray(0, 5).toString('ascii'), '%PDF-');
  const rotated = await applyLocalDocumentEdit('pdf', original, 'Завърти страница 1 с 90°');
  assert.ok(rotated);
  assert.equal((await PDFDocument.load(rotated)).getPage(0).getRotation().angle, 90);
  assert.equal((await PDFDocument.load(original)).getPage(0).getRotation().angle, 0);
  const appended = await applyLocalDocumentEdit('pdf', rotated, 'Добави в края:\nВтора страница.');
  assert.ok(appended);
  assert.equal((await PDFDocument.load(appended)).getPageCount(), 2);
  const reduced = await applyLocalDocumentEdit('pdf', appended, 'Премахни страница 1');
  assert.ok(reduced);
  assert.equal((await PDFDocument.load(reduced)).getPageCount(), 1);
  assert.equal((await PDFDocument.load(reduced)).getPage(0).getRotation().angle, 0);
  await assert.rejects(applyLocalDocumentEdit('pdf', original, 'Премахни страница 1'), LocalDocumentError);
});

function pdfStreams(pdf: PDFDocument, pageIndex: number) {
  const contents = pdf.getPage(pageIndex).node.Contents();
  const objects = contents instanceof PDFArray ? contents.asArray().map((entry) => pdf.context.lookup(entry)) : [contents];
  return objects.flatMap((object) => object instanceof PDFRawStream ? [Buffer.from(decodePDFRawStream(object).decode()).toString('ascii')] : []);
}

function lastTextMatrix(content: string) {
  const matrix = content.split('\n').findLast((line) => line.endsWith(' Tm'));
  assert.ok(matrix);
  return matrix.split(' ').slice(0, 6).map(Number);
}

test('draws upright PDF labels at displayed points and keeps unrelated pages, crop, forms and annotations', async () => {
  const source = await PDFDocument.create();
  source.setTitle('Original QA document');
  const firstPage = source.addPage([250, 300]);
  const target = source.addPage([400, 500]);
  target.setCropBox(20, 30, 300, 400);
  target.setRotation(degrees(90));
  target.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  const font = await source.embedFont(StandardFonts.Helvetica);
  firstPage.drawText('Original page 1', { x: 40, y: 250, font });
  target.drawText('Original page 2', { x: 48, y: 250, font });
  const field = source.getForm().createTextField('original-field');
  field.setText('Retain this value');
  field.addToPage(firstPage, { x: 36, y: 36, width: 110, height: 24, font });
  const link = source.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [48, 225, 130, 242],
    A: { S: 'URI', URI: PDFString.of('https://example.com/') },
  });
  target.node.addAnnot(source.context.register(link));
  const original = Buffer.from(await source.save());
  const originalBytes = Buffer.from(original);
  const before = await PDFDocument.load(original, { updateMetadata: false });
  const prompt = 'Редактирай PDF: Добави текст на страница 2 при x=48, y=60, размер 12: Одобрено\n18.11.2026';
  assert.equal(isLocalDocumentEdit(prompt, 'application/pdf'), true);
  assert.equal(isLocalDocumentEdit(prompt, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), false);
  const result = await applyLocalDocumentEdit('pdf', original, prompt);
  assert.ok(result);
  const after = await PDFDocument.load(result, { updateMetadata: false });
  assert.deepEqual(original, originalBytes);
  assert.equal(after.getTitle(), 'Original QA document');
  assert.equal(after.getPageCount(), 2);
  assert.deepEqual(after.getPage(1).getCropBox(), before.getPage(1).getCropBox());
  assert.equal(after.getPage(1).getRotation().angle, 90);
  assert.equal(after.getPage(1).node.Annots()?.size(), 1);
  assert.equal(after.getForm().getTextField('original-field').getText(), 'Retain this value');
  assert.deepEqual(pdfStreams(after, 0), pdfStreams(before, 0));
  const existing = pdfStreams(before, 1);
  const streams = pdfStreams(after, 1);
  assert.ok(existing.length && existing.every((stream) => streams.includes(stream)));
  const overlay = streams.find((stream) => stream.includes('NotoSans'));
  assert.ok(overlay);
  assert.match(overlay, / 6 Tf/u); // 12 physical points with a page UserUnit of 2.
  const [a, b, c, d, x, y] = lastTextMatrix(overlay);
  assert.ok(Math.abs(a) < 1e-10 && Math.abs(d) < 1e-10 && b === 1 && c === -1);
  assert.ok(x > 50 && x < 73);
  assert.equal(y, 54); // Crop bottom 30 + 48 displayed points / UserUnit 2.
});

test('supports corner placement and refuses invalid sizes, overflowing text, missing pages and signed PDFs', async () => {
  const source = await PDFDocument.create();
  source.addPage([200, 300]);
  const original = Buffer.from(await source.save());
  const prompt = 'Please add a note on page 1, top right, size 10: Approved';
  assert.equal(isLocalDocumentEdit(prompt, 'application/pdf'), true);
  const result = await applyLocalDocumentEdit('pdf', original, prompt);
  assert.ok(result);
  const pdf = await PDFDocument.load(result);
  const drawn = pdfStreams(pdf, 0).find((stream) => stream.includes('NotoSans'));
  assert.ok(drawn);
  const [a, b, c, d, x, y] = lastTextMatrix(drawn);
  assert.deepEqual([a, b, c, d], [1, 0, 0, 1]);
  assert.ok(x > 100 && x < 164 && y > 240 && y < 264);
  const defaultResult = await applyLocalDocumentEdit('pdf', original, 'Добави текст на страница 1: Съгласувано');
  assert.ok(defaultResult);
  const defaultDrawing = pdfStreams(await PDFDocument.load(defaultResult), 0).find((stream) => stream.includes('NotoSans'));
  assert.ok(defaultDrawing);
  assert.equal(lastTextMatrix(defaultDrawing)[4], 36);
  for (const [invalid, expected] of [
    ['Add text to page 4: Missing', /посочи съществуваща страница/iu],
    ['Добави текст на страница 1 при x=195, y=49: Не се побира', /не се побира/iu],
    ['Добави текст на страница 1 при x=25, y=283: Непобиращ се текст\nВтори ред', /не се побира/iu],
    ['Добави текст на страница 1 при x=-2, y=20: Отвън', /между 0 и/iu],
    ['Add text to page 1 top right, size 2: Too small', /от 6 до 36/iu],
    ['Add text to page 1 at some location: Unspecified', /посочи позиция/iu],
    ['Add text to page 1: ' + 'a'.repeat(801), /до 800 знака/iu],
  ] as const) {
    await assert.rejects(applyLocalDocumentEdit('pdf', original, invalid), expected);
  }
  await assert.rejects(applyLocalDocumentEdit('pdf', original, prompt, AbortSignal.abort()), { name: 'AbortError' });
  source.catalog.set(PDFName.of('Perms'), source.context.obj({
    DocMDP: { Type: 'Sig', ByteRange: [0, 20, 41, 22], Contents: PDFHexString.of('FFFFFF') },
  }));
  const signedFixture = Buffer.from(await source.save());
  await assert.rejects(applyLocalDocumentEdit('pdf', signedFixture, prompt), /цифров подпис/iu);
});

test('rejects corrupt, oversized or unsupported documents and respects cancellation', async () => {
  await assert.rejects(extractLocalDocxText(Buffer.from('invalid zip')), LocalDocumentError);
  const docx = await buildLocalDocument('docx', 'Ограничение');
  await assert.rejects(readZipEntries(docx, { maxTotalBytes: 10 }), /Expanded ZIP size/u);
  await assert.rejects(buildLocalDocument('pdf', 'Текст', AbortSignal.abort()), { name: 'AbortError' });
  await assert.rejects(applyLocalDocumentEdit('pdf', Buffer.from('%PDF-'), 'Завърти страница 1 с 90°'), LocalDocumentError);
});

function planModel(plan: unknown, finish: 'stop' | 'length' = 'stop') {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text: JSON.stringify(plan) }],
      finishReason: { unified: finish, raw: finish },
      usage: {
        inputTokens: { total: 13, noCache: 13, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 7, text: 7, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

test('plans DOCX edits with the configured model and preserves formatting runs and package parts', async () => {
  const body = 'The library is opne on Friday.\nPostal code 1000.';
  const entries = await readZipEntries(await buildLocalDocument('docx', body));
  const originalMain = entries.get(mainPart)!.toString().replace(
    '<w:r><w:t xml:space="preserve">The library is opne on Friday.</w:t></w:r>',
    '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">The library is </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>opne on Friday.</w:t></w:r>',
  );
  entries.set(mainPart, Buffer.from(originalMain));
  entries.set('docProps/other.xml', Buffer.from('<original>Another package part</original>'));
  const original = await zip(entries);
  const digest = Buffer.from(original);
  const model = planModel({ status: 'complete', edits: [
    { paragraph: 1, before: 'The library is opne on Friday.', after: 'The library is open on Friday.' },
    { paragraph: 2, before: 'Postal code', after: 'ZIP code' },
  ] });
  const result = await editDocxWithModel(original, 'Fix the typo in the first sentence and use ZIP code.', model, { maxOutputTokens: 500 });
  assert.equal(result.usageTokens, 20);
  assert.deepEqual(original, digest);
  assert.equal(await extractLocalDocxText(result.bytes), 'The library is open on Friday.\nZIP code 1000.');
  const revised = await readZipEntries(result.bytes);
  assert.match(revised.get(mainPart)!.toString(), /<w:b\/><\/w:rPr><w:t xml:space="preserve">The library is <\/w:t>/u);
  assert.match(revised.get(mainPart)!.toString(), /<w:i\/><\/w:rPr><w:t>open on Friday.<\/w:t>/u);
  assert.deepEqual(revised.get('docProps/other.xml'), entries.get('docProps/other.xml'));
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(model.doGenerateCalls[0].responseFormat?.type, 'json');
  const crossStyles = planModel({ status: 'complete', edits: [{ paragraph: 1, before: 'library is opne', after: 'shop opens' }] });
  await assert.rejects(editDocxWithModel(original, 'Revise this sentence.', crossStyles, { maxOutputTokens: 100 }), /форматиране/u);
});

test('rejects incomplete, invented, unchanged and ambiguous model plans as a whole', async () => {
  const original = await buildLocalDocument('docx', 'apple is apple.\nThe old title is here in 2026.');
  const validEdit = { paragraph: 2, before: 'old title', after: 'revised title' };
  for (const plan of [
    { status: 'partial', edits: [validEdit] },
    { status: 'unsupported', edits: [] },
    { status: 'complete', edits: [] },
    { status: 'complete', edits: [{ ...validEdit, after: validEdit.before }] },
    { status: 'complete', edits: [validEdit, { paragraph: 1, before: 'apple', after: 'pear' }] },
    { status: 'complete', edits: [validEdit, { ...validEdit, paragraph: 4 }] },
    { status: 'complete', edits: [validEdit, { paragraph: 2, before: 'title is', after: 'heading is' }] },
    { status: 'complete', edits: [{ ...validEdit, after: 'https://invented.test' }] },
    { status: 'complete', edits: [{ ...validEdit, after: 'new title 234' }] },
    { status: 'complete', edits: [{ paragraph: 2, before: 'old title is here in 2026', after: 'revised title is here' }] },
    { status: 'complete', edits: [{ ...validEdit, after: '<w:p>unsafe</w:p>' }] },
  ]) {
    await assert.rejects(editDocxWithModel(original, 'Revise the title.', planModel(plan), { maxOutputTokens: 100 }), LocalDocumentError);
    assert.equal(await extractLocalDocxText(original), 'apple is apple.\nThe old title is here in 2026.');
  }
  const truncated = planModel({ status: 'complete', edits: [validEdit] }, 'length');
  await assert.rejects(editDocxWithModel(original, 'Revise the title.', truncated, { maxOutputTokens: 100 }), LocalDocumentError);
  const unchanged = await buildLocalDocument('docx', 'ab');
  const cancelingEdits = planModel({ status: 'complete', edits: [{ paragraph: 1, before: 'a', after: 'ab' }, { paragraph: 1, before: 'b', after: '' }] });
  await assert.rejects(editDocxWithModel(unchanged, 'Revise the text.', cancelingEdits, { maxOutputTokens: 100 }), LocalDocumentError);
  const oversized = await buildLocalDocument('docx', Array.from({ length: 81 }, () => 'Line').join('\n'));
  const unused = planModel({ status: 'complete', edits: [validEdit] });
  await assert.rejects(editDocxWithModel(oversized, 'Revise all lines.', unused, { maxOutputTokens: 100 }), /80 абзаца/u);
  assert.equal(unused.doGenerateCalls.length, 0);
});
