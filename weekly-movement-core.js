// Pure week-over-week movement computations for the weekly movement report.
// No I/O and no ambient clock: callers pass snapshots, sets, and reference dates.

const INFORMATIONAL_LABEL = 'Ordered from Supplier';
const UNMAPPED_LABEL = 'Unmapped — check config';

function normalizeText(value) {
    return String(value ?? '').trim();
}

function normalizeQty(value) {
    const text = normalizeText(value);
    if (text === '') return '';
    const numeric = Number(text);
    return Number.isFinite(numeric) ? String(numeric) : text;
}

function ownerFor(status, population, ownerMap) {
    const normalized = normalizeText(status).toLowerCase();
    for (const [mapStatus, mapValue] of Object.entries(ownerMap)) {
        if (mapStatus.trim().toLowerCase() !== normalized) continue;
        if (mapValue === null) return { informational: true };
        if (typeof mapValue === 'string') return { owner: mapValue };
        const owner = mapValue[population];
        return owner ? { owner } : { unmapped: true };
    }
    return { unmapped: true };
}

function bucketLabelFor(status, population, ownerMap) {
    const resolved = ownerFor(status, population, ownerMap);
    if (resolved.owner) return resolved.owner;
    if (resolved.informational) return INFORMATIONAL_LABEL;
    return UNMAPPED_LABEL;
}

function snapshotItem(item, population) {
    return {
        name: item.name,
        population,
        status: normalizeText(item.currentStatus),
        qty: normalizeQty(item.quantity),
        orderDate: item.orderDate ? item.orderDate.toISOString().slice(0, 10) : null,
        cxAlloyId: normalizeText(item.cxAlloyId),
        priority: normalizeText(item.priority),
        customer: normalizeText(item.customer),
        createdAt: item.createdAt ? item.createdAt.toISOString() : null,
        updatedAt: item.updatedAt ? item.updatedAt.toISOString() : null,
        ageDays: Number.isFinite(item.ageDays) ? item.ageDays : null
    };
}

function findBaselineWeek(weeks, currentWeekKey) {
    const candidates = Object.keys(weeks || {}).filter(key => key < currentWeekKey).sort();
    if (!candidates.length) return null;
    const weekKey = candidates[candidates.length - 1];
    return { weekKey, week: weeks[weekKey] };
}

function movementFieldsChanged(baseline, current) {
    return baseline.status !== current.status
        || normalizeQty(baseline.qty) !== normalizeQty(current.qty)
        || (baseline.orderDate || null) !== (current.orderDate || null)
        || normalizeText(baseline.cxAlloyId) !== normalizeText(current.cxAlloyId);
}

// baselineItems: {id: snapshotItem} filtered to one population (population frozen at baseline).
// currentItemsById: Map of id -> snapshotItem for every OPEN item on the board now.
// closedItemIds: Set of ids with a recorded Shipped transition or a closed current status.
function computeMovement({ baselineItems, currentItemsById, closedItemIds, population, ownerMap, pastDueDays }) {
    const rows = {};
    const totals = { carried: 0, moved: 0, sitting: 0, past6w: 0 };
    let removedNoTrace = 0;
    let closedCount = 0;
    let handoffsToSupplier = 0;

    const rowFor = label => rows[label] || (rows[label] = { carried: 0, moved: 0, sitting: 0, past6w: 0 });

    for (const [id, baseline] of Object.entries(baselineItems)) {
        const closed = closedItemIds.has(String(id));
        const current = currentItemsById.get(String(id)) || null;
        if (!closed && !current) {
            removedNoTrace += 1;
            continue;
        }

        const moved = closed || movementFieldsChanged(baseline, current);
        const label = bucketLabelFor(baseline.status, population, ownerMap);
        const row = rowFor(label);
        row.carried += 1;
        totals.carried += 1;
        if (moved) {
            row.moved += 1;
            totals.moved += 1;
        } else {
            row.sitting += 1;
            totals.sitting += 1;
        }
        if (closed) closedCount += 1;
        if (current && !closed
            && baseline.status !== current.status
            && current.status.toLowerCase() === INFORMATIONAL_LABEL.toLowerCase()) {
            handoffsToSupplier += 1;
        }
        if (current && Number.isFinite(current.ageDays) && current.ageDays > pastDueDays) {
            row.past6w += 1;
            totals.past6w += 1;
        }
    }

    for (const row of Object.values(rows)) {
        row.movedPct = row.carried ? Math.round(row.moved / row.carried * 100) : null;
    }
    totals.movedPct = totals.carried ? Math.round(totals.moved / totals.carried * 100) : null;

    return { rows, totals, removedNoTrace, closedCount, handoffsToSupplier };
}

// Current-holdings profile by owner (used for Field Service Part 2 and first-run baselines).
// items: snapshotItem values for the OPEN items of one population.
function computeHoldingsProfile(items, population, ownerMap, pastDueDays) {
    const rows = {};
    const rowFor = label => rows[label] || (rows[label] = {
        items: 0, critical: 0, high: 0, past6w: 0, oldestAgeDays: null, customers: new Set(), statusCounts: {}
    });

    for (const item of items) {
        const row = rowFor(bucketLabelFor(item.status, population, ownerMap));
        row.items += 1;
        if (/critical/i.test(item.priority)) row.critical += 1;
        else if (/high/i.test(item.priority)) row.high += 1;
        if (Number.isFinite(item.ageDays)) {
            if (item.ageDays > pastDueDays) row.past6w += 1;
            if (row.oldestAgeDays === null || item.ageDays > row.oldestAgeDays) row.oldestAgeDays = item.ageDays;
        }
        if (item.customer) row.customers.add(item.customer);
        row.statusCounts[item.status] = (row.statusCounts[item.status] || 0) + 1;
    }

    for (const row of Object.values(rows)) {
        row.units = row.customers.size;
        delete row.customers;
        row.topStatuses = Object.entries(row.statusCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([status, count]) => `${status} ${count}`)
            .join(', ');
        delete row.statusCounts;
    }
    return rows;
}

// Sort bucket labels for display: owners by carried/items desc, then the
// informational row, then the unmapped row.
function sortBucketLabels(rows, countKey) {
    const owners = Object.keys(rows)
        .filter(label => label !== INFORMATIONAL_LABEL && label !== UNMAPPED_LABEL)
        .sort((a, b) => (rows[b][countKey] || 0) - (rows[a][countKey] || 0) || a.localeCompare(b));
    if (rows[INFORMATIONAL_LABEL]) owners.push(INFORMATIONAL_LABEL);
    if (rows[UNMAPPED_LABEL]) owners.push(UNMAPPED_LABEL);
    return owners;
}

function daysBetweenDates(start, end) {
    return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86400000));
}

// items: snapshotItem values for OPEN items. Uses Monday's board-level
// updated_at, so any edit/comment/automation resets the clock.
function computeOldestUntouched(items, refDate) {
    let oldest = null;
    for (const item of items) {
        if (!item.updatedAt) continue;
        const updated = new Date(item.updatedAt);
        if (Number.isNaN(updated.getTime())) continue;
        const days = daysBetweenDates(updated, refDate);
        if (!oldest || days > oldest.days) oldest = { days, name: item.name };
    }
    return oldest;
}

// currentRows/previousRows: computeMovement().rows for the same population a week apart.
function buildCallouts(currentRows, previousRows, thresholdPoints) {
    const callouts = [];
    for (const [owner, row] of Object.entries(currentRows || {})) {
        if (owner === INFORMATIONAL_LABEL || owner === UNMAPPED_LABEL) continue;
        if (row.movedPct === null) continue;
        const previous = previousRows?.[owner];
        if (previous && previous.movedPct !== null && Math.abs(row.movedPct - previous.movedPct) >= thresholdPoints) {
            callouts.push(`${owner}: ${previous.movedPct}% → ${row.movedPct}% moved week over week`);
        } else if (row.movedPct === 100 && row.carried > 0) {
            callouts.push(`${owner} cleared their queue (${row.moved} of ${row.carried} moved)`);
        }
    }
    return callouts;
}

function computeGateCounts(items, gateStatuses) {
    const byStatus = {};
    let total = 0;
    for (const gateStatus of gateStatuses) {
        const count = items.filter(item => item.status.toLowerCase() === gateStatus.toLowerCase()).length;
        byStatus[gateStatus] = count;
        total += count;
    }
    return { total, byStatus };
}

function computeByUnit(items) {
    const counts = {};
    for (const item of items) {
        const unit = item.customer || 'Not set';
        counts[unit] = (counts[unit] || 0) + 1;
    }
    return counts;
}

function pruneWeeks(weeks, retentionWeeks) {
    const keys = Object.keys(weeks).sort((a, b) => b.localeCompare(a));
    for (const key of keys.slice(retentionWeeks)) {
        delete weeks[key];
    }
}

module.exports = {
    INFORMATIONAL_LABEL,
    UNMAPPED_LABEL,
    normalizeText,
    normalizeQty,
    ownerFor,
    bucketLabelFor,
    snapshotItem,
    findBaselineWeek,
    movementFieldsChanged,
    computeMovement,
    computeHoldingsProfile,
    sortBucketLabels,
    computeOldestUntouched,
    buildCallouts,
    computeGateCounts,
    computeByUnit,
    pruneWeeks
};
