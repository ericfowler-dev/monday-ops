const test = require('node:test');
const assert = require('node:assert/strict');
const { shipmentEvents, buildShipmentSummary, summarizeOpenOrders, isDeliveryWindow } = require('./movement-daily-core');
const { computeDynamicOwnerActivity, buildActionedTrend } = require('./dynamic-owner-activity-core');
const { renderShipmentChart } = require('./generate-dynamic-owner-preview');
const now = new Date('2026-09-16T10:00:00Z');
const item = (id, overrides = {}) => ({ id, status: 'Shipped', groupId: 'snap', population: 'snap', isSnapOrder: true,
    dateShipped: new Date('2026-09-15T12:00:00Z'), orderDate: new Date('2026-09-01T12:00:00Z'), ...overrides });
const summarize = (items, events = []) => buildShipmentSummary({ items, events, now, snapGroupId: 'snap', fieldServiceGroupId: 'field' });

test('shipment charts exclude cancellations and reopened lines and count each line once', () => {
    const result = summarize([item('1'), item('1'), item('2', { status: ' Cancelled ' }), item('3', { status: 'Purchasing' }),
        item('4', { groupId: 'field', population: 'fieldService', isSnapOrder: false })]);
    assert.equal(result.total.last7, 2);
    assert.equal(result.snap.last7, 1);
    assert.equal(result.fieldService.last7, 1);
    assert.equal(result.closure.closedCount, 2);
    assert.equal(result.closure.avgClosureDays, 14);
});
test('all 14 completed days remain visible and today is separate from comparable seven-day periods', () => {
    const result = summarize([item('today', { dateShipped: new Date('2026-09-16T12:00:00Z') }),
        item('older', { dateShipped: new Date('2026-09-02T12:00:00Z') }), item('recent')]);
    assert.equal(result.snap.days.length, 14);
    assert.equal(result.snap.days[0].date, '2026-09-02');
    assert.equal(result.snap.days[13].date, '2026-09-15');
    assert.equal(result.snap.last7, 1);
    assert.equal(result.snap.previous7, 1);
    assert.equal(result.snap.today, 1);
    assert.equal(result.snap.days.filter(day => day.count === 0).length, 12);
});
test('30-day boundary, future dates and non-SNAP factory lines are handled explicitly', () => {
    const result = summarize([item('boundary', { dateShipped: '2026-08-17' }), item('too-old', { dateShipped: '2026-08-16' }),
        item('future', { dateShipped: '2026-09-17' }), item('other', { isSnapOrder: false })]);
    assert.equal(result.total.last30, 1);
    assert.equal(result.total.last14, 0);
});
test('automated bulk shipment events count outcomes, deduplicate, and ignore undo and same-status edits', () => {
    const log = { id: 'a', event: 'update_column_value', user_id: '-4', created_at: String(new Date('2026-09-15T22:00:00Z').getTime() * 10000),
        data: JSON.stringify({ pulse_ids: ['1', '2'], group_id: 'field', column_id: 'status', value: { label: { text: 'Shipped' } }, previous_value: { label: { text: 'Packing' } } }) };
    const undo = { ...log, id: 'undo', data: JSON.stringify({ ...JSON.parse(log.data), is_undo_action: true }) };
    const same = { ...log, id: 'same', data: JSON.stringify({ ...JSON.parse(log.data), previous_value: { label: { text: 'Shipped' } } }) };
    const events = shipmentEvents([log, log, undo, same], 'status');
    assert.equal(events.length, 2);
    const result = summarize([item('1', { dateShipped: null, groupId: 'archive', population: null }), item('2', { dateShipped: null })], events);
    assert.equal(result.fieldService.last7, 2);
    assert.equal(result.snap.last7, 0);
});
test('shipment fallback timestamps use the Central calendar date and latest closure only', () => {
    const result = summarize([item('1', { dateShipped: null })], [
        { itemId: '1', at: new Date('2026-09-10T22:00:00Z'), groupId: 'snap' },
        { itemId: '1', at: new Date('2026-09-16T02:00:00Z'), groupId: 'snap' }
    ]);
    assert.equal(result.snap.last7, 1);
    assert.equal(result.snap.days[13].count, 1);
    assert.equal(result.snap.today, 0);
});
test('Field subtype counts partition all open lines without double-counting mixed types', () => {
    const base = { population: 'fieldService', groupId: 'field', status: 'Purchasing', isOpen: true, dateShipped: null };
    const result = summarizeOpenOrders([
        item('1', { ...base, orderType: 'Missing Parts', priority: 'Critical' }),
        item('2', { ...base, orderType: 'Warranty', priority: 'High' }),
        item('3', { ...base, orderType: 'Missing Parts, Warranty' }),
        item('4', { ...base, orderType: 'Warranty', status: 'Cancelled' })
    ], now).fieldService;
    assert.deepEqual(result.types, { missingParts: 1, warranty: 1, other: 1 });
    assert.equal(result.total, 3);
    assert.equal(result.critical, 1);
    assert.equal(result.high, 1);
});
test('5 AM weekday delivery handles summer, winter and weekends without companion duplicates', () => {
    for (const value of ['2026-09-16T10:00:00Z', '2026-11-02T11:00:00Z', '2026-03-09T10:00:00Z']) assert.equal(isDeliveryWindow(new Date(value)), true, value);
    for (const value of ['2026-09-16T11:00:00Z', '2026-11-02T10:00:00Z', '2026-09-19T10:00:00Z', '2026-09-16T17:00:00Z']) assert.equal(isDeliveryWindow(new Date(value)), false, value);
});
test('cancelled item contributes no open, closed, actor, queue, critical, closure or quality metrics', () => {
    const result = computeDynamicOwnerActivity({ items: [item('1', { status: 'Cancelled', isOpen: true, isCritical: true })],
        events: [{ itemId: '1', type: 'status', at: new Date('2026-09-15T10:00:00Z'), previousStatus: 'Purchasing', nextStatus: 'Cancelled', actorUserId: 'person' }],
        fromDate: new Date('2026-09-09T10:00:00Z'), refDate: now, ownerMap: { Purchasing: 'Person' },
        snapGroupId: 'snap', fieldServiceGroupId: 'field', closedStatuses: ['Shipped'], waitingHours: 24, pastDueDays: 42 });
    assert.equal(result.executive.currentOpenOrders, 0);
    assert.equal(result.executive.closedOrders, 0);
    assert.equal(result.critical.openCritical, 0);
    assert.equal(result.closure.closedCount, 0);
    assert.equal(result.qualifyingEvents, 0);
    assert.equal(result.actorRows.length, 0);
    assert.equal(result.currentAssignments.length, 0);
    assert.equal(result.dataQuality.unavailableEventItems, 0);
});
test('historical person trends remove later-cancelled items and omit unfilterable legacy totals', () => {
    const populations = { snap: { actorRows: [{ userId: 'p', name: 'Person', actioned: 2, actionedItemIds: ['kept', 'cancelled'] }] }, fieldService: { actorRows: [] } };
    const result = buildActionedTrend({ historyWeeks: { '2026-08-31': { version: 2, populations }, '2026-09-07': { version: 3, populations } },
        currentWeekKey: '2026-09-16', currentResult: { populations }, excludedItemIds: new Set(['cancelled']), requireItemEvidence: true });
    assert.deepEqual(result.weekKeys, ['2026-09-07', '2026-09-16']);
    assert.deepEqual(result.owners[0].counts, [1, 1]);
});
test('email shipment chart renders zero days, comparisons and Outlook-compatible table bars', () => {
    const result = summarize([item('1')]);
    const html = renderShipmentChart(result.snap, result, '#2563eb');
    assert.match(html, /Shipped per day/);
    assert.match(html, /up from 0/);
    assert.match(html, /Today so far/);
    assert.match(html, /bgcolor="#2563eb"/);
    assert.doesNotMatch(html, /Cancelled|<svg|<canvas|NaN|Infinity/);
});
