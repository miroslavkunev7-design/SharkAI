import { DOMParser, XMLSerializer, onWarningStopParsing, type Document, type Element } from '@xmldom/xmldom';
import { ZipArchive } from 'archiver';
import { parse as parseCsv } from 'csv-parse/sync';
import path from 'node:path';
import { SaxesParser } from 'saxes';
import { z } from 'zod';
import { readZipEntries } from './document-archive.server';
import { mimeFromExt, saveUpload } from './uploads';

const maxRows = 2001;
const maxColumns = 80;
const maxCells = 50_000;
const maxInputBytes = 4 * 1024 * 1024;
const maxXmlBytes = 8 * 1024 * 1024;
const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const spreadsheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const strictSpreadsheetNs = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const packageRels = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const strictOfficeRels = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const xmlNs = 'http://www.w3.org/XML/1998/namespace';
const xlsxContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

export const spreadsheetCellSchema = z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]);
export const spreadsheetInputSchema = z.object({
  headers: z.array(z.string().min(1).max(200)).min(1).max(maxColumns),
  rows: z.array(z.array(spreadsheetCellSchema).max(maxColumns)).max(maxRows - 1),
  sheetName: z.string().min(1).max(31).nullable().optional(),
}).strict();

export type SpreadsheetInput = z.infer<typeof spreadsheetInputSchema>;
type Cell = z.infer<typeof spreadsheetCellSchema>;
type SpreadsheetFormat = 'csv' | 'xlsx';
type Grid = { rows: Cell[][]; sheetName?: string; delimiter?: ',' | ';' | '\t' };
type CellEdit = { address: string; column: number; row: number; sheet?: string; value: Cell };

export class SpreadsheetInputError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

const explicitData = /(?:^|\s)(?:с данни|със съдържание|със следните данни|with data|with content|with the following data)\s*:[ \t]*(?:\r?\n)?([\s\S]*)$/iu;
const editPrefix = /^(?:(?:редактирай|поправи)(?: прикачената)?|(?:edit|revise)(?: the)?(?: attached)?)\s+(?:csv|xlsx|excel|таблицата)\s*[:—–-]\s*/iu;
const updateCell = /^(?:промени|задай|поправи|смени|set|change)\s+(?:клетка(?:та)?|cell)\s+([a-z]{1,3}[1-9]\d{0,4})(?:\s+(?:в лист|in sheet)\s+["„“]([^"“”]+)["“”])?\s+(?:на|to|=)\s*([\s\S]+)$/iu;
const clearCell = /^(?:изчисти|clear)\s+(?:клетка(?:та)?|cell)\s+([a-z]{1,3}[1-9]\d{0,4})(?:\s+(?:в лист|in sheet)\s+["„“]([^"“”]+)["“”])?\s*[.!]?$/iu;
const illegalXml = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u;

export function hasExplicitSpreadsheetData(prompt: string) { return explicitData.test(prompt); }

function editCommand(prompt: string) {
  const polite = /^(?:моля|please)[,\s]+/iu;
  return prompt.trim().replace(polite, '').replace(editPrefix, '').replace(polite, '');
}

export function isLocalSpreadsheetEdit(prompt: string) {
  const command = editCommand(prompt);
  return updateCell.test(command) || clearCell.test(command);
}

function readAddress(address: string) {
  const parts = /^([A-Z]{1,3})([1-9]\d{0,6})$/u.exec(address);
  if (!parts) return null;
  const column = [...parts[1]].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0);
  return { column, row: Number(parts[2]) };
}

function columnName(index: number) {
  let name = '';
  for (let value = index; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode((value - 1) % 26 + 65) + name;
  return name;
}

function checkedCell(value: unknown): Cell {
  const parsed = spreadsheetCellSchema.safeParse(value);
  if (!parsed.success || (typeof parsed.data === 'string' && illegalXml.test(parsed.data))) {
    throw new SpreadsheetInputError('Клетката трябва да съдържа текст до 2 000 знака, крайно число, true, false или null.');
  }
  if (typeof parsed.data === 'number' && Number.isInteger(parsed.data) && !Number.isSafeInteger(parsed.data)) {
    throw new SpreadsheetInputError('За дълги цели стойности и идентификатори използвай текст в кавички, за да се запазят точно.');
  }
  return parsed.data;
}

function literalCell(raw: string): Cell {
  const text = raw.trim();
  if (/^(?:null|true|false)$/u.test(text)) return JSON.parse(text);
  if (/^["[{]/u.test(text)) {
    try { return checkedCell(JSON.parse(text)); }
    catch { throw new SpreadsheetInputError('Въведи валидна единична стойност. За текст използвай двойни кавички.'); }
  }
  return checkedCell(csvScalar(text));
}

function requestedEdit(prompt: string): CellEdit {
  const command = editCommand(prompt);
  const update = updateCell.exec(command);
  const match = update ?? clearCell.exec(command);
  if (!match) throw new SpreadsheetInputError('Посочи клетка и стойност, например „Промени клетка B2 на 125“.');
  const address = match[1].toUpperCase();
  const position = readAddress(address);
  if (!position || position.row > maxRows || position.column > maxColumns) {
    throw new SpreadsheetInputError('Локалният редактор поддържа първите 2 001 реда и 80 колони.', 413);
  }
  return { address, ...position, sheet: match[2], value: update ? literalCell(update[3]) : null };
}

function csvScalar(value: string): string | number {
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number) && String(number) === value && (!Number.isInteger(number) || Number.isSafeInteger(number))) return number;
  }
  return value;
}

function readCommaSeparated(input: string): Grid {
  const limits = { bom: true, skip_empty_lines: true, relax_column_count_less: true, max_record_size: 180_000 };
  let delimiter: Grid['delimiter'] = ',';
  let columns = 0;
  for (const separator of [',', ';', '\t'] as const) {
    try {
      const [header] = parseCsv(input, { ...limits, delimiter: separator, to: 1 }) as string[][];
      if (header?.length > columns) { columns = header.length; delimiter = separator; }
    } catch { /* Try another delimiter. */ }
  }
  try {
    // Read one row beyond the supported range so oversized input is rejected, never silently truncated.
    const rows = (parseCsv(input, { ...limits, delimiter, to: maxRows + 1 }) as string[][]).map((row) => row.map(csvScalar));
    return { rows, delimiter };
  } catch { throw new SpreadsheetInputError('Данните не са валиден CSV с еднакъв брой колони и балансирани кавички.'); }
}

function structuredGrid(input: unknown): Grid {
  if (Array.isArray(input) && input.every((row) => Array.isArray(row))) {
    if (input.length > maxRows || input.some((row) => row.length > maxColumns)) {
      throw new SpreadsheetInputError('Таблицата поддържа до 2 001 реда и 80 колони.', 413);
    }
    return { rows: input.map((row) => row.map(checkedCell)) };
  }
  const structured = spreadsheetInputSchema.safeParse(input);
  if (!structured.success) throw new SpreadsheetInputError('Използвай JSON масив от редове или обект с headers, rows и незадължително sheetName.');
  const { headers, rows, sheetName } = structured.data;
  return { rows: [headers, ...rows], sheetName: sheetName ?? undefined };
}

function sourceGrid(prompt: string, data?: SpreadsheetInput): Grid {
  if (data !== undefined) return structuredGrid(data);
  const raw = explicitData.exec(prompt)?.[1];
  if (!raw?.trim()) throw new SpreadsheetInputError('Въведи данни след „с данни:“, като JSON редове или CSV.', 400);
  if (Buffer.byteLength(raw, 'utf8') > maxInputBytes) throw new SpreadsheetInputError('Данните трябва да са до 4 MB.', 413);
  if (!/^[\[{]/u.test(raw.trimStart())) return readCommaSeparated(raw);
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch { throw new SpreadsheetInputError('Табличният JSON е невалиден.'); }
  return structuredGrid(json);
}

function validateGrid(grid: Grid) {
  const width = grid.rows[0]?.length || 0;
  if (!width || !grid.rows.some((row) => row.some((value) => value !== null && value !== ''))) {
    throw new SpreadsheetInputError('Таблицата няма данни. Добави поне една непразна клетка.');
  }
  if (grid.rows.length > maxRows || width > maxColumns || grid.rows.length * width > maxCells) {
    throw new SpreadsheetInputError('Таблицата поддържа до 2 001 реда, 80 колони и 50 000 клетки.', 413);
  }
  if (grid.rows.some((row) => row.length > width)) throw new SpreadsheetInputError('Има ред с повече колони от първия ред.');
  let bytes = 0;
  for (const row of grid.rows) for (const cell of row) {
    checkedCell(cell);
    bytes += cell === null ? 0 : Buffer.byteLength(String(cell), 'utf8');
    if (bytes > maxInputBytes) throw new SpreadsheetInputError('Съдържанието на таблицата трябва да е до 4 MB.', 413);
  }
  if (grid.sheetName && (illegalXml.test(grid.sheetName) || /[\[\]:*?/\\\r\n\t]|^'|'$/u.test(grid.sheetName))) {
    throw new SpreadsheetInputError('Името на листа съдържа неподдържани знаци.');
  }
  return width;
}

function quoteCsv(cell: Cell, delimiter: string) {
  if (cell === null) return '';
  let value = typeof cell === 'boolean' ? (cell ? 'TRUE' : 'FALSE') : String(cell);
  if (typeof cell === 'string' && (/^\s*[=+@－＋＝＠-]/u.test(value) || /^[\t\r\n]/u.test(value))) value = `'${value}`;
  return value.includes(delimiter) || /["\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

function csvBytes(grid: Grid, width: number) {
  const delimiter = grid.delimiter ?? ',';
  const rows = grid.rows.map((row) => Array.from({ length: width }, (_, index) => quoteCsv(row[index] ?? null, delimiter)).join(delimiter));
  return Buffer.from(`\uFEFF${rows.join('\r\n')}\r\n`, 'utf8');
}

function xml(value: string) { return value.replace(/[&<>"'\r]/gu, (part) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;' })[part]!); }

function xlsxCell(address: string, value: Cell) {
  if (value === null) return `<c r="${address}"/>`;
  if (typeof value === 'string') return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  if (typeof value === 'boolean') return `<c r="${address}" t="b"><v>${Number(value)}</v></c>`;
  return `<c r="${address}"><v>${value}</v></c>`;
}

function zipWorkbook(entries: Map<string, Buffer>, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    const cancel = () => fail(signal?.reason);
    function fail(error: unknown) {
      signal?.removeEventListener('abort', cancel);
      archive.destroy();
      reject(error);
    }
    archive.on('error', fail);
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => { signal?.removeEventListener('abort', cancel); resolve(Buffer.concat(chunks)); });
    signal?.addEventListener('abort', cancel, { once: true });
    for (const [name, bytes] of entries) archive.append(bytes, { name });
    void archive.finalize().catch(fail);
  });
}

function newXlsx(grid: Grid, width: number, signal?: AbortSignal) {
  const sheet = xml(grid.sheetName ?? 'Таблица');
  const rows = grid.rows.map((row, index) => `<row r="${index + 1}">${Array.from({ length: width }, (_, col) => xlsxCell(`${columnName(col + 1)}${index + 1}`, row[col] ?? null)).join('')}</row>`).join('');
  const dimension = `A1:${columnName(width)}${grid.rows.length}`;
  return zipWorkbook(new Map([
    ['[Content_Types].xml', Buffer.from(`${xmlDeclaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${xlsxContentType}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${xlsxContentType}.worksheet+xml"/></Types>`)],
    ['_rels/.rels', Buffer.from(`${xmlDeclaration}<Relationships xmlns="${packageRels}"><Relationship Id="rId1" Type="${officeRels}/officeDocument" Target="xl/workbook.xml"/></Relationships>`)],
    ['xl/workbook.xml', Buffer.from(`${xmlDeclaration}<workbook xmlns="${spreadsheetNs}" xmlns:r="${officeRels}"><sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`)],
    ['xl/_rels/workbook.xml.rels', Buffer.from(`${xmlDeclaration}<Relationships xmlns="${packageRels}"><Relationship Id="rId1" Type="${officeRels}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)],
    ['xl/worksheets/sheet1.xml', Buffer.from(`${xmlDeclaration}<worksheet xmlns="${spreadsheetNs}"><dimension ref="${dimension}"/><sheetData>${rows}</sheetData></worksheet>`)],
  ]), signal);
}

function readXml(input?: Buffer): Document {
  if (!input || input.length > maxXmlBytes) throw new SpreadsheetInputError('Липсва или е прекалено голяма част от XLSX файла.');
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(input);
    const sax = new SaxesParser({ xmlns: true });
    let depth = 0;
    let nodes = 0;
    sax.on('doctype', () => { throw new Error('Invalid workbook XML'); });
    sax.on('opentag', () => { if (++depth > 64 || ++nodes > 175_000) throw new Error('Workbook XML limit exceeded'); });
    sax.on('closetag', () => { depth--; });
    sax.write(source).close();
    return new DOMParser({ locator: false, onError: onWarningStopParsing }).parseFromString(source, 'application/xml');
  } catch { throw new SpreadsheetInputError('Структурата на XLSX файла е невалидна или прекалено сложна.'); }
}

function editXlsxCell(document: Document, cell: Element, namespace: string, value: Cell) {
  for (const tag of ['v', 'is']) {
    const children = Array.from(cell.getElementsByTagNameNS(namespace, tag));
    for (const child of children) if (child.parentNode === cell) cell.removeChild(child);
  }
  cell.removeAttribute('t');
  if (value === null) return;
  const prefix = cell.prefix ? `${cell.prefix}:` : '';
  const element = (name: string) => document.createElementNS(namespace, prefix + name);
  const extension = Array.from(cell.getElementsByTagNameNS(namespace, 'extLst')).find((node) => node.parentNode === cell) ?? null;
  if (typeof value === 'string') {
    cell.setAttribute('t', 'inlineStr');
    const text = element('t');
    text.setAttributeNS(xmlNs, 'xml:space', 'preserve');
    text.textContent = value;
    const inline = element('is');
    inline.appendChild(text);
    cell.insertBefore(inline, extension);
  } else {
    if (typeof value === 'boolean') cell.setAttribute('t', 'b');
    const data = element('v');
    data.textContent = String(typeof value === 'boolean' ? Number(value) : value);
    cell.insertBefore(data, extension);
  }
}

function requestFormulaRecalculation(entries: Map<string, Buffer>, workbook: Document, namespace: string) {
  const book = workbook.documentElement;
  if (!book) return;
  const element = workbook.getElementsByTagNameNS(namespace, 'calcPr').item(0);
  if (['1', 'true'].includes(element?.getAttribute('fullCalcOnLoad') ?? '')) return;
  const formulasExist = [...entries].some(([name, bytes]) => /^xl\/worksheets\/[^/]+\.xml$/u.test(name)
    && /<(?:[a-z_][\w.-]*:)?f(?=[\s/>])/iu.test(bytes.toString('utf8')));
  if (!formulasExist) return;
  const properties = element ?? workbook.createElementNS(namespace, book.prefix ? `${book.prefix}:calcPr` : 'calcPr');
  properties.setAttribute('fullCalcOnLoad', '1');
  if (!element) {
    const followingElements = new Set(['oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst']);
    const next = Array.from(book.childNodes).find((node) => node.nodeType === 1 && followingElements.has((node as Element).localName ?? '')) ?? null;
    book.insertBefore(properties, next);
  }
  entries.set('xl/workbook.xml', Buffer.from(new XMLSerializer().serializeToString(workbook)));
}

async function editXlsx(input: Buffer, edit: CellEdit, signal?: AbortSignal) {
  const entries = await readZipEntries(input, { maxEntryBytes: maxXmlBytes, maxTotalBytes: 32 * 1024 * 1024, maxEntries: 512, signal }).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    throw new SpreadsheetInputError('XLSX файлът не може да бъде отворен в допустимите граници.');
  });
  if ([...entries.keys()].some((name) => /vbaproject\.bin$/iu.test(name))) throw new SpreadsheetInputError('Използвай XLSX файл без макроси.', 415);
  const workbook = readXml(entries.get('xl/workbook.xml'));
  const namespace = workbook.documentElement?.namespaceURI;
  if (namespace !== spreadsheetNs && namespace !== strictSpreadsheetNs) throw new SpreadsheetInputError('Липсва валидна работна книга.');
  const sheets = Array.from(workbook.getElementsByTagNameNS(namespace, 'sheet'));
  if (!edit.sheet && sheets.length > 1) throw new SpreadsheetInputError('Книгата има повече от един лист. Посочи листа, например „Промени клетка B2 в лист „Продажби“ на 125“.');
  const sheet = edit.sheet ? sheets.find((entry) => entry.getAttribute('name') === edit.sheet) : sheets[0];
  const relId = sheet?.getAttributeNS(officeRels, 'id') || sheet?.getAttributeNS(strictOfficeRels, 'id');
  if (!relId) throw new SpreadsheetInputError('Посоченият лист не е намерен.');
  const relationship = Array.from(readXml(entries.get('xl/_rels/workbook.xml.rels')).getElementsByTagNameNS(packageRels, 'Relationship'))
    .find((entry) => entry.getAttribute('Id') === relId && entry.getAttribute('TargetMode') !== 'External'
      && [`${officeRels}/worksheet`, `${strictOfficeRels}/worksheet`].includes(entry.getAttribute('Type') ?? ''));
  const target = relationship?.getAttribute('Target');
  const sheetPath = target ? path.posix.resolve('/xl', target).slice(1) : '';
  if (!sheetPath.startsWith('xl/worksheets/') || !sheetPath.endsWith('.xml')) throw new SpreadsheetInputError('Избраният лист не е локална работна таблица.');
  const document = readXml(entries.get(sheetPath));
  const cell = Array.from(document.getElementsByTagNameNS(namespace, 'c')).find((entry) => entry.getAttribute('r') === edit.address);
  if (!cell) throw new SpreadsheetInputError('Посочената клетка не присъства във файла. Избери съществуваща клетка.');
  if (cell.getElementsByTagNameNS(namespace, 'f').length) throw new SpreadsheetInputError('Тази клетка съдържа формула. Избери клетка със стойност.');
  for (const merged of Array.from(document.getElementsByTagNameNS(namespace, 'mergeCell'))) {
    const [first, last] = (merged.getAttribute('ref') ?? '').split(':').map(readAddress);
    if (!first || !last || (edit.row === first.row && edit.column === first.column)) continue;
    if (edit.row >= first.row && edit.row <= last.row && edit.column >= first.column && edit.column <= last.column) {
      throw new SpreadsheetInputError('Редактирай горната лява клетка на обединената област.');
    }
  }
  editXlsxCell(document, cell, namespace, edit.value);
  const changed = Buffer.from(new XMLSerializer().serializeToString(document));
  if (changed.length > maxXmlBytes) throw new SpreadsheetInputError('Редактираният лист надхвърля допустимия размер.', 413);
  entries.set(sheetPath, changed);
  requestFormulaRecalculation(entries, workbook, namespace);
  return zipWorkbook(entries, signal);
}

export async function createLocalSpreadsheet(format: SpreadsheetFormat, prompt: string, data?: SpreadsheetInput, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const grid = sourceGrid(prompt, data);
  const width = validateGrid(grid);
  return format === 'csv' ? csvBytes(grid, width) : newXlsx(grid, width, signal);
}

export async function editLocalSpreadsheet(format: SpreadsheetFormat, original: Buffer, prompt: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (original.length > maxInputBytes) throw new SpreadsheetInputError('За редакция избери таблица до 4 MB.', 413);
  const edit = requestedEdit(prompt);
  if (format === 'xlsx') return editXlsx(original, edit, signal);
  if (edit.sheet) throw new SpreadsheetInputError('CSV файлът няма отделни работни листове.');
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(original); }
  catch { throw new SpreadsheetInputError('Използвай CSV файл с UTF-8 кодировка.'); }
  const grid = readCommaSeparated(source);
  const width = validateGrid(grid);
  const row = grid.rows[edit.row - 1];
  if (!row || edit.column > width) throw new SpreadsheetInputError('Посочената клетка е извън таблицата.');
  row[edit.column - 1] = edit.value;
  return csvBytes(grid, width);
}

export async function runLocalSpreadsheetTool({ operation, prompt, userId, file, signal, format, data }: {
  operation: 'create' | 'edit'; prompt: string; userId: string;
  file?: { data: Buffer; mimeType: string }; signal?: AbortSignal;
  format?: SpreadsheetFormat; data?: SpreadsheetInput;
}) {
  const edited = operation === 'edit';
  const output = edited ? (['csv', 'xlsx'] as const).find((candidate) => mimeFromExt(candidate) === file?.mimeType)
    : format ?? (/\bcsv\b/iu.test(prompt.split(explicitData)[0]) ? 'csv' : 'xlsx');
  if (!output || (edited && !file)) throw new SpreadsheetInputError('Прикачи CSV или XLSX файл.', 415);
  const bytes = edited && file ? await editLocalSpreadsheet(output, file.data, prompt, signal) : await createLocalSpreadsheet(output, prompt, data, signal);
  signal?.throwIfAborted();
  if (bytes.length > 25 * 1024 * 1024) throw new SpreadsheetInputError('Резултатът надхвърля 25 MB.', 413);
  const mimeType = mimeFromExt(output);
  const saved = await saveUpload(bytes, mimeType, userId);
  const url = `/api/upload/${saved.id}`;
  const filename = `SharkAI-${edited ? 'редактирана-таблица' : 'таблица'}.${output}`;
  return {
    id: saved.id, status: 'completed' as const, url,
    text: edited ? 'Промяната е записана в отделно копие.' : `Таблицата е готова във формат ${output.toUpperCase()}.`,
    artifact: { url, mimeType, filename },
  };
}
