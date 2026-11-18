import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getGroupedAggregationLabel, instruction, isGroupedTableCommand, parseGroupedTableRequest, supportsLocalTableAnalysis,
} from '../lib/table-request.mjs';

const octoberTotals = {
  operation: 'grouped', groupBy: 'Град', aggregations: [{ operation: 'sum', column: 'Приход' }],
  filters: [{ column: 'Дата', operation: 'between', kind: 'date', value: '2026-10-01', end: '2026-10-31' }],
};

test('canonical Bulgarian commands preserve exact headers and date boundaries', () => {
  for (const prompt of [
    'Сумирай „Приход“ по „Град“, от 2026-10-01 до 2026-10-31 по „Дата“',
    'Моля, изчисли сумата на колона „Приход“, групирана по колона „Град“, за периода от 2026-10-01 до 2026-10-31 по колона „Дата“.',
    'Би ли сумирал „Приход“ по „Град“, от 2026-10-01 до 2026-10-31 по „Дата“?',
    'Можеш ли да сумираш „Приход“ по „Град“, от 2026-10-01 до 2026-10-31 по „Дата“?',
  ]) {
    assert.equal(isGroupedTableCommand(prompt), true);
    assert.equal(supportsLocalTableAnalysis(prompt), true);
    assert.deepEqual(parseGroupedTableRequest(prompt), octoberTotals);
  }
  assert.equal(getGroupedAggregationLabel(octoberTotals.aggregations[0]), 'Сума Приход');
  assert.equal(getGroupedAggregationLabel({ operation: 'count' }), 'Брой');
});

test('canonical English, sheet selection and locale decimal filters', () => {
  assert.deepEqual(parseGroupedTableRequest('Could you please sum "Revenue" by "City", from 2026-10-01 to 2026-10-31 on "Date"?'), {
    operation: 'grouped', groupBy: 'City', aggregations: [{ operation: 'sum', column: 'Revenue' }],
    filters: [{ column: 'Date', operation: 'between', kind: 'date', value: '2026-10-01', end: '2026-10-31' }],
  });
  assert.deepEqual(parseGroupedTableRequest(
    'Sum "Revenue" as “Total” and count rows by “City”; where "Revenue" between -1,5 and 900.25 and "Status" != "2026-10-01"; sheet: "Q4 Sales"; sort by "Total" desc',
  ), {
    operation: 'grouped', groupBy: 'City',
    aggregations: [{ operation: 'sum', column: 'Revenue', label: 'Total' }, { operation: 'count' }],
    filters: [
      { column: 'Revenue', operation: 'between', kind: 'number', value: -1.5, end: 900.25 },
      { column: 'Status', operation: 'neq', kind: 'text', value: '2026-10-01' },
    ],
    sheet: 'Q4 Sales', sort: { column: 'Total', direction: 'desc' },
  });
});

test('remaining aggregation operations, explicit ISO equality and escaped quotes', () => {
  assert.deepEqual(parseGroupedTableRequest(
    'Средната стойност на „Приход“ и минимум „Приход“ и максимум „Приход“ и преброй "Order ""type""" по „Град“ където „Дата“ = 2024-02-29',
  ), {
    operation: 'grouped', groupBy: 'Град',
    aggregations: [
      { operation: 'average', column: 'Приход' }, { operation: 'min', column: 'Приход' },
      { operation: 'max', column: 'Приход' }, { operation: 'count', column: 'Order "type"' },
    ],
    filters: [{ column: 'Дата', operation: 'eq', kind: 'date', value: '2024-02-29' }],
  });
});

test('recognized but unsupported grouped requests are rejected before table/model routing', () => {
  for (const prompt of [
    'Sum Revenue by City',
    'Sum "Revenue" by',
    'Sum "Revenue" by "City"; from 2026-02-30 to 2026-03-05 on "Date"',
    'Sum "Revenue" by "City"; from 2026-10-31 to 2026-10-01 on "Date"',
    'Sum "Revenue" by "City"; from "2026-10-01" to "2026-10-31" on "Date"',
    'Sum "Revenue" by "City" where "Date" between 2024-10-01 and 5',
    'Sum "Revenue" by "City" where "Revenue" between 3 and 2',
    'Sum "Revenue" by "City" where "City" > "Sofia"',
    'Sum "Revenue" by "City" where "Revenue" = 9007199254740992',
    'Sum "Revenue" by "City" where "Revenue" = undefined',
    'Sum "Revenue" by "City" where "Revenue" = 1 or "Revenue" = 2',
    'Sum "Revenue" by "City" where "Revenue" = Math.random()',
    'Sum "Revenue" as "City" by "City"',
    'Sum "Revenue" and sum "Revenue" by "City"',
    'Sum "Revenue" by "City"; sort by "Unrequested output column" desc',
    'Sum "Revenue" by "City"; sheet: "Q1"; sheet: "Q2"',
    'Sum "Revenue" by "City"; take 1',
    `Sum "${'A'.repeat(161)}" by "City"`,
    `Sum ${Array.from({ length: 6 }, (_, index) => `"A${index}"`).join(' and sum ')} by "City"`,
    `Sum "Revenue" by "City"; where ${Array.from({ length: 6 }, (_, index) => `"Amount" >= ${index}`).join(' and ')}`,
  ]) {
    assert.equal(isGroupedTableCommand(prompt), true, prompt);
    assert.equal(supportsLocalTableAnalysis(prompt), false, prompt);
    assert.equal(parseGroupedTableRequest(prompt), null, prompt);
  }
});

test('summary and chart directives remain distinct from grouped requests', () => {
  for (const prompt of [
    'Обобщи CSV', 'Sum by columns', 'sum; column: "Cost by city"',
    'Направи графика от XLSX; лист: "Sales per Month"; колона: "Amount"',
  ]) {
    assert.equal(supportsLocalTableAnalysis(prompt), true, prompt);
    assert.equal(isGroupedTableCommand(prompt), false, prompt);
    assert.equal(parseGroupedTableRequest(prompt), null, prompt);
  }
  assert.equal(instruction('sum; column: "Cost by city"', ['column']), 'Cost by city');
  assert.equal(isGroupedTableCommand('Sum "Cost by city"'), false);
  assert.equal(supportsLocalTableAnalysis('Изчисли регресия и прогноза за продажби'), false);
});
