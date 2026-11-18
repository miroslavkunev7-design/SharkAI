import { parse } from 'csv-parse/sync';
import { SaxesParser } from 'saxes';
import sharp from 'sharp';
import path from 'node:path';
import { readZipEntries } from './bounded-zip.mjs';
import { instruction, supportsLocalTableAnalysis, withoutDirectives } from './table-request.mjs';

sharp.cache(false);
sharp.concurrency(1);

const csvMime = 'text/csv';
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const maxBytes = 4 * 1024 * 1024;
const maxRows = 50_001;
const maxColumns = 80;
const maxCells = 500_000;
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
  if (!buffer)
    return new Set();
  const custom = new Set();
  const styles = new Set();
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
          custom.add(Number(tag.attributes.numFmtId));
      }
      if (inFormats && name === 'xf') {
        const id = Number(tag.attributes.numFmtId);
        if (custom.has(id) || (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58))
          styles.add(index);
        index++;
      }
    },
    close(tag) { if (tagName(tag) === 'cellXfs')
      inFormats = false; },
  });
  return styles;
}
function columnNumber(reference, row) {
  const label = reference?.match(/^[A-Z]+/)?.[0];
  if (!label)
    return row.length;
  return [...label].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}
async function readXlsx(buffer, prompt, signal) {
  const select = (name) => ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml'].includes(name) || /^xl\/worksheets\/[^/]+\.xml$/.test(name);
  const entries = await readZipEntries(buffer, { select, maxEntryBytes: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxEntries: 256, signal });
  const workbook = entries.get('xl/workbook.xml');
  const relationships = entries.get('xl/_rels/workbook.xml.rels');
  if (!workbook || !relationships)
    throw new LocalTableError('XLSX файлът не съдържа четима работна книга.');
  const sheets = [];
  parseXml(workbook, {
    open(tag) {
      if (tagName(tag) !== 'sheet')
        return;
      const id = tag.attributes['r:id'] ?? Object.entries(tag.attributes).find(([key]) => key.endsWith(':id'))?.[1];
      if (id && tag.attributes.name)
        sheets.push({ id, name: tag.attributes.name, hidden: tag.attributes.state === 'hidden' || tag.attributes.state === 'veryHidden' });
    },
  });
  const requested = instruction(prompt, ['лист', 'sheet']);
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
  let date = false;
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
        date = dateStyles.has(Number(tag.attributes.s ?? '0'));
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
        row[column] = type === 's' ? cell ? strings[Number(cell)] ?? null : null
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
      const adjusted = value - stats.correction;
      const nextSum = stats.sum + adjusted;
      stats.correction = (nextSum - stats.sum) - adjusted;
      stats.sum = nextSum;
      stats.min = Math.min(stats.min, value);
      stats.max = Math.max(stats.max, value);
      stats.count++;
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
async function analyzeTable({ file, prompt, }) {
  if (!supportsLocalTableAnalysis(prompt)) {
    throw new LocalTableError('Локалната справка поддържа сума, средно, минимум, максимум, празни клетки и графика по стойности. За друго изчисление използвай разширения анализ.');
  }
  if (file.data.length > maxBytes)
    throw new LocalTableError('Локалният анализ приема таблици до 4 MB.', 413);
  let table;
  try {
    if (file.mimeType === csvMime) {
      if (instruction(prompt, ['лист', 'sheet']))
        throw new LocalTableError('Работен лист може да се избере само за XLSX.');
      table = readCsv(file.data);
    }
    else if (file.mimeType === xlsxMime)
      table = await readXlsx(file.data, prompt);
    else
      throw new LocalTableError('Прикачи CSV или XLSX файл.');
  }
  catch (error) {
    if (error instanceof LocalTableError)
      throw error;
    throw new LocalTableError('Таблицата не можа да се прочете. Провери формата и кодирането UTF-8 за CSV.');
  }
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
  const { prompt, mimeType } = JSON.parse(input.subarray(0, split).toString('utf8'));
  if (typeof prompt !== 'string' || prompt.length > 24_000 || ![csvMime, xlsxMime].includes(mimeType)) {
    throw new LocalTableError('Невалидна заявка за табличен анализ.');
  }
  return { prompt, file: { mimeType, data: input.subarray(split + 1) } };
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
