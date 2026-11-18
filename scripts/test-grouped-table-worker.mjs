import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { ZipArchive } from 'archiver';
import { parse } from 'csv-parse/sync';

const csvMime = 'text/csv';
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const worker = new URL('../lib/table-worker.mjs', import.meta.url);
const usePlan = { operation: 'grouped', groupBy: 'City', aggregations: [{ operation: 'count' }] };

function analyze(input, plan, { mimeType = csvMime, prompt = 'Analyze and group tables' } = {}) {
  const request = Buffer.concat([Buffer.from(JSON.stringify({ prompt, mimeType, plan }) + '\n'), Buffer.from(input)]);
  const child = spawnSync(process.execPath, [worker.pathname], { input: request, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  return JSON.parse(child.stdout);
}

function csvRows(output) {
  assert.ok(output.result, output.failure?.message);
  assert.equal(output.result.mimeType, csvMime);
  return parse(Buffer.from(output.result.artifact, 'base64'), { bom: true });
}

test('computes filtered numeric groups and counts without rounding tails or formula cells', () => {
  const input = [
    'City;Amount;Date', 'Sofia;0,10;2026-01-01', 'Sofia;0,20;2026-01-02', 'Sofia;;2026-01-03',
    'Sofia;none;2026-01-02', 'Plovdiv;-3;2026-01-02', 'Plovdiv;4;2025-12-31', '=NA();-5;2026-01-03',
  ].join('\n');
  const analysis = analyze(input, { ...usePlan, aggregations: [
    { operation: 'sum', column: 'Amount', label: 'Total' }, { operation: 'average', column: 'Amount' },
    { operation: 'min', column: 'Amount' }, { operation: 'max', column: 'Amount' }, { operation: 'count', column: 'Amount' },
  ], filters: [
    { column: 'Date', operation: 'between', kind: 'date', value: '2026-01-01', end: '2026-01-03' },
    { column: 'City', operation: 'neq', kind: 'text', value: 'Varna' },
  ], sort: { column: 'Total', direction: 'desc' } });
  assert.equal(analysis.result.filename, 'sharkai-grouped-analysis.csv');
  assert.match(analysis.result.text, /6 от 7 реда · 3 групи/u);
  assert.match(analysis.result.text, /„Sofia“ · Total 0,3 · Средно Amount 0,15/u);
  assert.match(analysis.result.text, /Извън филтъра: 1 реда/u);
  assert.match(analysis.result.text, /1 празни и 1 нечислови/u);
  assert.deepEqual(csvRows(analysis), [
    ['City', 'Total', 'Средно Amount', 'Минимум Amount', 'Максимум Amount', 'Брой Amount'],
    ['Sofia', '0.3', '0.15', '0.1', '0.2', '3'],
    ['Plovdiv', '-3', '-3', '-3', '-3', '1'],
    ["'=NA()", '-5', '-5', '-5', '-5', '1'],
  ]);
});

test('compares typed literals and reports an empty filtered report as a valid CSV', () => {
  const input = 'City,Amount\nB,002\nA,3\nA,0\nB,none\n';
  const filtered = analyze(input, { ...usePlan, filters: [
    { column: 'Amount', kind: 'number', operation: 'gte', value: 2 },
  ] });
  assert.deepEqual(csvRows(filtered), [['City', 'Брой'], ['B', '1'], ['A', '1']]);
  const text = analyze(input, { ...usePlan, filters: [
    { column: 'Amount', kind: 'text', operation: 'eq', value: '2' },
  ] });
  assert.deepEqual(csvRows(text), [['City', 'Брой']]);
  assert.match(text.result.text, /0 от 4 реда · 0 групи/u);
});

test('refuses incorrect headers, ambiguous output and invalid bounds without a fallback summary', () => {
  const input = 'City,Amount\nA,10\n';
  const cases = [
    [{ ...usePlan, groupBy: 'city' }, /Липсва колоната/u],
    [{ ...usePlan, aggregations: [{ operation: 'count', label: 'City' }] }, /различни заглавия/u],
    [{ ...usePlan, sort: { column: 'missing', direction: 'asc' } }, /сортиране/u],
    [{ ...usePlan, aggregations: [{ operation: ['count'] }] }, /Невалидни/u],
    [{ ...usePlan, filters: [{ column: 'Amount', kind: 'number', operation: 'eq', value: '10' }] }, /Невалидни/u],
    [{ ...usePlan, filters: [{ column: 'City', kind: 'text', operation: 'gte', value: 'A' }] }, /Невалидни/u],
    [{ ...usePlan, filters: [{ column: 'Amount', kind: 'date', operation: 'gte', value: '2026-02-30' }] }, /Невалидни/u],
    [{ ...usePlan, filters: [{ column: 'Amount', kind: 'date', operation: 'between', value: '2026-01-02', end: '2026-01-01' }] }, /Невалидни/u],
  ];
  for (const [plan, error] of cases) {
    const output = analyze(input, plan);
    assert.equal(output.failure?.status, 422);
    assert.match(output.failure.message, error);
  }
  assert.match(analyze('City,City\nA,B\n', usePlan).failure.message, /повече от веднъж/u);
});

test('uses the validated shared grammar when a grouped request arrives without its plan', () => {
  const input = 'City,Amount\nA,6\nB,5\n';
  const output = analyze(input, undefined, { prompt: 'Sum "Amount" by "City"; where "Amount" > 5' });
  assert.deepEqual(csvRows(output), [['City', 'Сума Amount'], ['A', '6']]);
  const ambiguous = analyze(input, undefined, { prompt: 'Sum "Amount" by "City"; only recent orders' });
  assert.equal(ambiguous.failure?.status, 422);
  assert.match(ambiguous.failure.message, /Пример за групиране/u);
});

test('caps groups without returning partial data', () => {
  const input = ['City', ...Array.from({ length: 3001 }, (_, index) => `Group ${index}`)].join('\n');
  const result = analyze(input, usePlan);
  assert.equal(result.failure?.status, 413);
  assert.match(result.failure.message, /3000 групи/u);
});

test('previews the first eight groups and leaves every row in the downloadable report', () => {
  const input = ['City', ...Array.from({ length: 10 }, (_, index) => `Group ${index}`)].join('\n');
  const output = analyze(input, usePlan);
  assert.match(output.result.text, /„Group 7“ · Брой 1/u);
  assert.doesNotMatch(output.result.text, /„Group 8“/u);
  assert.match(output.result.text, /първите 8 групи/u);
  assert.equal(csvRows(output).length, 11);
});

function workbook({ epoch1904 = false }) {
  const dates = epoch1904 ? ['0', '1'] : ['45292', '45293'];
  const header = ['City', 'Date', 'Amount'].map((name, index) => `<c r="${'ABC'[index]}1" t="inlineStr"><is><t>${name}</t></is></c>`).join('');
  const rows = dates.map((value, index) => `<row><c r="A${index + 2}" t="inlineStr"><is><t>A</t></is></c><c r="B${index + 2}" s="1"><v>${value}</v></c><c r="C${index + 2}"><f>2+2</f><v>4</v></c></row>`).join('');
  const files = {
    'xl/workbook.xml': `<workbook xmlns:r="urn:fixture"><workbookPr date1904="${epoch1904 ? 1 : 0}"/><sheets><sheet name="Sales" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="urn/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row>${header}</row>${rows}</sheetData></worksheet>`,
  };
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive();
    const chunks = [];
    archive.on('data', (data) => chunks.push(data));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, value] of Object.entries(files)) archive.append(value, { name });
    void archive.finalize().catch(reject);
  });
}

test('filters actual Excel dates from both workbook epochs and retains cached formula totals', async () => {
  for (const [epoch1904, date] of [[false, '2024-01-01'], [true, '1904-01-01']]) {
    const result = analyze(await workbook({ epoch1904 }), {
      ...usePlan, sheet: 'Sales', groupBy: 'Date', aggregations: [{ operation: 'sum', column: 'Amount' }],
      filters: [{ column: 'Date', kind: 'date', operation: 'eq', value: date }],
    }, { mimeType: xlsxMime });
    assert.deepEqual(csvRows(result), [['Date', 'Сума Amount'], [date, '4']]);
    assert.match(result.result.text, /Sales.+1 от 2 реда/u);
    assert.match(result.result.text, /Формули в източника: 2/u);
  }
});
