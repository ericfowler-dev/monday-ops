const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeBoardActivityLogs,
    computeDynamicOwnerActivity,
    buildActionedTrend,
    buildWeeklySnapshot,
    medianOf
} = require('./dynamic-owner-activity-core');

const FROM = new Date('2026-08-03T12:00:00.000Z');
const TO = new Date('2026-08-05T12:00:00.000Z');
const OWNER_MAP = {
    'Dept A': 'Owner A',
    'Dept B': 'Owner B',
    'Dept B - Next': 'Owner B',
    'Ordered from Supplier': null
};

function item(overrides = {}) {
    return {
        id: '1',
        name: 'Order 1',
        population: 'fieldService',
        groupId: 'field',
        status: 'Dept B',
        orderType: 'Warranty',
        createdAt: new Date('2026-07-01T12:00:00.000Z'),
        ageDays: 40,
        isOpen: true,
        url: 'https://example.com/1',
        ...overrides
    };
}

function event(type, at, overrides = {}) {
    return {
        id: `${type}:${at}:${overrides.itemId || '1'}`,
        type,
        itemId: String(overrides.itemId || '1'),
        itemName: overrides.itemName || 'Order 1',
        at: new Date(at),
        actorUserId: overrides.actorUserId || 'actor-1',
        groupId: overrides.groupId || 'field',
        ...overrides
    };
}

function compute(items, events) {
    return computeDynamicOwnerActivity({
        items,
        events,
        fromDate: FROM,
        refDate: TO,
        ownerMap: OWNER_MAP,
        snapGroupId: 'snap',
        fieldServiceGroupId: 'field',
        closedStatuses: ['Shipped'],
        waitingHours: 24,
        pastDueDays: 42
    });
}

test('status handoff and later field edit credit both dynamic owners', () => {
    const events = [
        event('status', '2026-08-04T08:00:00.000Z', { previousStatus: 'Dept A', nextStatus: 'Dept B', columnTitle: 'Current Dept / Status' }),
        event('operational', '2026-08-04T15:00:00.000Z', { columnTitle: 'Tracking/DDL #', category: 'shipping', actorUserId: 'actor-2' })
    ];
    const result = compute([item()], events);
    const rows = result.populations.fieldService.rows;
    assert.equal(rows['Owner A'].actioned, 1);
    assert.equal(rows['Owner A'].handedOff, 1);
    assert.equal(rows['Owner B'].received, 1);
    assert.equal(rows['Owner B'].actioned, 1);
    assert.equal(result.populations.fieldService.handoffs[0].source, 'Owner A');
    assert.equal(result.populations.fieldService.handoffs[0].destination, 'Owner B');
    assert.equal(result.actorRows.find(row => row.userId === 'actor-2').operationalEdits, 1);
});

test('same-owner stage movement is action but not a handoff or new receipt', () => {
    const result = compute([item({ status: 'Dept B - Next' })], [
        event('status', '2026-08-04T08:00:00.000Z', { previousStatus: 'Dept B', nextStatus: 'Dept B - Next', columnTitle: 'Current Dept / Status' })
    ]);
    const owner = result.populations.fieldService.rows['Owner B'];
    assert.equal(owner.actioned, 1);
    assert.equal(owner.received, 0);
    assert.equal(owner.handedOff, 0);
});

test('draft work counts for the actor and operational ownership begins on group entry', () => {
    const newItem = item({ createdAt: new Date('2026-08-04T07:00:00.000Z'), groupId: 'field', status: 'Dept B' });
    const result = compute([newItem], [
        event('operational', '2026-08-04T08:00:00.000Z', { groupId: 'draft', columnTitle: 'Purchase Order', actorUserId: 'ambrea' }),
        event('group_move', '2026-08-04T09:00:00.000Z', {
            sourceGroupId: 'draft', destinationGroupId: 'field', destinationGroupName: 'Field Service', actorUserId: 'ambrea'
        }),
        event('operational', '2026-08-04T10:00:00.000Z', { groupId: 'field', columnTitle: 'Tracking/DDL #', actorUserId: 'ambrea' })
    ]);
    const owner = result.populations.fieldService.rows['Owner B'];
    assert.equal(owner.received, 1);
    assert.equal(owner.actioned, 1);
    assert.equal(owner.activityEvents, 1);
    assert.equal(result.actorRows[0].events, 3);
    assert.equal(result.eventAttributions[0].creditOwner, null);
    assert.equal(result.eventAttributions[0].reason, 'outside-report-group');
    assert.equal(result.eventAttributions[1].receivedOwner, 'Owner B');
    assert.equal(result.eventAttributions[2].creditOwner, 'Owner B');
});

test('current item with no qualifying activity becomes a waiting exception', () => {
    const result = compute([item({ status: 'Dept A', ageDays: 70 })], []);
    const owner = result.populations.fieldService.rows['Owner A'];
    assert.equal(owner.waiting, 1);
    assert.equal(owner.actioned, 0);
    assert.equal(owner.past6w, 1);
    assert.equal(owner.actionRate, 0);
    assert.equal(result.populations.fieldService.attention[0].waitingLowerBound, true);
});

test('informational supplier stage stays in open total but not owner waiting metrics', () => {
    const result = compute([item({ status: 'Ordered from Supplier' })], []);
    assert.equal(result.populations.fieldService.currentOpen, 1);
    assert.equal(result.populations.fieldService.informationalOpen, 1);
    assert.equal(result.populations.fieldService.totals.current, 0);
    assert.equal(result.populations.fieldService.totals.waiting, 0);
});

test('net flow, waiting percentage, activity coverage, and median wait aggregate per owner', () => {
    const items = [
        item(),
        item({ id: '2', name: 'Order 2', status: 'Dept B' })
    ];
    const events = [
        event('status', '2026-08-04T08:00:00.000Z', { previousStatus: 'Dept A', nextStatus: 'Dept B', columnTitle: 'Current Dept / Status' }),
        event('operational', '2026-08-05T06:00:00.000Z', { itemId: '2', itemName: 'Order 2', columnTitle: 'Tracking/DDL #', category: 'shipping' })
    ];
    const result = compute(items, events);
    const rows = result.populations.fieldService.rows;
    const totals = result.populations.fieldService.totals;
    assert.equal(rows['Owner A'].netFlow, -1);
    assert.equal(rows['Owner A'].waitingPct, null);
    assert.equal(rows['Owner B'].netFlow, 1);
    assert.equal(rows['Owner B'].waitingPct, 50);
    assert.equal(totals.netFlow, 0);
    assert.equal(totals.current, 2);
    assert.equal(totals.waiting, 1);
    assert.equal(totals.waitingPct, 50);
    assert.equal(totals.activityCoverage, 50);
    assert.equal(totals.medianWaitHours, 17);
    assert.equal(totals.medianWaitLowerBound, false);
});

test('median wait lower bound propagates from window-truncated pairs', () => {
    const result = compute([item({ status: 'Dept A' })], []);
    const owner = result.populations.fieldService.rows['Owner A'];
    assert.equal(owner.medianWaitHours, 48);
    assert.equal(owner.medianWaitLowerBound, true);
});

test('closed status transitions count as closed orders for the population', () => {
    const result = compute([item({ status: 'Shipped', isOpen: false })], [
        event('status', '2026-08-04T08:00:00.000Z', { previousStatus: 'Dept B', nextStatus: 'Shipped', columnTitle: 'Current Dept / Status' })
    ]);
    const population = result.populations.fieldService;
    assert.equal(population.closedOrders, 1);
    assert.equal(population.rows['Owner B'].handedOff, 1);
    assert.equal(population.handoffs[0].destination, 'Closed — Shipped');
    assert.equal(result.executive.closedOrders, 1);
});

test('aging buckets classify current assignments by order age', () => {
    const items = [
        item({ id: '1', name: 'Order 1', status: 'Dept A', ageDays: 3 }),
        item({ id: '2', name: 'Order 2', status: 'Dept A', ageDays: 10 }),
        item({ id: '3', name: 'Order 3', status: 'Dept A', ageDays: 40 }),
        item({ id: '4', name: 'Order 4', status: 'Dept A', ageDays: 70 }),
        item({ id: '5', name: 'Order 5', status: 'Dept A', ageDays: null })
    ];
    const aging = compute(items, []).populations.fieldService.agingBuckets;
    assert.equal(aging.total, 5);
    assert.equal(aging.unknownAge, 1);
    const counts = Object.fromEntries(aging.buckets.map(bucket => [bucket.label, bucket.count]));
    assert.equal(counts['Under 7 days'], 1);
    assert.equal(counts['7–13 days'], 1);
    assert.equal(counts['14–27 days'], 0);
    assert.equal(counts['28–41 days'], 1);
    assert.equal(counts['42 days or more'], 1);
    assert.equal(aging.buckets[0].pct, 20);
});

test('status bottlenecks group current work with waiting stats and supplier rows', () => {
    const items = [
        item({ id: '1', name: 'Order 1', status: 'Dept A', ageDays: 50 }),
        item({ id: '2', name: 'Order 2', status: 'Dept A', ageDays: 5 }),
        item({ id: '3', name: 'Order 3', status: 'Ordered from Supplier' }),
        item({ id: '4', name: 'Order 4', status: 'Mystery Dept' })
    ];
    const events = [
        event('operational', '2026-08-05T06:00:00.000Z', { itemId: '2', itemName: 'Order 2', columnTitle: 'Tracking/DDL #', category: 'shipping' })
    ];
    const bottlenecks = compute(items, events).populations.fieldService.statusBottlenecks;
    const deptA = bottlenecks.find(row => row.status === 'Dept A');
    assert.equal(deptA.currentCount, 2);
    assert.equal(deptA.waiting, 1);
    assert.equal(deptA.waitingPct, 50);
    assert.equal(deptA.oldestAgeDays, 50);
    const supplier = bottlenecks.find(row => row.supplierWaiting);
    assert.equal(supplier.status, 'Ordered from Supplier');
    assert.equal(supplier.currentCount, 1);
    assert.equal(supplier.waitingPct, null);
    const unmapped = bottlenecks.find(row => row.status === 'Mystery Dept');
    assert.equal(unmapped.waiting, 1);
});

test('data quality counts unmapped assignments and unknown actors', () => {
    const items = [item({ status: 'Mystery Dept' })];
    const events = [
        event('operational', '2026-08-04T08:00:00.000Z', { columnTitle: 'Tracking/DDL #', category: 'shipping', actorUserId: 'unknown' })
    ];
    const result = compute(items, events);
    assert.equal(result.dataQuality.unmappedCurrentPairs, 1);
    assert.equal(result.dataQuality.unknownActorEvents, 1);
    assert.equal(result.dataQuality.unavailableEventItems, 0);
});

test('attention entries carry reason flags for waiting, age, and unmapped ownership', () => {
    const result = compute([
        item({ id: '1', name: 'Order 1', status: 'Dept A', ageDays: 70 }),
        item({ id: '2', name: 'Order 2', status: 'Mystery Dept', ageDays: 5 })
    ], []);
    const attention = result.populations.fieldService.attention;
    const aged = attention.find(entry => entry.itemId === '1');
    assert.match(aged.reasons[0], /^No qualifying activity for at least /);
    assert.ok(aged.reasons.includes('Order age over 42 days'));
    const unmapped = attention.find(entry => entry.itemId === '2');
    assert.ok(unmapped.reasons.includes('Unmapped owner — check config'));
});

test('executive summary sums both populations with basis labels', () => {
    const items = [
        item({ id: '1', name: 'Field order', status: 'Dept B' }),
        item({ id: '2', name: 'Snap order', population: 'snap', groupId: 'snap', isSnapOrder: true, status: 'Dept A' }),
        item({ id: '3', name: 'Supplier order', status: 'Ordered from Supplier' })
    ];
    const events = [
        event('status', '2026-08-04T08:00:00.000Z', { previousStatus: 'Dept A', nextStatus: 'Dept B', columnTitle: 'Current Dept / Status' })
    ];
    const executive = compute(items, events).executive;
    assert.equal(executive.currentOpenOrders, 3);
    assert.equal(executive.snapOpen, 1);
    assert.equal(executive.fieldOpen, 2);
    assert.equal(executive.supplierWaiting, 1);
    assert.equal(executive.received, 1);
    assert.equal(executive.movedOnward, 1);
    assert.equal(executive.netFlow, 0);
    assert.equal(executive.currentAssigned, 2);
    assert.equal(executive.waiting, 2);
    assert.equal(executive.waitingPct, 100);
    assert.equal(executive.activityCoverage, 0);
    assert.equal(executive.basis.received, 'owner-item pairs');
    assert.equal(executive.basis.currentOpenOrders, 'unique orders');
});

test('weekly snapshot captures executive, population, and item state', () => {
    const items = [
        item({ id: '1', name: 'Field order', status: 'Dept B' }),
        item({ id: '2', name: 'Supplier order', status: 'Ordered from Supplier' }),
        item({ id: '3', name: 'Mystery order', status: 'Mystery Dept' })
    ];
    const result = compute(items, []);
    const snapshot = buildWeeklySnapshot({ result, items, refDate: TO });
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.generatedAt, TO.toISOString());
    assert.equal(snapshot.items.length, 3);
    assert.equal(snapshot.critical.openCritical, 0);
    assert.equal(snapshot.closure.closedCount, 0);
    const assigned = snapshot.items.find(entry => entry.id === '1');
    assert.equal(assigned.owner, 'Owner B');
    assert.equal(assigned.waitingLowerBound, true);
    assert.ok(assigned.waitingHours > 0);
    assert.equal(assigned.isCritical, false);
    assert.equal(assigned.priority, '');
    assert.equal(snapshot.populations.fieldService.rows['Owner B'].medianDwellHours, null);
    assert.deepEqual(snapshot.populations.fieldService.rows['Owner B'].dwellSampleHours, []);
    const supplier = snapshot.items.find(entry => entry.id === '2');
    assert.equal(supplier.owner, null);
    assert.equal(supplier.supplierWaiting, true);
    const mystery = snapshot.items.find(entry => entry.id === '3');
    assert.equal(mystery.unmapped, true);
    assert.equal(snapshot.executive.currentOpenOrders, 3);
    assert.equal(snapshot.populations.fieldService.totals.current, 2);
    assert.ok(snapshot.populations.fieldService.rows['Owner B']);
});

test('medianOf handles odd, even, and empty inputs', () => {
    assert.equal(medianOf([3, 1, 2]), 2);
    assert.equal(medianOf([1, 2, 3, 4]), 2.5);
    assert.equal(medianOf([]), null);
});

test('dwell before handoff is tracked per owner with lower bounds at the window edge', () => {
    const events = [
        event('status', '2026-08-04T08:00:00.000Z', { previousStatus: 'Dept A', nextStatus: 'Dept B', columnTitle: 'Current Dept / Status' }),
        event('status', '2026-08-04T18:00:00.000Z', { previousStatus: 'Dept B', nextStatus: 'Dept A', columnTitle: 'Current Dept / Status' })
    ];
    const result = compute([item({ status: 'Dept A' })], events);
    const rows = result.populations.fieldService.rows;
    // Owner A held the item since before the window (episode pinned to the edge).
    assert.equal(rows['Owner A'].medianDwellHours, 20);
    assert.equal(rows['Owner A'].medianDwellLowerBound, true);
    // Owner B received at 08:00 and handed off at 18:00 — exact 10h dwell.
    assert.equal(rows['Owner B'].medianDwellHours, 10);
    assert.equal(rows['Owner B'].medianDwellLowerBound, false);
    assert.deepEqual(rows['Owner B'].dwellSampleHours, [10]);
});

test('top actioned owners exclude unmapped rows and handle ties and zero activity', () => {
    const tie = compute([item()], [
        event('status', '2026-08-04T08:00:00.000Z', { previousStatus: 'Dept A', nextStatus: 'Dept B', columnTitle: 'Current Dept / Status' }),
        event('operational', '2026-08-04T15:00:00.000Z', { columnTitle: 'Tracking/DDL #', category: 'shipping' })
    ]);
    assert.deepEqual(tie.populations.fieldService.topActionedOwners, ['Owner A', 'Owner B']);
    const quiet = compute([item({ status: 'Dept A' })], []);
    assert.deepEqual(quiet.populations.fieldService.topActionedOwners, []);
    const unmappedOnly = compute([item({ status: 'Mystery Dept' })], [
        event('operational', '2026-08-04T08:00:00.000Z', { columnTitle: 'Tracking/DDL #', category: 'shipping' })
    ]);
    assert.deepEqual(unmappedOnly.populations.fieldService.topActionedOwners, []);
});

test('critical summary counts open critical lines, ages, and top holders', () => {
    const items = [
        item({ id: '1', name: 'Critical 1', status: 'Dept A', isCritical: true, priority: 'Critical', ageDays: 10 }),
        item({ id: '2', name: 'Critical 2', status: 'Dept A', isCritical: true, priority: 'Critical', ageDays: 30 }),
        item({ id: '3', name: 'Critical supplier', status: 'Ordered from Supplier', isCritical: true, priority: 'Critical', ageDays: 5 }),
        item({ id: '4', name: 'Normal', status: 'Dept B', isCritical: false }),
        item({ id: '5', name: 'Closed critical', status: 'Shipped', isCritical: true, priority: 'Critical', isOpen: false })
    ];
    const critical = compute(items, []).critical;
    assert.equal(critical.openCritical, 3);
    assert.equal(critical.perPopulation.fieldService, 3);
    assert.equal(critical.avgAgeDays, 15);
    assert.deepEqual(critical.topHolders, [{ owner: 'Owner A', count: 2 }]);
});

test('closure stats measure Date Shipped minus Order Date for orders closed this period', () => {
    const items = [
        item({ id: '1', name: 'Shipped 1', status: 'Shipped', isOpen: false, orderDate: new Date('2026-08-01T12:00:00.000Z'), dateShipped: new Date('2026-08-04T12:00:00.000Z') }),
        item({ id: '2', name: 'Shipped no dates', status: 'Shipped', isOpen: false }),
        item({ id: '3', name: 'Shipped by date only', status: 'Shipped', isOpen: false, orderDate: new Date('2026-07-31T12:00:00.000Z'), dateShipped: new Date('2026-08-04T12:00:00.000Z') }),
        item({ id: '4', name: 'Open order', status: 'Dept A' })
    ];
    const events = [
        event('status', '2026-08-04T08:00:00.000Z', { itemId: '1', itemName: 'Shipped 1', previousStatus: 'Dept B', nextStatus: 'Shipped', columnTitle: 'Current Dept / Status' }),
        event('status', '2026-08-04T09:00:00.000Z', { itemId: '2', itemName: 'Shipped no dates', previousStatus: 'Dept B', nextStatus: 'Shipped', columnTitle: 'Current Dept / Status' })
    ];
    const closure = compute(items, events).closure;
    // Items 1 and 2 closed via transition; item 3 has a Date Shipped inside the
    // window with no visible transition; item 2 is unmeasurable (no dates).
    assert.equal(closure.closedCount, 3);
    assert.equal(closure.measuredCount, 2);
    assert.equal(closure.avgClosureDays, 3.5);
    assert.equal(closure.medianClosureDays, 3.5);
});

test('actioned trend merges populations per person and tolerates v1 snapshots', () => {
    const currentResult = compute([item()], [
        event('status', '2026-08-04T08:00:00.000Z', { previousStatus: 'Dept A', nextStatus: 'Dept B', columnTitle: 'Current Dept / Status' })
    ]);
    const historyWeeks = {
        '2026-07-27': { version: 1, populations: { snap: { rows: { 'Owner A': { actioned: 2 } } }, fieldService: { rows: { 'Owner A': { actioned: 1 }, 'Unmapped — check config': { actioned: 9 } } } } },
        '2026-08-10': { version: 2, populations: { snap: { rows: {} }, fieldService: { rows: { 'Owner B': { actioned: 4 } } } } },
        '2026-08-03': null
    };
    const trend = buildActionedTrend({ historyWeeks, currentWeekKey: '2026-08-17', currentResult, maxWeeks: 8 });
    assert.deepEqual(trend.weekKeys, ['2026-07-27', '2026-08-10', '2026-08-17']);
    assert.equal(trend.weeksAvailable, 3);
    const ownerA = trend.owners.find(row => row.owner === 'Owner A');
    assert.deepEqual(ownerA.counts, [3, 0, 1]);
    const ownerB = trend.owners.find(row => row.owner === 'Owner B');
    assert.deepEqual(ownerB.counts, [0, 4, 0]);
    assert.equal(trend.maxCount, 4);
    assert.ok(!trend.owners.some(row => row.owner.includes('Unmapped')));
    const trimmed = buildActionedTrend({ historyWeeks, currentWeekKey: '2026-08-17', currentResult, maxWeeks: 2 });
    assert.deepEqual(trimmed.weekKeys, ['2026-08-10', '2026-08-17']);
});

test('normalizer deduplicates activity, removes same-value edits, and keeps group moves', () => {
    const stamp = String(Date.parse('2026-08-04T12:00:00.000Z') * 10000);
    const statusData = JSON.stringify({
        pulse_id: 1, pulse_name: 'Order 1', group_id: 'field', column_id: 'status',
        previous_value: { label: { text: 'Dept A' } }, value: { label: { text: 'Dept B' } }
    });
    const sameData = JSON.stringify({
        pulse_id: 1, pulse_name: 'Order 1', group_id: 'field', column_id: 'tracking',
        previous_value: { value: 'ABC' }, value: { value: 'ABC' }
    });
    const moveData = JSON.stringify({
        pulse_id: 1, pulse: { id: 1, name: 'Order 1' },
        source_group: { id: 'draft', title: 'Drafts' }, dest_group: { id: 'field', title: 'Field' }
    });
    const logs = [
        { id: 'a', event: 'update_column_value', data: statusData, created_at: stamp, user_id: '1' },
        { id: 'a', event: 'update_column_value', data: statusData, created_at: stamp, user_id: '1' },
        { id: 'b', event: 'update_column_value', data: sameData, created_at: stamp, user_id: '1' },
        { id: 'c', event: 'move_pulse_from_group', data: moveData, created_at: stamp, user_id: '1' }
    ];
    const events = normalizeBoardActivityLogs(logs, [
        { id: 'status', title: 'Current Dept / Status', kind: 'status', category: 'status' },
        { id: 'tracking', title: 'Tracking', kind: 'operational', category: 'shipping' }
    ]);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'status');
    assert.equal(events[1].type, 'group_move');
});
