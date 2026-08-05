const test = require('node:test');
const assert = require('node:assert/strict');
const {
    INFORMATIONAL_LABEL,
    UNMAPPED_LABEL,
    normalizeQty,
    ownerFor,
    snapshotItem,
    findBaselineWeek,
    computeMovement,
    computeHoldingsProfile,
    sortBucketLabels,
    computeOldestUntouched,
    buildCallouts,
    computeGateCounts,
    computeByUnit,
    pruneWeeks
} = require('./weekly-movement-core');

const OWNER_MAP = {
    'Purchasing': 'Jack Richards',
    'FAB': 'Jessica Hernandez',
    'Approved for Shipment': 'Jessica Sanchez',
    'Pending Shipment Approval': { snap: 'Clare Heckert', fieldService: 'Ambrea Ayala' },
    'Ordered from Supplier': null
};

function baselineItem(overrides = {}) {
    return {
        name: 'SNAP-1', population: 'snap', status: 'Purchasing', qty: '1',
        orderDate: '2026-07-01', cxAlloyId: 'CX-1', priority: '', customer: 'Peterson',
        createdAt: '2026-07-01T12:00:00.000Z', updatedAt: '2026-07-20T12:00:00.000Z', ageDays: 30,
        ...overrides
    };
}

test('normalizeQty treats numeric equivalents as equal and keeps text', () => {
    assert.equal(normalizeQty('1'), normalizeQty('1.0'));
    assert.equal(normalizeQty(' 4 '), '4');
    assert.equal(normalizeQty(''), '');
    assert.equal(normalizeQty('N/A'), 'N/A');
});

test('ownerFor resolves plain, split, informational, and unmapped statuses', () => {
    assert.deepEqual(ownerFor('Purchasing', 'snap', OWNER_MAP), { owner: 'Jack Richards' });
    assert.deepEqual(ownerFor('  purchasing ', 'snap', OWNER_MAP), { owner: 'Jack Richards' });
    assert.deepEqual(ownerFor('Pending Shipment Approval', 'snap', OWNER_MAP), { owner: 'Clare Heckert' });
    assert.deepEqual(ownerFor('Pending Shipment Approval', 'fieldService', OWNER_MAP), { owner: 'Ambrea Ayala' });
    assert.deepEqual(ownerFor('Ordered from Supplier', 'snap', OWNER_MAP), { informational: true });
    assert.deepEqual(ownerFor('Mystery Stage', 'snap', OWNER_MAP), { unmapped: true });
});

test('snapshotItem normalizes fields and serializes dates', () => {
    const snapshot = snapshotItem({
        name: 'SNAP-9', currentStatus: ' FAB ', quantity: ' 2.0 ',
        orderDate: new Date('2026-07-15T12:00:00.000Z'), cxAlloyId: ' CX-9 ',
        priority: 'High', customer: 'Carter',
        createdAt: new Date('2026-07-01T00:00:00.000Z'), updatedAt: new Date('2026-07-28T00:00:00.000Z'),
        ageDays: 21
    }, 'snap');
    assert.equal(snapshot.status, 'FAB');
    assert.equal(snapshot.qty, '2');
    assert.equal(snapshot.orderDate, '2026-07-15');
    assert.equal(snapshot.cxAlloyId, 'CX-9');
    assert.equal(snapshot.population, 'snap');
    assert.equal(snapshot.updatedAt, '2026-07-28T00:00:00.000Z');
});

test('findBaselineWeek picks the latest week strictly before the current key', () => {
    const weeks = { '2026-07-20': { a: 1 }, '2026-07-27': { a: 2 }, '2026-08-03': { a: 3 } };
    assert.equal(findBaselineWeek(weeks, '2026-08-03').weekKey, '2026-07-27');
    assert.equal(findBaselineWeek(weeks, '2026-08-10').weekKey, '2026-08-03');
    assert.equal(findBaselineWeek({}, '2026-08-10'), null);
});

test('computeMovement classifies moved, sitting, closed, removed, and supplier handoffs', () => {
    const baselineItems = {
        '1': baselineItem({ name: 'status-change' }),
        '2': baselineItem({ name: 'qty-equivalent', qty: '1' }),
        '3': baselineItem({ name: 'closed-item' }),
        '4': baselineItem({ name: 'removed-item' }),
        '5': baselineItem({ name: 'handoff', status: 'FAB' }),
        '6': baselineItem({ name: 'cx-set', cxAlloyId: '' }),
        '7': baselineItem({ name: 'supplier-wait', status: 'Ordered from Supplier' }),
        '8': baselineItem({ name: 'mystery', status: 'Mystery Stage' })
    };
    const currentItemsById = new Map([
        ['1', baselineItem({ status: 'FAB', ageDays: 37 })],
        ['2', baselineItem({ qty: '1.0', ageDays: 50 })],
        ['5', baselineItem({ status: 'Ordered from Supplier' })],
        ['6', baselineItem({ cxAlloyId: ' CX-77 ' })],
        ['7', baselineItem({ status: 'Ordered from Supplier' })],
        ['8', baselineItem({ status: 'Mystery Stage' })]
    ]);
    const result = computeMovement({
        baselineItems,
        currentItemsById,
        closedItemIds: new Set(['3']),
        population: 'snap',
        ownerMap: OWNER_MAP,
        pastDueDays: 42
    });

    // 8 baseline items: 1 removed without trace, 7 carried.
    assert.equal(result.removedNoTrace, 1);
    assert.equal(result.totals.carried, 7);
    // Moved: status change (1), closed (3), handoff (5), cx set (6). Sitting: 2, 7, 8.
    assert.equal(result.totals.moved, 4);
    assert.equal(result.totals.sitting, 3);
    assert.equal(result.closedCount, 1);
    assert.equal(result.handoffsToSupplier, 1);

    // Attribution is frozen at baseline: Jack held items 1, 2, 3, 6 at baseline.
    assert.deepEqual(result.rows['Jack Richards'], { carried: 4, moved: 3, sitting: 1, past6w: 1, movedPct: 75 });
    // The handoff credits FAB's baseline owner.
    assert.equal(result.rows['Jessica Hernandez'].moved, 1);
    // Informational and unmapped rows keep the totals closing.
    assert.equal(result.rows[INFORMATIONAL_LABEL].sitting, 1);
    assert.equal(result.rows[UNMAPPED_LABEL].sitting, 1);
    const bucketSum = Object.values(result.rows).reduce((sum, row) => sum + row.carried, 0);
    assert.equal(bucketSum, result.totals.carried);
});

test('computeMovement returns null movedPct when nothing carried', () => {
    const result = computeMovement({
        baselineItems: {},
        currentItemsById: new Map(),
        closedItemIds: new Set(),
        population: 'snap',
        ownerMap: OWNER_MAP,
        pastDueDays: 42
    });
    assert.equal(result.totals.movedPct, null);
});

test('computeHoldingsProfile aggregates counts, units, and top statuses', () => {
    const items = [
        baselineItem({ population: 'fieldService', status: 'Pending Shipment Approval', priority: 'Critical', customer: 'Peterson', ageDays: 77 }),
        baselineItem({ population: 'fieldService', status: 'Pending Shipment Approval', priority: 'High', customer: 'Carter', ageDays: 10 }),
        baselineItem({ population: 'fieldService', status: 'Awaiting Full Order', priority: 'High', customer: 'Peterson', ageDays: 30 })
    ];
    const mapWithAwaiting = { ...OWNER_MAP, 'Awaiting Full Order': { snap: 'Clare Heckert', fieldService: 'Ambrea Ayala' } };
    const rows = computeHoldingsProfile(items, 'fieldService', mapWithAwaiting, 42);
    const ambrea = rows['Ambrea Ayala'];
    assert.equal(ambrea.items, 3);
    assert.equal(ambrea.critical, 1);
    assert.equal(ambrea.high, 2);
    assert.equal(ambrea.past6w, 1);
    assert.equal(ambrea.oldestAgeDays, 77);
    assert.equal(ambrea.units, 2);
    assert.match(ambrea.topStatuses, /Pending Shipment Approval 2/);
});

test('sortBucketLabels puts owners first, informational and unmapped last', () => {
    const rows = {
        [UNMAPPED_LABEL]: { carried: 9 },
        'Jack Richards': { carried: 3 },
        [INFORMATIONAL_LABEL]: { carried: 8 },
        'Jessica Sanchez': { carried: 5 }
    };
    assert.deepEqual(sortBucketLabels(rows, 'carried'),
        ['Jessica Sanchez', 'Jack Richards', INFORMATIONAL_LABEL, UNMAPPED_LABEL]);
});

test('computeOldestUntouched uses updatedAt against the reference date', () => {
    const refDate = new Date('2026-08-10T12:00:00.000Z');
    const oldest = computeOldestUntouched([
        baselineItem({ name: 'fresh', updatedAt: '2026-08-09T12:00:00.000Z' }),
        baselineItem({ name: 'stale', updatedAt: '2026-06-01T12:00:00.000Z' }),
        baselineItem({ name: 'no-date', updatedAt: null })
    ], refDate);
    assert.equal(oldest.name, 'stale');
    assert.equal(oldest.days, 70);
});

test('buildCallouts reports threshold swings and cleared queues only', () => {
    const current = {
        'Jessica Sanchez': { carried: 25, moved: 16, sitting: 9, past6w: 4, movedPct: 64 },
        'Jack Richards': { carried: 50, moved: 13, sitting: 37, past6w: 12, movedPct: 26 },
        'Jessica Hernandez': { carried: 21, moved: 21, sitting: 0, past6w: 0, movedPct: 100 },
        [INFORMATIONAL_LABEL]: { carried: 28, moved: 0, sitting: 28, past6w: 13, movedPct: 0 }
    };
    const previous = {
        'Jessica Sanchez': { carried: 20, moved: 1, sitting: 19, past6w: 2, movedPct: 5 },
        'Jack Richards': { carried: 44, moved: 10, sitting: 34, past6w: 9, movedPct: 24 }
    };
    const callouts = buildCallouts(current, previous, 20);
    assert.deepEqual(callouts, [
        'Jessica Sanchez: 5% → 64% moved week over week',
        'Jessica Hernandez cleared their queue (21 of 21 moved)'
    ]);
});

test('computeGateCounts and computeByUnit summarize field service items', () => {
    const items = [
        baselineItem({ status: 'Pending Shipment Approval', customer: 'Peterson' }),
        baselineItem({ status: 'Approved for Shipment', customer: 'Peterson' }),
        baselineItem({ status: 'FAB', customer: 'Carter' }),
        baselineItem({ status: 'pending shipment approval', customer: '' })
    ];
    const gates = computeGateCounts(items, ['Pending Shipment Approval', 'Approved for Shipment']);
    assert.equal(gates.total, 3);
    assert.equal(gates.byStatus['Pending Shipment Approval'], 2);
    assert.deepEqual(computeByUnit(items), { Peterson: 2, Carter: 1, 'Not set': 1 });
});

test('pruneWeeks keeps only the newest N week keys', () => {
    const weeks = { '2026-01-05': 1, '2026-01-12': 2, '2026-01-19': 3, '2026-01-26': 4 };
    pruneWeeks(weeks, 2);
    assert.deepEqual(Object.keys(weeks).sort(), ['2026-01-19', '2026-01-26']);
});

test('two-week simulation: movement plus callouts from stored owner stats', () => {
    // Week 1 snapshot: Jack holds 2 items, Jessica S holds 2, one supplier wait.
    const week1Items = {
        '10': baselineItem({ name: 'A', status: 'Purchasing' }),
        '11': baselineItem({ name: 'B', status: 'Purchasing' }),
        '12': baselineItem({ name: 'C', status: 'Approved for Shipment' }),
        '13': baselineItem({ name: 'D', status: 'Approved for Shipment' }),
        '14': baselineItem({ name: 'E', status: 'Ordered from Supplier' })
    };
    // Week 2 board: A changed status, B untouched, C shipped (closed), D untouched, E untouched.
    const week2Current = new Map([
        ['10', baselineItem({ name: 'A', status: 'FAB' })],
        ['11', baselineItem({ name: 'B', status: 'Purchasing' })],
        ['13', baselineItem({ name: 'D', status: 'Approved for Shipment' })],
        ['14', baselineItem({ name: 'E', status: 'Ordered from Supplier' })]
    ]);
    const movement = computeMovement({
        baselineItems: week1Items,
        currentItemsById: week2Current,
        closedItemIds: new Set(['12']),
        population: 'snap',
        ownerMap: OWNER_MAP,
        pastDueDays: 42
    });
    assert.equal(movement.totals.carried, 5);
    assert.deepEqual(movement.rows['Jack Richards'], { carried: 2, moved: 1, sitting: 1, past6w: 0, movedPct: 50 });
    assert.deepEqual(movement.rows['Jessica Sanchez'], { carried: 2, moved: 1, sitting: 1, past6w: 0, movedPct: 50 });
    assert.equal(movement.rows[INFORMATIONAL_LABEL].sitting, 1);
    assert.equal(movement.closedCount, 1);

    // Store this week's rows as ownerStats; a 30-point jump next week produces a callout.
    const storedOwnerStats = movement.rows;
    const nextWeekRows = {
        'Jack Richards': { carried: 2, moved: 2, sitting: 0, past6w: 0, movedPct: 100 },
        'Jessica Sanchez': { carried: 2, moved: 1, sitting: 1, past6w: 0, movedPct: 50 }
    };
    const callouts = buildCallouts(nextWeekRows, storedOwnerStats, 20);
    assert.deepEqual(callouts, ['Jack Richards: 50% → 100% moved week over week']);
});
