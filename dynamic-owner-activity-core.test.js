const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeBoardActivityLogs,
    computeDynamicOwnerActivity
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
