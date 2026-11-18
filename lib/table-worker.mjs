import { parse } from 'csv-parse/sync';
import { SaxesParser } from 'saxes';
import sharp from 'sharp';
import path from 'node:path';
import { readZipEntries } from './bounded-zip.mjs';
import {
  getGroupedAggregationLabel, groupedTableRequestHelp, instruction, isGroupedTableCommand,
  parseGroupedTableRequest, supportsLocalTableAnalysis, withoutDirectives,
} from './table-request.mjs';

sharp.cache(false);
sharp.concurrency(1);

const csvMime = 'text/csv';
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const maxBytes = 4 * 1024 * 1024;
const maxRows = 50_001;
const maxColumns = 80;
const maxCells = 500_000;
const maxGroups = 3000;
const maxOutputBytes = 1024 * 1024;
class LocalTableError extends Error {
  status;
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}
function checkRows(rows) {
  if (rows.length > maxRows || rows.some((row) => row.length > maxColumns)
    || rows.reduce((count, row) => count + row.length, 0) > maxCells) {
    throw new LocalTableError('Локалният анализ поддържа до 50 000 реда, 80 колони и 500 000 клетки.', 413);
  }
  const nonempty = rows.filter((row) => row.some((cell) => cell !== null && String(cell).trim() !== ''));
  if (nonempty.length < 2)
    throw new LocalTableError('Таблицата трябва да има заглавия и поне един ред с данни.');
  if (nonempty.some((row) => row.length > nonempty[0].length)) {
    throw new LocalTableError('Има редове с повече колони от заглавния ред.');
  }
  return nonempty;
}
function readCsv(buffer) {
  const data = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const common = { bom: true, skip_empty_lines: true, relax_column_count_less: true, max_record_size: 100_000 };
  let delimiter = ',';
  let maxWidth = 0;
  for (const separator of [',', ';', '\t']) {
    try {
      const [header] = parse(data, { ...common, delimiter: separator, to: 1 });
      if (header?.length > maxWidth) {
        delimiter = separator;
        maxWidth = header.length;
      }
    }
    catch { /* Try the next delimiter. */ }
  }
  return { rows: checkRows(parse(data, { ...common, delimiter })) };
}
function parseXml(buffer, handlers) {
  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => { throw new LocalTableError('XLSX файлът използва неподдържан XML формат.'); });
  if (handlers.open)
    parser.on('opentag', handlers.open);
  if (handlers.close)
    parser.on('closetag', handlers.close);
  if (handlers.text) {
    parser.on('text', handlers.text);
    parser.on('cdata', handlers.text);
  }
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(buffer)).close();
}
function tagName(tag) { return tag.name.split(':').at(-1); }
function readStrings(buffer) {
  if (!buffer)
    return [];
  const values = [];
  let current = '';
  let text = false;
  parseXml(buffer, {
    open(tag) {
      if (tagName(tag) === 'si')
        current = '';
      if (tagName(tag) === 't')
        text = true;
    },
    text(value) { if (text)
      current += value; },
    close(tag) {
      if (tagName(tag) === 't')
        text = false;
      if (tagName(tag) === 'si') {
        if (values.length >= maxCells)
          throw new LocalTableError('XLSX файлът съдържа твърде много текстови клетки.', 413);
        values.push(current);
      }
    },
  });
  return values;
}
function readDateStyles(buffer) {
  const dates = new Set();
  const calendar = new Set();
  if (!buffer)
    return { dates, calendar };
  const custom = new Map();
  let inFormats = false;
  let index = 0;
  parseXml(buffer, {
    open(tag) {
      const name = tagName(tag);
      if (name === 'cellXfs')
        inFormats = true;
      if (name === 'numFmt') {
        const format = tag.attributes.formatCode?.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '') ?? '';
        if (/[ymdhs]/i.test(format))
          custom.set(Number(tag.attributes.numFmtId), /[yd]/i.test(format) || /^m{1,5}$/i.test(format));
      }
      if (inFormats && name === 'xf') {
        const id = Number(tag.attributes.numFmtId);
        const builtInCalendar = (id >= 14 && id <= 17) || id === 22;
        if (custom.has(id) || (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58))
          dates.add(index);
        if (custom.get(id) ?? builtInCalendar)
          calendar.add(index);
        index++;
      }
    },
    close(tag) { if (tagName(tag) === 'cellXfs')
      inFormats = false; },
  });
  return { dates, calendar };
}
function columnNumber(reference, row) {
  const label = reference?.match(/^[A-Z]+/)?.[0];
  if (!label)
    return row.length;
  return [...label].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}
function isoDate(value) {
  if (typeof value !== 'string' || value.startsWith('0000-') || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function excelDate(value, date1904) {
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const day = Math.floor(serial);
  // Excel's 1900 epoch includes a nonexistent 29 February 1900 at serial 60.
  if (!date1904 && day === 60) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const date = new Date(epoch + (day - Number(!date1904 && day > 60)) * 86_400_000);
  return date.getUTCFullYear() < 10_000 ? date.toISOString().slice(0, 10) : null;
}

function typedDate(value) {
  if (typeof value !== 'string') return null;
  if (value.length === 10) return isoDate(value);
  const date = value.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/u);
  return date && Number.isFinite(Date.parse(value)) ? isoDate(date[1]) : null;
}

async function readXlsx(buffer, prompt, grouped, signal) {
  const select = (name) => ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml'].includes(name) || /^xl\/worksheets\/[^/]+\.xml$/.test(name);
  const entries = await readZipEntries(buffer, { select, maxEntryBytes: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxEntries: 256, signal });
  const workbook = entries.get('xl/workbook.xml');
  const relationships = entries.get('xl/_rels/workbook.xml.rels');
  if (!workbook || !relationships)
    throw new LocalTableError('XLSX файлът не съдържа четима работна книга.');
  const sheets = [];
  let date1904 = false;
  parseXml(workbook, {
    open(tag) {
      if (tagName(tag) === 'workbookPr') {
        date1904 = ['1', 'true'].includes(tag.attributes.date1904);
      }
      if (tagName(tag) !== 'sheet')
        return;
      const id = tag.attributes['r:id'] ?? Object.entries(tag.attributes).find(([key]) => key.endsWith(':id'))?.[1];
      if (id && tag.attributes.name)
        sheets.push({ id, name: tag.attributes.name, hidden: tag.attributes.state === 'hidden' || tag.attributes.state === 'veryHidden' });
    },
  });
  const requested = grouped?.sheet ?? instruction(prompt, ['лист', 'sheet']);
  const sheet = requested ? sheets.find(({ name }) => name.toLowerCase() === requested.toLowerCase()) : sheets.find(({ hidden }) => !hidden);
  if (!sheet)
    throw new LocalTableError(requested ? 'Посоченият лист не е намерен.' : 'Не е намерен видим работен лист.');
  let sheetPath = '';
  parseXml(relationships, {
    open(tag) {
      if (tagName(tag) !== 'Relationship' || tag.attributes.Id !== sheet.id || tag.attributes.TargetMode === 'External'
        || !tag.attributes.Type?.endsWith('/worksheet'))
        return;
      const target = tag.attributes.Target ?? '';
      sheetPath = path.posix.normalize(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    },
  });
  const xml = entries.get(sheetPath);
  if (!xml)
    throw new LocalTableError('XML файлът на избрания работен лист липсва.');
  const strings = readStrings(entries.get('xl/sharedStrings.xml'));
  const dateStyles = readDateStyles(entries.get('xl/styles.xml'));
  const rows = [];
  let row = null;
  let column = 0;
  let type = '';
  let style = 0;
  let cell = '';
  let text = false;
  let formulaCount = 0;
  let count = 0;
  parseXml(xml, {
    open(tag) {
      const name = tagName(tag);
      if (name === 'row')
        row = [];
      if (!row)
        return;
      if (name === 'c') {
        column = columnNumber(tag.attributes.r, row);
        if (column >= maxColumns || count++ >= maxCells)
          throw new LocalTableError('XLSX файлът надхвърля ограничението за клетки или колони.', 413);
        cell = '';
        type = tag.attributes.t ?? '';
        style = Number(tag.attributes.s ?? '0');
      }
      if (name === 'f')
        formulaCount++;
      if (name === 'v' || name === 't')
        text = true;
    },
    text(value) { if (text)
      cell += value; },
    close(tag) {
      const name = tagName(tag);
      if (name === 'v' || name === 't')
        text = false;
      if (name === 'c' && row) {
        while (row.length <= column)
          row.push(null);
        const date = dateStyles.dates.has(style);
        const calendar = grouped && cell && ((!type || type === 'n') && dateStyles.calendar.has(style) || type === 'd');
        row[column] = calendar ? (type === 'd' ? typedDate(cell) : excelDate(cell, date1904)) ?? `Excel date: ${cell}`
          : type === 's' ? cell ? strings[Number(cell)] ?? null : null
          : type === 'b' ? cell === '1' ? 'TRUE' : 'FALSE'
            : type === 'e' ? null
              : cell && !type && !date ? Number(cell)
                : cell && type === 'n' && !date ? Number(cell)
                  : cell && date ? `Excel date: ${cell}`
                    : cell || null;
      }
      if (name === 'row' && row) {
        if (rows.length >= maxRows)
          throw new LocalTableError('XLSX файлът съдържа над 50 000 реда с данни.', 413);
        rows.push(row);
        row = null;
      }
    },
  });
  return { rows: checkRows(rows), sheet: sheet.name, formulaCount };
}
function valueOf(cell) {
  if (cell == null)
    return null;
  if (typeof cell === 'number')
    return Number.isFinite(cell) ? cell : null;
  if (!/^[+-]?\d+(?:[.,]\d+)?(?:e[+-]?\d+)?$/i.test(cell.trim()))
    return null;
  const parsed = Number(cell.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}
function accumulate(stats, value) {
  const adjusted = value - stats.correction;
  const nextSum = stats.sum + adjusted;
  stats.correction = (nextSum - stats.sum) - adjusted;
  stats.sum = nextSum;
  stats.min = Math.min(stats.min, value);
  stats.max = Math.max(stats.max, value);
  stats.count++;
}
function profile([header, ...rows]) {
  return header.map((heading, index) => {
    const stats = { name: String(heading ?? '').trim().slice(0, 100) || `Колона ${index + 1}`, count: 0, missing: 0, other: 0, sum: 0, min: Infinity, max: -Infinity, correction: 0 };
    for (const row of rows) {
      const cell = row[index];
      if (cell == null || String(cell).trim() === '') {
        stats.missing++;
        continue;
      }
      const value = valueOf(cell);
      if (value === null) {
        stats.other++;
        continue;
      }
      accumulate(stats, value);
    }
    return stats;
  });
}
const formatter = new Intl.NumberFormat('bg-BG', { maximumSignificantDigits: 12 });
const display = (value) => Number.isFinite(value) ? formatter.format(value) : 'извън числовия диапазон';
function csvField(value) {
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : '';
  return `"${(/^[\x00-\x20]*[=+@-]/.test(value) ? "'" : '') + value.replace(/"/g, '""')}"`;
}
function reportCsv(columns) {
  const header = ['Колона', 'Числа', 'Празни', 'Други', 'Сума', 'Средно', 'Минимум', 'Максимум'];
  const rows = columns.map(({ name, count, missing, other, sum, min, max }) => [name, count, missing, other, ...(count ? [sum, sum / count, min, max] : ['', '', '', ''])]);
  return Buffer.from('\uFEFF' + [header, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n'));
}

const operations = new Set(['sum', 'count', 'average', 'min', 'max']);
const comparisons = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between']);
const invalidPlan = () => new LocalTableError('Невалидни условия за групиране, филтриране или сортиране.');
const normalizedText = (value) => String(value ?? '').trim().normalize('NFC');

function validFields(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}

function boundedText(value, { allowBlank = false } = {}) {
  return typeof value === 'string' && value.length <= 160 && !/[\x00-\x1F\x7F]/u.test(value)
    && (allowBlank || value.trim() !== '');
}

function filterValue(kind, value) {
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (kind === 'date') return isoDate(value);
  if (kind === 'text') return boundedText(value, { allowBlank: true }) ? normalizedText(value) : null;
  return null;
}

function validateGroupedPlan(plan) {
  if (!validFields(plan, ['operation', 'groupBy', 'aggregations', 'filters', 'sort', 'sheet'])
    || plan.operation !== 'grouped' || !boundedText(plan.groupBy)
    || (plan.sheet !== undefined && !boundedText(plan.sheet))
    || !Array.isArray(plan.aggregations) || plan.aggregations.length < 1 || plan.aggregations.length > 5) {
    throw invalidPlan();
  }
  for (const metric of plan.aggregations) {
    if (!validFields(metric, ['operation', 'column', 'label']) || !operations.has(metric.operation)
      || (metric.operation !== 'count' || metric.column !== undefined) && !boundedText(metric.column)
      || (metric.label !== undefined && !boundedText(metric.label))) throw invalidPlan();
  }
  if (plan.filters !== undefined) {
    if (!Array.isArray(plan.filters) || plan.filters.length > 5) throw invalidPlan();
    for (const filter of plan.filters) {
      if (!validFields(filter, ['column', 'operation', 'kind', 'value', 'end']) || !boundedText(filter.column)
        || !comparisons.has(filter.operation)
        || (filter.kind === 'text' && !['eq', 'neq'].includes(filter.operation))) throw invalidPlan();
      const first = filterValue(filter.kind, filter.value);
      const last = filterValue(filter.kind, filter.end);
      if (first === null || (filter.operation === 'between'
        ? last === null || first > last : filter.end !== undefined)) throw invalidPlan();
    }
  }
  if (plan.sort !== undefined && (!validFields(plan.sort, ['column', 'direction']) || !boundedText(plan.sort.column)
    || !['asc', 'desc'].includes(plan.sort.direction))) throw invalidPlan();
  return plan;
}

function columnIndex(header, reference) {
  const name = normalizedText(reference);
  const index = header.indexOf(name);
  if (index < 0) throw new LocalTableError(`Липсва колоната „${name}“. Провери точното ѝ заглавие.`);
  if (header.lastIndexOf(name) !== index) throw new LocalTableError(`Заглавието „${name}“ се среща повече от веднъж.`);
  return index;
}

function rowFilter(header, { column, operation, kind, value, end }) {
  const index = columnIndex(header, column);
  const first = filterValue(kind, value);
  const last = filterValue(kind, end);
  return (row) => {
    const cell = row[index];
    const actual = kind === 'number' ? valueOf(cell) : kind === 'date' ? typedDate(normalizedText(cell)) : normalizedText(cell);
    if (actual === null) return false;
    switch (operation) {
      case 'eq': return actual === first;
      case 'neq': return actual !== first;
      case 'lt': return actual < first;
      case 'lte': return actual <= first;
      case 'gt': return actual > first;
      case 'gte': return actual >= first;
      case 'between': return actual >= first && actual <= last;
      default: return false;
    }
  };
}

function groupedCsv(headers, rows) {
  const chunks = ['\uFEFF'];
  let size = 3;
  for (const row of [headers, ...rows]) {
    const line = row.map(csvField).join(',') + '\r\n';
    size += Buffer.byteLength(line);
    if (size > maxOutputBytes) throw new LocalTableError('Групираната CSV справка надхвърля 1 MB. Ограничи редовете с филтър.', 413);
    chunks.push(line);
  }
  return Buffer.from(chunks.join(''));
}

function metricValue({ operation, index }, group) {
  if (index === -1) return group.count;
  const values = group.columns.get(index);
  if (operation === 'count') return values.present;
  if (!values.count) return '';
  const value = operation === 'average' ? values.sum / values.count : values[operation];
  if (!Number.isFinite(value)) throw new LocalTableError('Резултатът надхвърля поддържания числов диапазон.');
  // CSV consumers such as Excel retain 15 significant digits.
  return Number(value.toPrecision(15));
}

function groupedAnalysis(table, plan) {
  const [sourceHeader, ...rows] = table.rows;
  const header = sourceHeader.map(normalizedText);
  const groupIndex = columnIndex(header, plan.groupBy);
  const metrics = plan.aggregations.map(({ operation, column, label }) => {
    const index = column === undefined ? -1 : columnIndex(header, column);
    const heading = getGroupedAggregationLabel({ operation, column: index === -1 ? undefined : header[index], label });
    return { operation, index, label: normalizedText(heading) };
  });
  const resultHeader = [header[groupIndex], ...metrics.map(({ label }) => label)];
  if (new Set(resultHeader).size !== resultHeader.length) throw new LocalTableError('Задай различни заглавия за групата и изчисленията.');
  let sortIndex = -1;
  if (plan.sort) {
    sortIndex = resultHeader.indexOf(normalizedText(plan.sort.column));
    if (sortIndex < 0) throw new LocalTableError('За сортиране посочи заглавие от групираната справка.');
  }
  const filters = (plan.filters ?? []).map((filter) => rowFilter(header, filter));
  const sourceColumns = [...new Set(metrics.map(({ index }) => index).filter((index) => index >= 0))];
  const numericColumns = new Set(metrics.filter(({ operation }) => operation !== 'count').map(({ index }) => index));
  const groups = new Map();
  let matched = 0;
  let blanks = 0;
  let nonNumeric = 0;
  for (const row of rows) {
    if (!filters.every((filter) => filter(row))) continue;
    matched++;
    const name = normalizedText(row[groupIndex]);
    let group = groups.get(name);
    if (!group) {
      if (groups.size >= maxGroups) throw new LocalTableError(`Справката поддържа до ${maxGroups} групи. Ограничи редовете с филтър.`, 413);
      group = { count: 0, columns: new Map(sourceColumns.map((index) => [index, { present: 0, count: 0, sum: 0, correction: 0, min: Infinity, max: -Infinity }])) };
      groups.set(name, group);
    }
    group.count++;
    for (const index of sourceColumns) {
      const cell = row[index];
      const numeric = numericColumns.has(index);
      if (cell == null || String(cell).trim() === '') {
        if (numeric) blanks++;
        continue;
      }
      const values = group.columns.get(index);
      values.present++;
      if (!numeric) continue;
      const value = valueOf(cell);
      if (value === null) nonNumeric++;
      else accumulate(values, value);
    }
  }
  const result = [...groups].map(([name, group]) => [name, ...metrics.map((metric) => metricValue(metric, group))]);
  if (sortIndex >= 0) {
    const direction = plan.sort.direction === 'desc' ? -1 : 1;
    result.sort((a, b) => {
      const left = a[sortIndex];
      const right = b[sortIndex];
      if (left === right) return 0;
      if (left === '') return 1;
      if (right === '') return -1;
      return (left < right ? -1 : 1) * direction;
    });
  }
  const preview = result.slice(0, 8).map(([name, ...values]) => {
    const compact = name.replace(/\s+/gu, ' ');
    const label = compact.length > 120 ? compact.slice(0, 119) + '…' : compact || '(празно)';
    const totals = values.map((value, index) => {
      const amount = value === '' ? 'няма числа' : String(value).replace('.', ',');
      return `${metrics[index].label} ${amount}`;
    });
    return `„${label}“ · ${totals.join(' · ')}`;
  });
  const lines = [
    `${table.sheet ? `Лист „${table.sheet.slice(0, 100)}“ · ` : ''}${matched} от ${rows.length} реда · ${groups.size} групи`,
    ...(matched < rows.length ? [`Извън филтъра: ${rows.length - matched} реда.`] : []),
    ...preview,
    ...(result.length > preview.length ? [`В чата са показани първите ${preview.length} групи. CSV файлът съдържа цялата справка.`] : []),
    ...(numericColumns.size ? [`Изключени от числовите изчисления: ${blanks} празни и ${nonNumeric} нечислови клетки.`] : []),
    ...(table.formulaCount ? [`Формули в източника: ${table.formulaCount}. Използвани са записаните стойности.`] : []),
  ];
  return {
    text: lines.join('\n'), mimeType: csvMime, filename: 'sharkai-grouped-analysis.csv',
    artifact: groupedCsv(resultHeader, result).toString('base64'),
  };
}

function xml(value) {
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}
async function chart(rows, columns, prompt) {
  const explicit = instruction(prompt, ['колона', 'column']);
  const index = explicit ? columns.findIndex(({ name }) => name.toLowerCase() === explicit.toLowerCase()) : columns.findIndex(({ count }) => count > 0);
  if (index < 0 || !columns[index].count) {
    throw new LocalTableError(explicit ? 'Посочената колона липсва или е без числови стойности.' : 'Таблицата няма числова колона за графика.');
  }
  const values = rows.slice(1).flatMap((row, i) => {
    const value = valueOf(row[index]);
    return value === null ? [] : [{ value, label: String(i + 1) }];
  }).slice(0, 20);
  const min = Math.min(0, ...values.map(({ value }) => value));
  const max = Math.max(0, ...values.map(({ value }) => value));
  const normalizer = Math.max(Math.abs(min), Math.abs(max), 1);
  const normMin = min / normalizer;
  const interval = max / normalizer - normMin || 1;
  const x = (value) => 75 + 650 * ((value / normalizer - normMin) / interval);
  const x0 = x(0);
  const height = 111 + values.length * 29;
  const title = columns[index].name.slice(0, 65);
  const bars = values.map(({ value, label }, i) => {
    const y = 76 + i * 29;
    return `<text x="27" y="${y + 16}" fill="#b0c9e8" font-size="14">${label}</text>
   <rect x="${Math.min(x0, x(value))}" y="${y}" width="${Math.max(1, Math.abs(x(value) - x0))}" height="19" rx="4" fill="${value >= 0 ? '#37b9f6' : '#bf8cf6'}"/>
   <text x="746" y="${y + 16}" fill="#e5f1ff" font-size="14">${xml(display(value))}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="930" height="${height}" viewBox="0 0 930 ${height}">
  <rect width="930" height="${height}" rx="14" fill="#0b1729"/>
  <g font-family="sans-serif">
   <text x="26" y="34" font-size="22" font-weight="bold" fill="#f3f7ff">${xml(title)}</text>
   <text x="26" y="57" font-size="14" fill="#b0c9e8">Първите ${values.length} числови стойности по ред</text>
   <path d="M${x0} 69V${height - 27}" stroke="#87a8ce" stroke-width="1"/>
   ${bars}
  </g>
 </svg>`;
  return { data: await sharp(Buffer.from(svg)).png().toBuffer(), title, count: values.length };
}
async function analyzeTable({ file, prompt, plan }) {
  let grouped = plan === undefined ? null : validateGroupedPlan(plan);
  if (!grouped && isGroupedTableCommand(prompt)) {
    const parsed = parseGroupedTableRequest(prompt);
    if (!parsed) throw new LocalTableError(groupedTableRequestHelp);
    grouped = validateGroupedPlan(parsed);
  }
  if (!grouped && !supportsLocalTableAnalysis(prompt)) {
    throw new LocalTableError('Локалната справка поддържа сума, средно, минимум, максимум, празни клетки и графика по стойности. За друго изчисление използвай разширения анализ.');
  }
  if (file.data.length > maxBytes)
    throw new LocalTableError('Локалният анализ приема таблици до 4 MB.', 413);
  let table;
  try {
    if (file.mimeType === csvMime) {
      if (grouped?.sheet || instruction(prompt, ['лист', 'sheet']))
        throw new LocalTableError('Работен лист може да се избере само за XLSX.');
      table = readCsv(file.data);
    }
    else if (file.mimeType === xlsxMime)
      table = await readXlsx(file.data, prompt, grouped);
    else
      throw new LocalTableError('Прикачи CSV или XLSX файл.');
  }
  catch (error) {
    if (error instanceof LocalTableError)
      throw error;
    throw new LocalTableError('Таблицата не можа да се прочете. Провери формата и кодирането UTF-8 за CSV.');
  }
  if (grouped) return groupedAnalysis(table, grouped);
  const columns = profile(table.rows);
  const wantsChart = /(?:график[аи]|диаграм[аи]|начертай|\b(?:chart|plot|graph|draw)\b)/iu.test(withoutDirectives(prompt));
  const selected = instruction(prompt, ['колона', 'column']);
  const summarized = !selected || wantsChart ? columns : columns.filter(({ name }) => name.toLowerCase() === selected.toLowerCase());
  if (selected && !summarized.length)
    throw new LocalTableError('Посочената колона не е намерена.');
  const numeric = summarized.filter(({ count }) => count > 0);
  const summary = numeric.slice(0, 12).map(({ name, count, missing, other, sum, min, max }) => `${name}: ${count} числа · сума ${display(sum)} · средно ${display(sum / count)} · min ${display(min)} · max ${display(max)} · празни ${missing} · други ${other}`);
  const lines = [
    `${table.sheet ? `Лист „${table.sheet}“ · ` : ''}${table.rows.length - 1} реда с данни · ${columns.length} колони · ${numeric.length} числови колони`,
    ...summary,
    ...(!numeric.length ? ['Няма колони с числови стойности.'] : []),
    ...(summary.length < numeric.length ? ['В чата са показани първите 12 числови колони.'] : []),
    ...(table.formulaCount ? [`Формули: ${table.formulaCount}. Използвани са наличните записани стойности от файла.`] : []),
    'Празните и нечисловите клетки са изключени от числовите изчисления.',
  ];
  const plotted = wantsChart ? await chart(table.rows, columns, prompt) : null;
  if (plotted)
    lines.push(`Графиката показва първите ${plotted.count} числови стойности от „${plotted.title}“.`);
  const filename = wantsChart ? 'sharkai-chart.png' : 'sharkai-table-summary.csv';
  return { text: lines.join('\n'), mimeType: wantsChart ? 'image/png' : csvMime, filename, artifact: (plotted?.data ?? reportCsv(summarized)).toString('base64') };
}

async function getInput() {
  const chunks = [];
  const maxFrameBytes = 192 * 1024;
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes + maxFrameBytes) throw new LocalTableError('Входът надхвърля допустимия размер.', 413);
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks, size);
  const split = input.indexOf(10);
  if (split < 0 || split > maxFrameBytes) throw new LocalTableError('Невалидна заявка за табличен анализ.');
  const { prompt, mimeType, plan } = JSON.parse(input.subarray(0, split).toString('utf8'));
  if (typeof prompt !== 'string' || prompt.length > 24_000 || ![csvMime, xlsxMime].includes(mimeType)) {
    throw new LocalTableError('Невалидна заявка за табличен анализ.');
  }
  return { prompt, plan, file: { mimeType, data: input.subarray(split + 1) } };
}

async function main() {
  if (process.argv[2] === '--probe') {
    const result = await analyzeTable({ prompt: 'chart CSV', file: { data: Buffer.from('Month,Value\nApril,4\n'), mimeType: csvMime } });
    if (result.mimeType !== 'image/png' || !result.artifact.startsWith('iVBOR')) throw new Error('Image probe failed');
    process.stdout.write(JSON.stringify({ ready: true }));
    return;
  }
  try {
    const result = await analyzeTable(await getInput());
    process.stdout.write(JSON.stringify({ result }));
  } catch (error) {
    const failure = error instanceof LocalTableError
      ? { message: error.message, status: error.status }
      : { message: 'Изолираната обработка на таблицата прекъсна.', status: 422 };
    process.stdout.write(JSON.stringify({ failure }));
  }
}

main().catch(() => { process.exitCode = 1; });
