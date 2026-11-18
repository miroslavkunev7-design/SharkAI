import assert from 'node:assert/strict';
import test from 'node:test';
import { ZipArchive } from 'archiver';
import { PDFDocument } from 'pdf-lib';
import {
  applyLocalDocumentEdit, buildLocalDocument, extractLocalDocxText, hasExplicitDocumentBody,
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

test('rejects corrupt, oversized or unsupported documents and respects cancellation', async () => {
  await assert.rejects(extractLocalDocxText(Buffer.from('invalid zip')), LocalDocumentError);
  const docx = await buildLocalDocument('docx', 'Ограничение');
  await assert.rejects(readZipEntries(docx, { maxTotalBytes: 10 }), /Expanded ZIP size/u);
  await assert.rejects(buildLocalDocument('pdf', 'Текст', AbortSignal.abort()), { name: 'AbortError' });
  await assert.rejects(applyLocalDocumentEdit('pdf', Buffer.from('%PDF-'), 'Завърти страница 1 с 90°'), LocalDocumentError);
});
