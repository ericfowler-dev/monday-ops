import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyOrderPopulation,
  buildDashboardShipments,
  isOpenOrder,
  isDateWithinLookback,
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

const shipped = (id, date, overrides = {}) => ({ id, name: id, groupId: 'factory', orderType: 'SNAP',
  state: 'active', currentStatus: 'Shipped', dateShipped: parseDate(date), ...overrides });
const shipmentNow = new Date('2026-09-17T10:00:00Z');

test('shipments include the oldest completed day, exclude today, and partition populations', () => {
  const report = buildDashboardShipments([
    shipped('seven', '2026-09-10'), shipped('fourteen', '2026-09-03'), shipped('thirty', '2026-08-18'),
    shipped('today', '2026-09-17'), shipped('future', '2026-09-18'), shipped('old', '2026-08-17'),
    shipped('field', '2026-09-16', { groupId: 'field', orderType: 'Service' }),
    shipped('unrelated', '2026-09-16', { orderType: 'Other' })
  ], [], shipmentNow, groups);
  assert.deepEqual(report.closedCounts, { 7: 2, 14: 3, 30: 4 });
  assert.equal(report.shipments.snap.last30, 3);
  assert.equal(report.shipments.fieldService.last30, 1);
  assert.equal(report.shipments.total.today, 1);
  assert.deepEqual(report.recentShipped.map(item => item.id), ['field', 'seven']);
});

test('shipment history cannot count cancelled or reopened lines and is deduplicated', () => {
  const items = [shipped('shipped', '2026-09-15'), shipped('shipped', '2026-09-15'),
    shipped('reopened', '2026-09-15', { currentStatus: 'Pending Shipment Approval' }),
    shipped('cancelled', '2026-09-15', { currentStatus: ' Cancelled ' })];
  const events = items.map(item => ({ itemId: item.id, at: parseDate('2026-09-15'), groupId: 'factory' }));
  const report = buildDashboardShipments(items, events, shipmentNow, groups);
  assert.deepEqual(report.closedCounts, { 7: 1, 14: 1, 30: 1 });
  assert.deepEqual(report.recentShipped.map(item => item.id), ['shipped']);
});

test('Date Shipped wins and moved rows use shipment group and Central event date as fallback', () => {
  const report = buildDashboardShipments([
    shipped('dated', '2026-08-01'),
    shipped('moved', null, { groupId: 'archive', orderType: 'Warranty' })
  ], [
    { itemId: 'dated', at: parseDate('2026-09-15'), groupId: 'factory' },
    { itemId: 'moved', at: new Date('2026-09-17T02:00:00Z'), groupId: 'field' }
  ], shipmentNow, groups);
  assert.equal(report.shipments.snap.last30, 0);
  assert.equal(report.shipments.fieldService.last7, 1);
  assert.equal(report.shipments.total.today, 0);
  assert.equal(report.recentShipped[0].completedAt.toISOString().slice(0, 10), '2026-09-16');
});

test('open workload excludes cancelled and shipped lines while retaining reopened work', () => {
  assert.equal(isOpenOrder(shipped('1', null, { currentStatus: ' Cancelled ' })), false);
  assert.equal(isOpenOrder(shipped('2', null)), false);
  assert.equal(isOpenOrder(shipped('3', null, { currentStatus: 'Pending Shipment Approval' })), true);
  assert.equal(isOpenOrder(shipped('4', null, { currentStatus: 'FAB', state: 'archived' })), false);
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
