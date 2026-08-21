// Reconstruct earlier weekly trend snapshots from monday activity logs.
//
// Snapshot storage only began 2026-08-11, so the Weekly actioned trend has just
// one genuine Monday to chart. Activity logs reach further back, and the
// per-owner "actioned" figure is derived purely from those events, so earlier
// weeks can be rebuilt faithfully.
//
// What is NOT reconstructible is board state as it stood back then (open
// counts, waiting times, priority) — those read the board as it is now.
// Backfilled records therefore carry activity metrics only and are tagged
// { backfilled: true, partial: true } so nothing mistakes them for full
// snapshots.
//
// Dry run (default):  node backfill-dynamic-history.js
// Apply:              node backfill-dynamic-history.js --apply
// Options:            --weeks N   how many earlier weeks to rebuild (default 6)
//                     --force     overwrite existing keys (default: skip them)
//                     --include-anchor  also recompute the anchor week itself,
//                                 needed after an OWNER_MAP change so every
//                                 charted week uses the same attribution rules

require('dotenv').config();

const config = require('./weekly-movement-report.config');
const { normalizeBoardActivityLogs, computeDynamicOwnerActivity, filterActorRows } = require('./dynamic-owner-activity-core');
const { createHistoryStore } = require('./dynamic-owner-history-store');

const MONDAY_API_VERSION = process.env.MONDAY_API_VERSION || '2026-07';
const ACTIVITY_LIMIT = 10000;
const WINDOW_MS = 7 * 86400000;

const QUALIFYING_COLUMNS = [
    { id: config.COL_IDS.CURRENT_STATUS, title: 'Current Dept / Status', kind: 'status', category: 'workflow' },
    { id: config.COL_IDS.CX_ALLOY_ID, title: 'CX Alloy ID', kind: 'operational', category: 'order setup' },
    { id: config.COL_IDS.QUANTITY, title: 'Quantity', kind: 'operational', category: 'order setup' },
    { id: config.COL_IDS.ORDER_DATE, title: 'Order Date', kind: 'operational', category: 'order setup' },
    { id: config.COL_IDS.TRACKING_NUMBER, title: 'Tracking / DDL #', kind: 'operational', category: 'shipping' },
    { id: config.COL_IDS.DATE_SHIPPED, title: 'Date Shipped', kind: 'operational', category: 'shipping' },
    { id: 'dropdown_mm5fpq2x', title: 'Shipping Method', kind: 'operational', category: 'shipping' },
    { id: config.COL_IDS.PURCHASE_ORDER, title: 'Purchase Order', kind: 'operational', category: 'supplier' },
    { id: 'timerange_mm3j2txm', title: 'Supplier Lead Time', kind: 'operational', category: 'supplier' },
    { id: config.COL_IDS.SUPPLIER_ORDER_DATE, title: 'Date Ordered from Supplier / Customer', kind: 'operational', category: 'supplier' },
    { id: config.COL_IDS.SUPPLIER_TRACKING, title: 'Tracking from Supplier', kind: 'operational', category: 'supplier' },
    { id: 'date_mm5f3mkf', title: 'Expected Delivery Date', kind: 'operational', category: 'supplier' },
    { id: 'color_mm468nm2', title: 'Update Status', kind: 'operational', category: 'workflow' },
    { id: 'color_mm4dsaa', title: 'Demand Status', kind: 'operational', category: 'workflow' },
    { id: 'color_mm5qbfdv', title: 'Shipping Approval Status', kind: 'operational', category: 'shipping' },
    { id: 'multiple_person_mm5qr9wb', title: 'Shipping Approved By', kind: 'operational', category: 'shipping' }
].filter(column => column.id);

const ITEM_COLUMN_IDS = [
    config.COL_IDS.ORDER_TYPE,
    config.COL_IDS.CURRENT_STATUS,
    config.COL_IDS.ORDER_DATE,
    config.COL_IDS.PRIORITY,
    config.COL_IDS.DATE_SHIPPED
];

async function mondayQuery(query, variables = {}) {
    if (!process.env.MONDAY_API_TOKEN) throw new Error('MONDAY_API_TOKEN is required.');
    const response = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: {
            Authorization: process.env.MONDAY_API_TOKEN,
            'Content-Type': 'application/json',
            'API-Version': MONDAY_API_VERSION
        },
        body: JSON.stringify({ query, variables })
    });
    const payload = await response.json();
    if (!response.ok || payload.errors) throw new Error(`Monday API request failed: ${JSON.stringify(payload.errors || payload)}`);
    return payload.data;
}

async function fetchCurrentRelevantItems() {
    const result = [];
    const relevantGroups = new Set([config.SNAP_GROUP_ID, config.FIELD_SERVICE_GROUP_ID]);
    let cursor = null;
    do {
        const data = await mondayQuery(`query ($boardIds: [ID!], $cursor: String, $columnIds: [String!]) {
            boards(ids: $boardIds) {
                items_page(limit: 500, cursor: $cursor) {
                    cursor
                    items { id name state created_at group { id title } column_values(ids: $columnIds) { id text } }
                }
            }
        }`, { boardIds: [config.BOARD_ID], cursor, columnIds: ITEM_COLUMN_IDS });
        const page = data.boards[0]?.items_page;
        for (const item of page?.items || []) if (relevantGroups.has(item.group?.id)) result.push(item);
        cursor = page?.cursor || null;
    } while (cursor);
    return result;
}

async function fetchItemsById(ids) {
    const result = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
        const data = await mondayQuery(`query ($itemIds: [ID!], $columnIds: [String!]) {
            items(ids: $itemIds, limit: 100) {
                id name state created_at group { id title } column_values(ids: $columnIds) { id text }
            }
        }`, { itemIds: ids.slice(offset, offset + 100), columnIds: ITEM_COLUMN_IDS });
        result.push(...(data.items || []));
    }
    return result;
}

// Activity logs cap at 10k rows per call, so walk the span one week at a time.
async function fetchActivityRange(fromDate, toDate) {
    const logs = [];
    let chunkStart = new Date(fromDate);
    while (chunkStart < toDate) {
        const chunkEnd = new Date(Math.min(chunkStart.getTime() + WINDOW_MS, toDate.getTime()));
        const data = await mondayQuery(`query ($boardIds: [ID!], $from: ISO8601DateTime!, $to: ISO8601DateTime!) {
            boards(ids: $boardIds) {
                activity_logs(from: $from, to: $to, limit: ${ACTIVITY_LIMIT}) { id event data created_at user_id }
            }
        }`, { boardIds: [config.BOARD_ID], from: chunkStart.toISOString(), to: chunkEnd.toISOString() });
        const chunk = data.boards[0]?.activity_logs || [];
        if (chunk.length >= ACTIVITY_LIMIT) {
            console.warn(`  WARNING: ${chunkStart.toISOString().slice(0, 10)} chunk hit the ${ACTIVITY_LIMIT}-record API cap; that week may be incomplete.`);
        }
        console.log(`  fetched ${String(chunk.length).padStart(5)} records for ${chunkStart.toISOString().slice(0, 10)} -> ${chunkEnd.toISOString().slice(0, 10)}`);
        logs.push(...chunk);
        chunkStart = chunkEnd;
    }
    return logs;
}

async function fetchUserNames(ids) {
    const names = new Map();
    for (let offset = 0; offset < ids.length; offset += 100) {
        const data = await mondayQuery('query ($ids: [ID!]) { users(ids: $ids) { id name } }', { ids: ids.slice(offset, offset + 100) });
        for (const user of data.users || []) names.set(String(user.id), user.name);
    }
    return names;
}

function parseMondayDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], 12)) : null;
}
function parseDate(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
}
function formatDateKey(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: config.TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function baseItem(raw) {
    const columns = Object.fromEntries((raw.column_values || []).map(column => [column.id, column.text || '']));
    const orderType = columns[config.COL_IDS.ORDER_TYPE] || '';
    return {
        id: String(raw.id),
        name: raw.name,
        groupId: raw.group?.id || '',
        status: columns[config.COL_IDS.CURRENT_STATUS] || 'Unassigned',
        isSnapOrder: orderType.split(',').some(value => value.trim().toLowerCase() === 'snap'),
        orderType,
        createdAt: parseDate(raw.created_at),
        orderDate: parseMondayDate(columns[config.COL_IDS.ORDER_DATE]),
        url: `https://${config.MONDAY_SLUG}.monday.com/boards/${config.BOARD_ID}/pulses/${raw.id}`
    };
}

const isClosedStatus = status =>
    config.CLOSED_CURRENT_STATUSES.some(value => value.toLowerCase() === String(status || '').trim().toLowerCase());

// Roll status/group backwards through events newer than the target instant, so
// each historical window starts from the board as it actually stood then.
function rewind(state, events, afterInstant, untilInstant) {
    const relevant = events
        .filter(event => event.at > afterInstant && event.at <= untilInstant)
        .sort((a, b) => b.at - a.at);
    for (const event of relevant) {
        const entry = state.get(event.itemId);
        if (!entry) continue;
        if (event.type === 'status') entry.status = event.previousStatus;
        else if (event.type === 'group_move') entry.groupId = event.sourceGroupId;
    }
}

function trendRows(populationResult) {
    return Object.fromEntries(Object.entries(populationResult.rows).map(([owner, row]) => [owner, {
        actioned: row.actioned,
        received: row.received,
        handedOff: row.handedOff
    }]));
}

// The trend charts the person who made each change, so rebuilt weeks must carry
// actor rows with names resolved, exactly as a live snapshot would.
function actorRowsFor(populationResult, userNames) {
    return filterActorRows(populationResult.actorRows, config.EXCLUDED_ACTOR_IDS).map(row => ({
        userId: row.userId,
        name: userNames.get(row.userId) || `User ${row.userId}`,
        actioned: row.actioned,
        handedOff: row.handedOff,
        events: row.events
    }));
}

(async () => {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const force = args.includes('--force');
    const includeAnchor = args.includes('--include-anchor');
    const weeksArg = args.indexOf('--weeks');
    const weeks = weeksArg !== -1 ? Number(args[weeksArg + 1]) : 6;
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 25) throw new Error('--weeks must be an integer between 1 and 25.');

    let store;
    try {
        store = await createHistoryStore();
        const history = await store.readHistory();
        history.weeks = history.weeks || {};
        const existing = Object.keys(history.weeks).sort();
        if (!existing.length) throw new Error('No stored snapshot to anchor on. Let one scheduled run store a snapshot first.');

        // Anchor on the newest real snapshot so rebuilt windows line up exactly
        // with the cadence already in storage.
        const anchorKey = existing[existing.length - 1];
        const anchorAt = parseDate(history.weeks[anchorKey].generatedAt);
        if (!anchorAt) throw new Error(`Snapshot ${anchorKey} has no usable generatedAt to anchor on.`);
        console.log(`Store: ${store.kind} - existing keys: ${existing.join(', ')}`);
        console.log(`Anchor: ${anchorKey} (generated ${anchorAt.toISOString()})\n`);

        const targets = [];
        for (let i = includeAnchor ? 0 : 1; i <= weeks; i++) {
            const refDate = new Date(anchorAt.getTime() - i * WINDOW_MS);
            targets.push({ refDate, fromDate: new Date(refDate.getTime() - WINDOW_MS), key: formatDateKey(refDate) });
        }
        targets.reverse();

        console.log('Rebuilding these weeks:');
        for (const target of targets) {
            const clash = history.weeks[target.key] ? (force ? ' (EXISTS - will overwrite)' : ' (EXISTS - will skip)') : '';
            console.log(`  ${target.key}  window ${target.fromDate.toISOString().slice(0, 10)} -> ${target.refDate.toISOString().slice(0, 10)}${clash}`);
        }

        const oldest = targets[0].fromDate;
        const now = new Date();
        console.log(`\nFetching board items and activity from ${oldest.toISOString().slice(0, 10)} to now...`);
        const [currentRaw, rawLogs] = await Promise.all([fetchCurrentRelevantItems(), fetchActivityRange(oldest, now)]);
        const allEvents = normalizeBoardActivityLogs(rawLogs, QUALIFYING_COLUMNS);

        // Items that have since left the report groups still matter historically.
        const relevantGroups = new Set([config.SNAP_GROUP_ID, config.FIELD_SERVICE_GROUP_ID]);
        const knownIds = new Set(currentRaw.map(item => String(item.id)));
        const missingIds = [...new Set(allEvents
            .filter(event => relevantGroups.has(event.groupId) || relevantGroups.has(event.sourceGroupId) || relevantGroups.has(event.destinationGroupId))
            .map(event => event.itemId)
            .filter(id => !knownIds.has(id)))];
        const recoveredRaw = missingIds.length ? await fetchItemsById(missingIds) : [];
        const items = [...currentRaw, ...recoveredRaw].map(baseItem);
        const actorIds = [...new Set(allEvents.map(e => e.actorUserId).filter(id => id && id !== 'unknown'))];
        const userNames = await fetchUserNames(actorIds);
        console.log(`Loaded ${items.length} items (${recoveredRaw.length} recovered) and ${allEvents.length} qualifying events.\n`);

        // Walk backwards from now, rewinding state one week at a time.
        const state = new Map(items.map(item => [item.id, { status: item.status, groupId: item.groupId }]));
        const itemById = new Map(items.map(item => [item.id, item]));
        let boundary = now;
        const rebuilt = [];
        for (const target of [...targets].reverse()) {
            rewind(state, allEvents, target.refDate, boundary);
            boundary = target.refDate;

            const asOfItems = [];
            for (const [id, entry] of state) {
                const item = itemById.get(id);
                if (!item) continue;
                if (item.createdAt && item.createdAt > target.refDate) continue; // did not exist yet
                asOfItems.push({
                    ...item,
                    status: entry.status,
                    groupId: entry.groupId,
                    population: entry.groupId === config.FIELD_SERVICE_GROUP_ID ? 'fieldService'
                        : entry.groupId === config.SNAP_GROUP_ID && item.isSnapOrder ? 'snap' : null,
                    isOpen: !isClosedStatus(entry.status),
                    ageDays: item.orderDate || item.createdAt
                        ? Math.max(0, Math.floor((target.refDate - (item.orderDate || item.createdAt)) / 86400000))
                        : null
                });
            }

            const windowEvents = allEvents.filter(event => event.at >= target.fromDate && event.at <= target.refDate);
            const result = computeDynamicOwnerActivity({
                items: asOfItems,
                events: windowEvents,
                fromDate: target.fromDate,
                refDate: target.refDate,
                ownerMap: config.OWNER_MAP,
                snapGroupId: config.SNAP_GROUP_ID,
                fieldServiceGroupId: config.FIELD_SERVICE_GROUP_ID,
                closedStatuses: config.CLOSED_CURRENT_STATUSES,
                waitingHours: 24,
                pastDueDays: config.PAST_DUE_DAYS
            });
            rebuilt.push({ target, result, eventCount: windowEvents.length });
        }
        rebuilt.reverse();

        console.log('Reconstructed per-week actioned totals (owner-item pairs):');
        for (const { target, result, eventCount } of rebuilt) {
            const snap = result.populations.snap.totals.actioned;
            const field = result.populations.fieldService.totals.actioned;
            const top = [...new Set([...result.populations.snap.topActionedOwners, ...result.populations.fieldService.topActionedOwners])];
            const gap = snap + field === 0
                ? (eventCount === 0
                    ? '  NO DATA - beyond activity-log retention, not stored'
                    : '  NO ATTRIBUTABLE ACTIVITY - items not yet in the report groups, not stored')
                : '';
            console.log(`  ${target.key}  SNAP ${String(snap).padStart(4)}  Field ${String(field).padStart(4)}  events ${String(eventCount).padStart(5)}  top: ${top.join(', ') || '-'}${gap}`);
        }

        // A reconstructed week with zero attributable activity means the history
        // does not really reach that far — either the activity log is exhausted
        // or the items were not yet in the report groups. Charting it as zeros
        // would read as "nobody worked" rather than "we cannot see", so those
        // weeks are left unstored.
        const withData = rebuilt.filter(entry =>
            entry.result.populations.snap.totals.actioned + entry.result.populations.fieldService.totals.actioned > 0);
        const noData = rebuilt.length - withData.length;
        if (noData) console.log(`\n${noData} week(s) reconstructed empty and will be left unstored (see flags above).`);

        const writes = withData.filter(({ target }) => force || !history.weeks[target.key]);
        const skipped = withData.length - writes.length;
        if (!apply) {
            console.log(`\nDry run - nothing written. ${writes.length} week(s) would be stored${skipped ? `, ${skipped} skipped as already present` : ''}.`);
            console.log('Re-run with --apply to store them.');
            return;
        }
        for (const { target, result } of writes) {
            history.weeks[target.key] = {
                version: 2,
                backfilled: true,
                partial: true,
                note: 'Rebuilt from monday activity logs. Activity metrics only; no board-state fields.',
                generatedAt: target.refDate.toISOString(),
                windowFrom: target.fromDate.toISOString(),
                populations: {
                    snap: {
                        rows: trendRows(result.populations.snap),
                        actorRows: actorRowsFor(result.populations.snap, userNames)
                    },
                    fieldService: {
                        rows: trendRows(result.populations.fieldService),
                        actorRows: actorRowsFor(result.populations.fieldService, userNames)
                    }
                }
            };
        }
        await store.writeHistory(history);
        console.log(`\nApplied. Stored ${writes.length} backfilled week(s)${skipped ? `, skipped ${skipped}` : ''}.`);
        console.log(`History now holds: ${Object.keys(history.weeks).sort().join(', ')}`);
    } catch (error) {
        console.error(`Backfill failed: ${error.message}`);
        process.exitCode = 1;
    } finally {
        if (store) await store.close().catch(() => {});
    }
})();
