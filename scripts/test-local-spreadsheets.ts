import assert from 'node:assert/strict';
import test from 'node:test';
import { ZipArchive } from 'archiver';
import { parse } from 'csv-parse/sync';
import {
  createLocalSpreadsheet, editLocalSpreadsheet, hasExplicitSpreadsheetData, isLocalSpreadsheetEdit,
  spreadsheetInputSchema, SpreadsheetInputError, validateSpreadsheetDraft,
} from '../lib/chat-spreadsheets.server';
import { readZipEntries } from '../lib/document-archive.server';

const sheetFile = 'xl/worksheets/sheet1.xml';
const bookFile = 'xl/workbook.xml';
const workbookRels = 'xl/_rels/workbook.xml.rels';

test('validates model workbook columns without changing identifiers or accepting invalid numeric data', () => {
  const draft = { headers: ['SKU', 'Quantity'], numericColumns: [1], rows: [['0042', '2.5'], ['0043', null], ['0044', 3]] };
  assert.deepEqual(validateSpreadsheetDraft(draft)?.rows, [['0042', 2.5], ['0043', null], ['0044', 3]]);
  for (const value of ['003', 'about 4', '9007199254740992', true]) {
    assert.equal(validateSpreadsheetDraft({ ...draft, rows: [['0042', value]] }), undefined);
  }
  assert.equal(validateSpreadsheetDraft({ ...draft, numericColumns: [2] }), undefined);
  assert.equal(validateSpreadsheetDraft({ ...draft, rows: [['0042']] }), undefined);
});

function archive(entries: Map<string, Buffer>) {
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new ZipArchive();
    const chunks: Buffer[] = [];
    zip.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.on('error', reject);
    zip.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, content] of entries) zip.append(content, { name });
    void zip.finalize().catch(reject);
  });
}

test('creates and edits CSV with UTF-8, typed values, escaping and inert formula-like fields', async () => {
  const input = `Създай CSV с данни:\n${JSON.stringify([['Име', 'Цена', 'Бележка'], ['Варна', -12, 'текст, с "кавички"'], ['София', 5, '=SUM(B2:B3)'], ['Бургас', 3, '＠cmd']])}`;
  assert.equal(hasExplicitSpreadsheetData(input), true);
  const original = await createLocalSpreadsheet('csv', input);
  const content = [
    ['Име', 'Цена', 'Бележка'], ['Варна', '-12', 'текст, с "кавички"'], ['София', '5', "'=SUM(B2:B3)"], ['Бургас', '3', "'＠cmd"],
  ];
  assert.deepEqual(parse(original, { bom: true }), content);
  const command = 'Моля, редактирай CSV: промени клетка B2 на 125';
  assert.equal(isLocalSpreadsheetEdit(command), true);
  const revised = await editLocalSpreadsheet('csv', original, command);
  assert.deepEqual(parse(revised, { bom: true }), [content[0], ['Варна', '125', content[1][2]], content[2], content[3]]);
  assert.deepEqual(parse(original, { bom: true }), content);
  const semicolon = await createLocalSpreadsheet('csv', 'Create CSV with data:\nname;number\n001;7');
  const cleared = await editLocalSpreadsheet('csv', semicolon, 'Clear cell B2');
  assert.deepEqual(parse(cleared, { bom: true, delimiter: ';' }), [['name', 'number'], ['001', '']]);
});

test('generates standard XLSX relationships and payloads for text, dates-as-text, numbers and booleans', async () => {
  const typed = spreadsheetInputSchema.parse({ sheetName: 'Продажби & март', headers: ['Код', 'Приход', 'Потвърдено', 'Бележка'],
    rows: [['001', 18.75, true, 'a & b < c'], ['2026-11-18', -2, false, '=SUM(B2:B3)'], [null, 0, null]] });
  const original = await createLocalSpreadsheet('xlsx', '', typed);
  const zip = await readZipEntries(original);
  assert.ok(zip.has('[Content_Types].xml') && zip.has('_rels/.rels') && zip.has(workbookRels));
  assert.match(zip.get(bookFile)!.toString(), /name="Продажби &amp; март"/u);
  const xml = zip.get(sheetFile)!.toString();
  assert.match(xml, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">001<\/t>/u);
  assert.match(xml, /<c r="B2"><v>18\.75<\/v><\/c>/u);
  assert.match(xml, /<c r="C2" t="b"><v>1<\/v>/u);
  assert.match(xml, /a &amp; b &lt; c/u);
  assert.match(xml, /<t xml:space="preserve">=SUM\(B2:B3\)<\/t>/u);
  assert.doesNotMatch(xml, /<f[\s>]/u);
  const edited = await editLocalSpreadsheet('xlsx', original, 'Промени клетка B2 в лист „Продажби & март“ на -125');
  const revision = await readZipEntries(edited);
  assert.match(revision.get(sheetFile)!.toString(), /<c r="B2"><v>-125<\/v><\/c>/u);
  for (const [name, content] of zip) if (name !== sheetFile) assert.deepEqual(revision.get(name), content);
});

test('keeps formula identities, stored caches and styles while requesting recalculation', async () => {
  const input = await createLocalSpreadsheet('xlsx', 'Create XLSX with data:\n[["A","Total"],[8,9]]');
  const entries = await readZipEntries(input);
  entries.set(sheetFile, Buffer.from(entries.get(sheetFile)!.toString().replace('<c r="A2">', '<c r="A2" s="2">').replace('<c r="B2"><v>9</v></c>', '<c r="B2"><f>A2+1</f><v>9</v></c>')));
  entries.set(bookFile, Buffer.from(entries.get(bookFile)!.toString().replace('</workbook>', '<calcPr calcId="191029" calcMode="manual" fullCalcOnLoad="0"/></workbook>')));
  entries.set('docProps/fixture.xml', Buffer.from('<metadata>Untouched</metadata>'));
  const original = await archive(entries);
  const edited = await editLocalSpreadsheet('xlsx', original, 'Please, set cell A2 to 10');
  const revision = await readZipEntries(edited);
  assert.match(revision.get(sheetFile)!.toString(), /<c r="A2" s="2"><v>10<\/v><\/c>/u);
  assert.match(revision.get(sheetFile)!.toString(), /<f>A2\+1<\/f><v>9<\/v>/u);
  assert.match(revision.get(bookFile)!.toString(), /calcMode="manual" fullCalcOnLoad="1"/u);
  assert.deepEqual(revision.get('docProps/fixture.xml'), entries.get('docProps/fixture.xml'));
  assert.match((await readZipEntries(original)).get(sheetFile)!.toString(), /<c r="A2" s="2"><v>8<\/v>/u);
  await assert.rejects(editLocalSpreadsheet('xlsx', edited, 'Set cell B2 to 2'), /формула/u);
});

test('rejects malformed or ambiguous input, foreign worksheet relationships and out-of-range edits', async () => {
  const original = await createLocalSpreadsheet('xlsx', 'Create XLSX with data:\nname,value\nShop,2');
  await assert.rejects(createLocalSpreadsheet('csv', 'Create a CSV'), SpreadsheetInputError);
  await assert.rejects(createLocalSpreadsheet('xlsx', 'Create XLSX with data:\n[["A"],[100000000000000001]]'), /кавички/u);
  await assert.rejects(createLocalSpreadsheet('xlsx', 'Create XLSX with data:\n{"headers":["x"],"rows":[[1]],"sheetName":"x/y"}'), /име/iu);
  await assert.rejects(editLocalSpreadsheet('xlsx', original, 'Set cell C3 to 25'), /не присъства/u);
  await assert.rejects(editLocalSpreadsheet('xlsx', original, 'Set cell D99999 to 3'), /2 001 реда/u);
  await assert.rejects(editLocalSpreadsheet('xlsx', original, 'Set cell B2 to {"bad":1}'), /стойност/u);
  await assert.rejects(editLocalSpreadsheet('xlsx', original, 'Set cell B2 to 4', AbortSignal.abort()), { name: 'AbortError' });
  const forged = await readZipEntries(original);
  forged.set(workbookRels, Buffer.from(forged.get(workbookRels)!.toString().replace('Target="worksheets/sheet1.xml"', 'Target="https://example.test/worksheet.xml" TargetMode="External"')));
  await assert.rejects(editLocalSpreadsheet('xlsx', await archive(forged), 'Set cell B2 to 3'), /локална/u);
});
