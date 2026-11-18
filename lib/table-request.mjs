const instructions = /(?:^|[;\s])(лист|sheet|колона|column)[\t ]*[:=][\t ]*(?:"([^"\n]+)"|“([^”\n]+)”|([^;\n]+))/giu;
const allowed = new Set(`анализ анализирай анализирайте обобщи обобщение резюме преглед дай направи изведи изчисли сметни покажи
 на от в и за със с по моля прикачения прикачената прикачен прикачена файла файл таблица таблицата данни данните
 csv xlsx колони колоните число числа числовите числови клетки клетките стойности стойностите
 статистика описателна обобщена броя брой празни празните сума сумата средна средно средната минимум минимума максимум максимума min max
 графика графиката диаграма диаграмата начертай създай експортирай експорт
 please analyze analyse summarize summarise summary descriptive statistics chart plot graph draw create calculate sum mean average
 minimum maximum count stats data table file attached spreadsheet numbers numeric missing blank rows columns the from for of and in by per`
  .trim().split(/\s+/));
function instruction(prompt, keys) {
  const match = [...prompt.matchAll(instructions)].find((entry) => keys.includes(entry[1].toLowerCase()));
  return (match?.[2] ?? match?.[3] ?? match?.[4])?.trim();
}
function supportsTableSummary(prompt) {
  const request = prompt.replace(instructions, ' ').trim().toLowerCase();
  const words = request.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.every((word) => allowed.has(word));
}

/** @typedef {'sum'|'count'|'average'|'min'|'max'} AggregationOperation */
/** @typedef {{operation: AggregationOperation, column?: string, label?: string}} Aggregation */
/** @typedef {'eq'|'neq'|'lt'|'lte'|'gt'|'gte'|'between'} FilterOperation */
/** @typedef {{column: string, operation: FilterOperation} & ({kind: 'date'|'text', value: string, end?: string} | {kind: 'number', value: number, end?: number})} GroupedFilter */
/** @typedef {{operation: 'grouped', groupBy: string, aggregations: Aggregation[], filters?: GroupedFilter[], sort?: {column: string, direction: 'asc'|'desc'}, sheet?: string}} GroupedTableRequest */

/** @type {Map<string, AggregationOperation>} */
const operations = new Map([
  ['сумирай', 'sum'], ['сумираш', 'sum'], ['сумирал', 'sum'], ['сумирала', 'sum'], ['сумирали', 'sum'],
  ['сума', 'sum'], ['сумата', 'sum'], ['sum', 'sum'], ['total', 'sum'],
  ['преброй', 'count'], ['преброиш', 'count'], ['брой', 'count'], ['броя', 'count'], ['count', 'count'],
  ['осредни', 'average'], ['осредниш', 'average'], ['средно', 'average'], ['средна', 'average'], ['средната', 'average'], ['average', 'average'], ['mean', 'average'],
  ['минимум', 'min'], ['минимума', 'min'], ['min', 'min'], ['minimum', 'min'],
  ['максимум', 'max'], ['максимума', 'max'], ['max', 'max'], ['maximum', 'max'],
]);
/** @type {Map<string, FilterOperation>} */
const comparisons = new Map([
  ['=', 'eq'], ['!=', 'neq'], ['<', 'lt'], ['<=', 'lte'], ['>', 'gt'], ['>=', 'gte'],
  ['между', 'between'], ['between', 'between'],
]);
const operationWords = [...operations.keys()];
const comparisonWords = [...comparisons.keys()];
const aggregateLabels = { sum: 'Сума', count: 'Брой', average: 'Средно', min: 'Минимум', max: 'Максимум' };
const groupingWords = ['по', 'by', 'per'];
const conjunctions = ['и', 'and'];
const commandWords = ['изчисли', 'изчислиш', 'сметни', 'сметнеш', 'calculate', 'compute'];
const maxGroupedItems = 5;
const maxGroupedLength = 2400;
const maxQuotedLength = 160;
const groupedStart = new RegExp(`^(?:(?:${commandWords.join('|')})\\s+(?:the\\s+)?)?(?:${operationWords.join('|')})(?![\\p{L}\\p{N}_])`, 'iu');
const introductoryRequest = /^(?:моля|please)(?:\s*,\s*|\s+)/iu;
const courtesyRequest = /^(?:(?:можеш|може|би|бихте)\s+ли(?:\s+да)?|(?:can|could|would)\s+you)\s+/iu;
const quotedText = /"(?:[^"\r\n]|"")*"|„[^„“\r\n]*“|“[^“”\r\n]*”/gu;
const groupedBy = /(?<![\p{L}\p{N}_])(?:по|by|per)(?![\p{L}\p{N}_])/iu;

export const groupedTableRequestHelp = 'Пример за групиране: Сумирай „Приход“ по „Град“, от 2026-10-01 до 2026-10-31 по „Дата“. Посочи точните заглавия на колоните в кавички и датите във формат ГГГГ-ММ-ДД.';

/** @param {string} prompt */
function groupedCommandBody(prompt) {
  return prompt.trim().replace(introductoryRequest, '').replace(courtesyRequest, '').replace(introductoryRequest, '');
}

export function isGroupedTableCommand(prompt) {
  const request = groupedCommandBody(prompt);
  const start = request.match(groupedStart);
  return !!start && !supportsTableSummary(request) && groupedBy.test(request.slice(start[0].length).replace(quotedText, ' '));
}

/** @param {Aggregation} metric */
export function getGroupedAggregationLabel({ operation, column, label }) {
  return label ?? (column ? `${aggregateLabels[operation]} ${column}` : aggregateLabels[operation]);
}

/** @param {string} value */
function isExactDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return !value.startsWith('0000-') && Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/** @typedef {{kind: 'syntax'|'text'|'date', value: string} | {kind: 'number', value: number}} GroupedToken */

/** @param {string} text @returns {GroupedToken[] | null} */
function groupedTokens(text) {
  const token = /\s+|"((?:[^"\r\n]|"")*)"|„([^„“\r\n]*)“|“([^“”\r\n]*)”|(\d{4}-\d{2}-\d{2})|([+-]?\d+(?:[.,]\d+)?)|(<=|>=|!=|[=<>;,:.?!]|\p{L}+)/uy;
  /** @type {GroupedToken[]} */
  const tokens = [];
  while (token.lastIndex < text.length) {
    const match = token.exec(text);
    if (!match) return null;
    const [, ascii, bulgarian, english, date, digits, syntax] = match;
    const quoted = ascii?.replaceAll('""', '"') ?? bulgarian ?? english;
    if (quoted !== undefined) {
      const value = quoted.trim();
      if (!value || value.length > maxQuotedLength || /\p{Cc}/u.test(value)) return null;
      tokens.push({ kind: 'text', value });
    } else if (date) {
      if (!isExactDate(date)) return null;
      tokens.push({ kind: 'date', value: date });
    } else if (digits) {
      const value = Number(digits.replace(',', '.'));
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || (value === 0 && /[1-9]/.test(digits))) return null;
      tokens.push({ kind: 'number', value });
    } else if (syntax) {
      tokens.push({ kind: 'syntax', value: syntax.toLowerCase() });
    }
  }
  return tokens;
}

/** @param {string} prompt @returns {GroupedTableRequest | null} */
export function parseGroupedTableRequest(prompt) {
  const text = groupedCommandBody(prompt);
  if (text.length > maxGroupedLength || !isGroupedTableCommand(text)) return null;
  const tokens = groupedTokens(text);
  if (!tokens) return null;
  if (tokens.at(-1)?.kind === 'syntax' && ['.', '!', '?'].includes(String(tokens.at(-1)?.value))) tokens.pop();

  let cursor = 0;
  /** @param {string[]} words */
  const keyword = (words) => {
    const next = tokens[cursor];
    if (next?.kind !== 'syntax' || !words.includes(next.value)) return undefined;
    cursor++;
    return next.value;
  };
  /** @param {'text'|'date'} kind */
  const named = (kind) => {
    const next = tokens[cursor];
    if (!next || next.kind !== kind) return undefined;
    cursor++;
    return String(next.value);
  };
  const heading = () => {
    keyword(['колона', 'column']);
    return named('text');
  };
  if (keyword(commandWords)) keyword(['the']);

  /** @type {Aggregation[]} */
  const aggregations = [];
  do {
    const operation = operations.get(keyword(operationWords) ?? '');
    if (!operation || aggregations.length === maxGroupedItems) return null;
    if (operation === 'average') keyword(['стойност', 'стойността']);
    const of = keyword(['на', 'of']);
    const column = heading();
    if (!column) {
      if (of || operation !== 'count') return null;
      keyword(['редове', 'редовете', 'rows']);
    }
    const alias = keyword(['като', 'as']);
    const label = alias && named('text');
    if (alias && !label) return null;
    aggregations.push({ operation, ...(column ? { column } : {}), ...(label ? { label } : {}) });
  } while (keyword(conjunctions));
  keyword([',']);
  keyword(['групирана', 'групиран', 'групирано', 'групирани', 'групирай', 'grouped']);
  if (!keyword(groupingWords)) return null;
  const groupBy = heading();
  if (!groupBy) return null;
  const headings = new Set([groupBy, ...aggregations.map(getGroupedAggregationLabel)].map((name) => name.normalize('NFC')));
  if (headings.size !== aggregations.length + 1) return null;
  /** @type {GroupedTableRequest} */
  const request = { operation: 'grouped', groupBy, aggregations };
  /** @type {GroupedFilter[]} */
  const filters = [];

  while (cursor < tokens.length) {
    keyword([',', ';']);
    if (keyword(['за', 'for'])) {
      keyword(['the']);
      if (!keyword(['периода', 'период', 'period']) || !['от', 'from'].includes(String(tokens[cursor]?.value))) return null;
    }
    if (keyword(['от', 'from'])) {
      const value = named('date');
      if (!value || !keyword(['до', 'to'])) return null;
      const end = named('date');
      if (!end || end < value || !keyword(['по', 'on', 'in'])) return null;
      const column = heading();
      if (!column) return null;
      filters.push({ column, operation: 'between', kind: 'date', value, end });
    } else if (keyword(['където', 'where'])) {
      do {
        const column = heading();
        const operation = comparisons.get(keyword(comparisonWords) ?? '');
        const value = tokens[cursor++];
        if (!column || !operation || !value || value.kind === 'syntax' || filters.length === maxGroupedItems) return null;
        if (operation === 'between') {
          if (value.kind === 'text' || !keyword(conjunctions)) return null;
          const end = tokens[cursor++];
          if (!end || end.kind !== value.kind || end.value < value.value) return null;
          if (value.kind === 'number' && end.kind === 'number') filters.push({ column, operation, kind: 'number', value: value.value, end: end.value });
          if (value.kind === 'date' && end.kind === 'date') filters.push({ column, operation, kind: 'date', value: value.value, end: end.value });
        } else {
          if (value.kind === 'text' && operation !== 'eq' && operation !== 'neq') return null;
          filters.push({ column, operation, ...value });
        }
      } while (keyword(conjunctions));
    } else if (keyword(['лист', 'sheet'])) {
      keyword([':', '=']);
      const sheet = named('text');
      if (!sheet || request.sheet) return null;
      request.sheet = sheet;
    } else if (keyword(['сортирай', 'sort'])) {
      if (!keyword(['по', 'by'])) return null;
      const column = named('text');
      const descending = keyword(['низходящо', 'desc', 'descending']);
      const ascending = !descending && keyword(['възходящо', 'asc', 'ascending']);
      if (!column || request.sort || !headings.has(column.normalize('NFC')) || !(descending || ascending)) return null;
      request.sort = { column, direction: descending ? 'desc' : 'asc' };
    } else return null;
    if (filters.length > maxGroupedItems) return null;
  }
  if (filters.length) request.filters = filters;
  return request;
}

function supportsLocalTableAnalysis(prompt) {
  return isGroupedTableCommand(prompt) ? parseGroupedTableRequest(prompt) !== null : supportsTableSummary(prompt);
}

export const withoutDirectives = (prompt) => prompt.replace(instructions, ' ');
export { instruction, supportsLocalTableAnalysis };
