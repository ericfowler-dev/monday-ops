const test = require('node:test');
const assert = require('node:assert/strict');

const {
    excludeItemsByCurrentStatus,
    sanitizeHistory,
    sanitizeSnapshot,
    statusIsOneOf
} = require('./snap-orders-report-core');

const excludedStatuses = ['Cancelled'];

test('status matching ignores case and surrounding whitespace', () => {
    assert.equal(statusIsOneOf(' cancelled ', excludedStatuses), true);
    assert.equal(statusIsOneOf('Shipped', excludedStatuses), false);
});

test('cancelled items are removed instead of counted as open or shipped', () => {
    const items = [
        { id: '1', currentStatus: 'Parts Procurement' },
        { id: '2', currentStatus: 'Cancelled' },
        { id: '3', currentStatus: 'Shipped' }
    ];

    assert.deepEqual(
        excludeItemsByCurrentStatus(items, excludedStatuses).map(item => item.id),
        ['1', '3']
    );
});

test('cancelled counts are removed from a snapshot total and stage metrics', () => {
    const snapshot = {
        total: 9,
        byCurrentStatus: { Engineering: 4, Cancelled: 3, Purchasing: 2 }
    };

    sanitizeSnapshot(snapshot, excludedStatuses);

    assert.deepEqual(snapshot, {
        total: 6,
        byCurrentStatus: { Engineering: 4, Purchasing: 2 }
    });
});

test('history sanitization covers legacy and population snapshots and is idempotent', () => {
    const history = {
        '2026-08-30': {
            total: 5,
            byCurrentStatus: { Cancelled: 2, Engineering: 3 }
        },
        '2026-08-31': {
            factorySnap: {
                total: 4,
                byCurrentStatus: { Cancelled: 1, Purchasing: 3 }
            },
            fieldWarranty: {
                total: 2,
                byCurrentStatus: { Field: 2 }
            }
        }
    };

    sanitizeHistory(history, excludedStatuses);
    sanitizeHistory(history, excludedStatuses);

    assert.deepEqual(history, {
        '2026-08-30': {
            total: 3,
            byCurrentStatus: { Engineering: 3 }
        },
        '2026-08-31': {
            factorySnap: {
                total: 3,
                byCurrentStatus: { Purchasing: 3 }
            },
            fieldWarranty: {
                total: 2,
                byCurrentStatus: { Field: 2 }
            }
        }
    });
});
