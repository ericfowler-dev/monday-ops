import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyOrderPopulation,
  filterWithinLookback,
  isDateWithinLookback,
  mergeClosedItems,
  parseDate,
  summarize
} from '../src/reporting.js';

const groups = { factory: 'factory', field: 'field' };

test('classifies requested order types without double counting other field work', () => {
  assert.equal(classifyOrderPopulation({ groupId: 'factory', orderType: 'SNAP' }, groups), 'factory');
  assert.equal(classifyOrderPopulation({ groupId: 'field', orderType: 'Missing Parts' }, groups), 'fieldMissingParts');
  assert.equal(classifyOrderPopulation({ groupId: 'field', orderType: 'Warranty' }, groups), 'fieldWarranty');
  assert.equal(classifyOrderPopulation({ groupId: 'field', orderType: 'Service, Sales Order' }, groups), 'other');
  assert.equal(classifyOrderPopulation({ groupId: 'draft', orderType: 'Warranty' }, groups), 'other');
  assert.equal(classifyOrderPopulation({ groupId: 'field', orderType: 'Missing Parts, Warranty' }, groups), 'other');
});

test('mergeClosedItems prefers Date Shipped for current shipped rows', () => {
  const activityDate = parseDate('2026-07-14');
  const shippedDate = parseDate('2026-07-15');
  const merged = mergeClosedItems(
    [{ id: '1', name: 'Current row', dateShipped: shippedDate }],
    [{ id: '1', name: 'Activity row', completedAt: activityDate }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'Current row');
  assert.equal(merged[0].completedAt, shippedDate);
});

test('mergeClosedItems retains activity-only records', () => {
  const completedAt = parseDate('2026-07-13');
  const merged = mergeClosedItems([], [{ id: '2', name: 'Removed row', completedAt }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].completedAt, completedAt);
});

test('lookback windows include today and the preceding calendar days', () => {
  const items = [
    { completedAt: parseDate('2026-07-15') },
    { completedAt: parseDate('2026-07-09') },
    { completedAt: parseDate('2026-07-08') }
  ];
  assert.equal(filterWithinLookback(items, '2026-07-15', 7).length, 2);
});

test('order-date lookbacks use calendar days and exclude future dates', () => {
  const now = new Date('2026-07-15T10:00:00.000Z');
  assert.equal(isDateWithinLookback(parseDate('2026-06-16'), now, 30), true);
  assert.equal(isDateWithinLookback(parseDate('2026-06-15'), now, 30), false);
  assert.equal(isDateWithinLookback(parseDate('2026-07-16'), now, 30), false);
});

test('summarize calculates open-order operational metrics', () => {
  const now = parseDate('2026-07-15');
  const items = [
    {
      id: '1', name: 'Critical order', currentStatus: 'FAB', priority: 'Critical',
      customer: 'A', requestedBy: 'Owner', partNumber: 'P1', orderDate: parseDate('2026-07-13'), ageDays: 2
    },
    {
      id: '2', name: 'Old order', currentStatus: 'Purchasing', priority: '',
      customer: 'B', requestedBy: '', partNumber: '', orderDate: parseDate('2026-05-01'), ageDays: 75
    }
  ];
  const report = summarize(items, now, 10);
  assert.equal(report.total, 2);
  assert.equal(report.priorityAttention, 1);
  assert.equal(report.over30Days, 1);
  assert.equal(report.newLast7Days, 1);
  assert.equal(report.newLast30Days, 1);
  assert.equal(report.dataGaps, 1);
  assert.deepEqual(report.byCurrentStatus, { FAB: 1, Purchasing: 1 });
});
