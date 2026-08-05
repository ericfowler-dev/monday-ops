require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');
const config = require('./weekly-movement-report.config');
const core = require('./weekly-movement-core');

const HISTORY_FILE = path.join(__dirname, 'history-weekly-movement.json');
const LAST_RUN_FILE = path.join(__dirname, 'last-run-weekly-movement.txt');
const REDIS_HISTORY_KEY = process.env.MOVEMENT_REDIS_HISTORY_KEY || 'movement:history';
const REDIS_LAST_RUN_KEY = process.env.MOVEMENT_REDIS_LAST_RUN_KEY || 'movement:last-run';
const MONDAY_API_VERSION = process.env.MONDAY_API_VERSION || '2026-07';
const EMAIL_FONT_FAMILY = "'Segoe UI',Arial,sans-serif";

async function generateReport() {
    const args = new Set(process.argv.slice(2));
    const force = args.has('--force') || args.has('-f') || process.env.FORCE_RUN === '1';
    const dryRun = args.has('--dry-run') || process.env.DRY_RUN === '1';
    const seed = args.has('--seed');
    const now = new Date();
    const central = getZonedDateParts(now, config.TIME_ZONE);
    let runtimeStore;

    try {
        if (!force && central.weekday !== config.SCHEDULE_WEEKDAY) {
            console.log(`Not the scheduled weekday (Monday, ${config.TIME_ZONE}); current local weekday index is ${central.weekday}.`);
            return;
        }
        if (!force && central.hour !== config.SCHEDULE_HOUR) {
            console.log(`Not scheduled time (${config.SCHEDULE_HOUR}:00 ${config.TIME_ZONE}); current local hour is ${central.hour}.`);
            return;
        }

        runtimeStore = await createRuntimeStore();
        const lastRun = await runtimeStore.readLastRun();
        if (!force && lastRun === central.dateKey) {
            console.log(`Weekly movement report already sent for ${central.dateKey}.`);
            return;
        }

        console.log(`Gathering weekly movement data from ${config.BOARD_NAME}...`);
        const [board, history] = await Promise.all([
            fetchBoard(),
            readMovementHistory(runtimeStore)
        ]);
        const [populations, activityClosedItems] = await Promise.all([
            fetchOpenItems(board),
            fetchRecentShippedItems(board, central.dateKey, config.CLOSED_LOOKBACK_DAYS)
        ]);

        const closedItems = mergeClosedItems(populations.currentShipped, activityClosedItems);
        const recentClosed = filterCompletedWithinLookback(closedItems, central.dateKey, config.CLOSED_LOOKBACK_DAYS);
        const closedItemIds = new Set([
            ...populations.currentShipped.map(item => String(item.id)),
            ...activityClosedItems.map(item => String(item.id))
        ]);

        const snapItems = populations.snap.map(item => core.snapshotItem(item, 'snap'));
        const fieldItems = populations.fieldService.map(item => core.snapshotItem(item, 'fieldService'));
        const itemRecords = {};
        const currentItemsById = new Map();
        for (const [list, source] of [[snapItems, populations.snap], [fieldItems, populations.fieldService]]) {
            list.forEach((snapshot, index) => {
                const id = String(source[index].id);
                itemRecords[id] = snapshot;
                currentItemsById.set(id, snapshot);
            });
        }

        const baseline = core.findBaselineWeek(history.weeks, central.dateKey);
        const movement = baseline ? computeMovementForPopulations(baseline.week, currentItemsById, closedItemIds) : null;
        const snapProfile = core.computeHoldingsProfile(snapItems, 'snap', config.OWNER_MAP, config.PAST_DUE_DAYS);
        const fieldProfile = core.computeHoldingsProfile(fieldItems, 'fieldService', config.OWNER_MAP, config.PAST_DUE_DAYS);
        const gate = core.computeGateCounts(fieldItems, config.SHIPPING_GATE_STATUSES);
        const byUnit = core.computeByUnit(fieldItems);
        const oldestUntouched = {
            snap: core.computeOldestUntouched(snapItems, now),
            fieldService: core.computeOldestUntouched(fieldItems, now)
        };
        const callouts = movement ? {
            snap: core.buildCallouts(movement.snap.rows, baseline.week.ownerStats?.snap, config.CALLOUT_THRESHOLD_POINTS),
            fieldService: core.buildCallouts(movement.fieldService.rows, baseline.week.ownerStats?.fieldService, config.CALLOUT_THRESHOLD_POINTS)
        } : null;

        const weekRecord = {
            generatedAt: now.toISOString(),
            items: itemRecords,
            ownerStats: movement
                ? { snap: movement.snap.rows, fieldService: movement.fieldService.rows }
                : null,
            summary: {
                snapOpen: snapItems.length,
                fieldOpen: fieldItems.length,
                snapPast6w: countPastDue(snapItems),
                fieldPast6w: countPastDue(fieldItems),
                closedThisWeek: recentClosed.length,
                removedNoTrace: movement ? movement.snap.removedNoTrace + movement.fieldService.removedNoTrace : 0
            }
        };

        logRunSummary(weekRecord, movement, baseline);
        history.weeks[central.dateKey] = weekRecord;
        core.pruneWeeks(history.weeks, config.HISTORY_RETENTION_WEEKS);
        if (!dryRun) {
            await runtimeStore.writeHistory(history);
        }

        const html = generateHtml({
            dateKey: central.dateKey,
            baseline,
            movement,
            callouts,
            snapItems,
            fieldItems,
            snapProfile,
            fieldProfile,
            gate,
            byUnit,
            oldestUntouched,
            summary: weekRecord.summary,
            recentClosed
        });
        const outputPath = saveHtml(html, central.dateKey);
        console.log(`HTML preview saved: ${outputPath}`);

        if (dryRun) {
            console.log('Dry run enabled; history was not written and email was not sent.');
            return;
        }
        if (seed) {
            console.log(`Baseline snapshot stored for ${central.dateKey}; email skipped (--seed).`);
            return;
        }

        await sendEmail(html, central.dateKey);
        await runtimeStore.writeLastRun(central.dateKey);
    } finally {
        if (runtimeStore) {
            await runtimeStore.close();
        }
    }
}

function computeMovementForPopulations(baselineWeek, currentItemsById, closedItemIds) {
    const result = {};
    for (const population of ['snap', 'fieldService']) {
        const baselineItems = Object.fromEntries(Object.entries(baselineWeek.items || {})
            .filter(([, item]) => item.population === population));
        result[population] = core.computeMovement({
            baselineItems,
            currentItemsById,
            closedItemIds,
            population,
            ownerMap: config.OWNER_MAP,
            pastDueDays: config.PAST_DUE_DAYS
        });
    }
    return result;
}

function countPastDue(items) {
    return items.filter(item => Number.isFinite(item.ageDays) && item.ageDays > config.PAST_DUE_DAYS).length;
}

function logRunSummary(weekRecord, movement, baseline) {
    const { summary } = weekRecord;
    console.log(`Open items: SNAP=${summary.snapOpen}, Field Service=${summary.fieldOpen}; closed in ${config.CLOSED_LOOKBACK_DAYS} days: ${summary.closedThisWeek}.`);
    if (!movement) {
        console.log('No baseline week found; this run establishes the baseline.');
        return;
    }
    console.log(`Baseline ${baseline.weekKey}: SNAP ${movement.snap.totals.moved}/${movement.snap.totals.carried} moved (${movement.snap.totals.movedPct ?? '—'}%), Field ${movement.fieldService.totals.moved}/${movement.fieldService.totals.carried} moved (${movement.fieldService.totals.movedPct ?? '—'}%).`);
}

async function mondayQuery(query, variables = {}) {
    if (!process.env.MONDAY_API_TOKEN) {
        throw new Error('MONDAY_API_TOKEN is required.');
    }

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
    if (!response.ok || payload.errors) {
        throw new Error(`Monday API request failed: ${JSON.stringify(payload.errors || payload)}`);
    }
    return payload.data;
}

async function fetchBoard() {
    const data = await mondayQuery(`query ($boardIds: [ID!]) {
        boards(ids: $boardIds) { id name state views { id name } }
    }`, { boardIds: [config.BOARD_ID] });
    const board = data.boards[0];
    if (!board || board.state !== 'active') {
        throw new Error(`Active board ${config.BOARD_ID} was not found.`);
    }
    // View links are convenience buttons; a recreated view should not kill the report.
    for (const viewId of [config.VIEW_ID, config.FIELD_SERVICE_VIEW_ID]) {
        if (!board.views.some(view => view.id === viewId)) {
            console.warn(`Warning: Monday view ${viewId} was not found on board ${config.BOARD_ID}; the email button may 404.`);
        }
    }
    return board;
}

async function fetchOpenItems(board) {
    const populations = { snap: [], fieldService: [], currentShipped: [] };
    const relevantGroups = new Set([config.SNAP_GROUP_ID, config.FIELD_SERVICE_GROUP_ID]);
    const columnIds = Object.values(config.COL_IDS);
    let cursor = null;

    do {
        const data = await mondayQuery(`query ($boardIds: [ID!], $cursor: String, $columnIds: [String!]) {
            boards(ids: $boardIds) {
                items_page(limit: 500, cursor: $cursor) {
                    cursor
                    items {
                        id name state created_at updated_at
                        group { id title }
                        column_values(ids: $columnIds) { id text value }
                    }
                }
            }
        }`, { boardIds: [board.id], cursor, columnIds });

        const page = data.boards[0]?.items_page;
        for (const rawItem of page?.items || []) {
            if (rawItem.state !== 'active' || !relevantGroups.has(rawItem.group?.id)) {
                continue;
            }
            const item = mapOrderItem(rawItem, board.id);
            if (config.CLOSED_CURRENT_STATUSES.some(status => status.toLowerCase() === item.currentStatus.toLowerCase())) {
                populations.currentShipped.push(item);
                continue;
            }
            if (isFactorySnap(item)) {
                populations.snap.push(item);
            } else if (item.groupId === config.FIELD_SERVICE_GROUP_ID) {
                populations.fieldService.push(item);
            }
        }
        cursor = page?.cursor || null;
    } while (cursor);

    return populations;
}

async function fetchRecentShippedItems(board, currentDateKey, lookbackDays) {
    const cutoff = dateKeyToUtc(currentDateKey);
    cutoff.setUTCHours(0, 0, 0, 0);
    cutoff.setUTCDate(cutoff.getUTCDate() - (lookbackDays - 1));
    const end = dateKeyToUtc(currentDateKey);
    end.setUTCHours(0, 0, 0, 0);
    end.setUTCDate(end.getUTCDate() + 1);
    const from = cutoff.toISOString();
    const to = end.toISOString();
    const activityData = await mondayQuery(`query {
        boards(ids: ${board.id}) {
            activity_logs(
                from: ${JSON.stringify(from)}
                to: ${JSON.stringify(to)}
                limit: 10000
                column_ids: [${JSON.stringify(config.COL_IDS.CURRENT_STATUS)}]
            ) { event data created_at }
        }
    }`);
    const relevantGroups = new Set([config.SNAP_GROUP_ID, config.FIELD_SERVICE_GROUP_ID]);
    const shippedEvents = new Map();

    for (const log of activityData.boards[0]?.activity_logs || []) {
        let activity;
        try { activity = JSON.parse(log.data); } catch { continue; }
        if (!relevantGroups.has(activity.group_id)) continue;
        const isShippedStatus = activity.column_id === config.COL_IDS.CURRENT_STATUS
            && config.CLOSED_CURRENT_STATUSES.some(status => status.toLowerCase() === String(activity.value?.label?.text || '').toLowerCase());
        if (isShippedStatus) {
            const completedAt = parseActivityTimestamp(log.created_at);
            if (activity.pulse_id) recordLatestEvent(shippedEvents, String(activity.pulse_id), completedAt);
            for (const id of activity.pulse_ids || []) recordLatestEvent(shippedEvents, String(id), completedAt);
        }
    }

    if (!shippedEvents.size) return [];
    const items = [];
    const ids = [...shippedEvents.keys()];
    for (let offset = 0; offset < ids.length; offset += 100) {
        const data = await mondayQuery(`query ($itemIds: [ID!], $columnIds: [String!]) {
            items(ids: $itemIds, limit: 100) {
                id name state created_at updated_at
                board { id }
                group { id title }
                column_values(ids: $columnIds) { id text value }
            }
        }`, { itemIds: ids.slice(offset, offset + 100), columnIds: Object.values(config.COL_IDS) });
        items.push(...(data.items || []));
    }

    return items.map(rawItem => ({
        ...mapOrderItem(rawItem, board.id),
        completedAt: shippedEvents.get(String(rawItem.id))
    }))
        .filter(item => relevantGroups.has(item.groupId) && item.completedAt)
        .sort((a, b) => b.completedAt - a.completedAt || a.name.localeCompare(b.name));
}

function recordLatestEvent(events, itemId, eventDate) {
    if (!eventDate) return;
    const existing = events.get(itemId);
    if (!existing || eventDate > existing) events.set(itemId, eventDate);
}

function parseActivityTimestamp(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp)) return null;
    const date = new Date(Math.round(timestamp / 10000));
    return Number.isNaN(date.getTime()) ? null : date;
}

function filterCompletedWithinLookback(items, currentDateKey, lookbackDays) {
    const cutoff = dateKeyToUtc(currentDateKey);
    cutoff.setUTCHours(0, 0, 0, 0);
    cutoff.setUTCDate(cutoff.getUTCDate() - (lookbackDays - 1));
    const end = dateKeyToUtc(currentDateKey);
    end.setUTCHours(0, 0, 0, 0);
    end.setUTCDate(end.getUTCDate() + 1);
    return items.filter(item => item.completedAt >= cutoff && item.completedAt < end);
}

function mergeClosedItems(currentShipped, activityClosedItems) {
    const itemsById = new Map(activityClosedItems.map(item => [String(item.id), item]));
    for (const item of currentShipped) {
        const activityItem = itemsById.get(String(item.id));
        itemsById.set(String(item.id), {
            ...activityItem,
            ...item,
            completedAt: item.dateShipped || activityItem?.completedAt || null
        });
    }
    return [...itemsById.values()]
        .filter(item => item.completedAt)
        .sort((a, b) => b.completedAt - a.completedAt || a.name.localeCompare(b.name));
}

function mapOrderItem(rawItem, boardId) {
    const columns = Object.fromEntries(rawItem.column_values.map(value => [value.id, value.text || '']));
    const orderDate = parseMondayDate(columns[config.COL_IDS.ORDER_DATE]);
    const createdAt = parseDate(rawItem.created_at);
    const ageStart = orderDate || createdAt;
    return {
        id: rawItem.id,
        name: rawItem.name,
        groupId: rawItem.group?.id || '',
        groupName: rawItem.group?.title || '',
        state: rawItem.state,
        url: `https://${config.MONDAY_SLUG}.monday.com/boards/${boardId}/pulses/${rawItem.id}`,
        orderType: columns[config.COL_IDS.ORDER_TYPE] || '',
        currentStatus: columns[config.COL_IDS.CURRENT_STATUS] || 'Unassigned',
        priority: columns[config.COL_IDS.PRIORITY] || '',
        customer: columns[config.COL_IDS.CUSTOMER] || '',
        orderDate,
        createdAt,
        updatedAt: parseDate(rawItem.updated_at),
        ageDays: ageStart ? daysBetween(ageStart, new Date()) : null,
        quantity: columns[config.COL_IDS.QUANTITY] || '',
        cxAlloyId: columns[config.COL_IDS.CX_ALLOY_ID] || '',
        dateShipped: parseMondayDate(columns[config.COL_IDS.DATE_SHIPPED])
    };
}

function isFactorySnap(item) {
    if (item.groupId !== config.SNAP_GROUP_ID) return false;
    return String(item.orderType || '')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .includes('snap');
}

function readMovementHistory(runtimeStore) {
    return runtimeStore.readHistory().then(stored => {
        if (stored && typeof stored === 'object' && stored.weeks) return stored;
        return { version: 1, weeks: {} };
    });
}

function generateHtml(data) {
    const { dateKey, baseline, movement, callouts, summary } = data;
    const viewUrl = `https://${config.MONDAY_SLUG}.monday.com/boards/${config.BOARD_ID}/views/${config.VIEW_ID}`;
    const fieldViewUrl = `https://${config.MONDAY_SLUG}.monday.com/boards/${config.BOARD_ID}/views/${config.FIELD_SERVICE_VIEW_ID}`;
    const generatedLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: config.TIME_ZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    }).format(new Date());
    const rangeLabel = baseline
        ? `Movement measured ${formatDateKey(baseline.weekKey)} → ${formatDateKey(dateKey)}`
        : `Baseline established ${formatDateKey(dateKey)} — movement tracking starts next Monday`;

    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <style type="text/css">body,table,td,th,div,h1,a,span{font-family:${EMAIL_FONT_FAMILY} !important;}</style>
    <!--[if mso]><style type="text/css">body,table,td,th,div,h1,a,span{font-family:${EMAIL_FONT_FAMILY} !important;}</style><![endif]--></head>
    <body style="margin:0;padding:0;background:#f1f5f9;font-family:${EMAIL_FONT_FAMILY};color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f1f5f9"><tr><td align="center" style="padding:24px 10px;">
    <table role="presentation" width="960" cellpadding="0" cellspacing="0" style="width:960px;max-width:100%;background:#ffffff;">
        <tr><td bgcolor="#172554" style="padding:28px 32px;background:#172554;color:#ffffff;">
            <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#bfdbfe;">Order Tracker Operations</div>
            <h1 style="margin:7px 0 5px;font-size:28px;line-height:34px;">Weekly Open Orders — Movement by Owner</h1>
            <div style="font-size:13px;color:#dbeafe;">${escapeHtml(generatedLabel)} &nbsp;•&nbsp; ${escapeHtml(rangeLabel)}</div>
        </td></tr>
        ${renderSnapSection(data)}
        ${renderFieldSection(data)}
        ${renderOwnerMapSection()}
        <tr><td bgcolor="#e0e7ff" align="center" style="padding:20px;background:#e0e7ff;"><a href="${viewUrl}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-size:13px;font-weight:800;padding:11px 16px;border-radius:4px;margin-right:6px;">Open Factory SNAP view</a><a href="${fieldViewUrl}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-size:13px;font-weight:800;padding:11px 16px;border-radius:4px;">Open Field Service view</a><div style="margin-top:12px;font-size:11px;color:#475569;">Automated Mondays at 5:00 AM Central &nbsp;•&nbsp; Movement = status, quantity, order date, or CX Alloy ID changed, or the item closed &nbsp;•&nbsp; Credited to whoever held the item at the baseline</div></td></tr>
    </table></td></tr></table></body></html>`;

    return applyEmailFontFamily(html);
}

function renderSnapSection(data) {
    const { baseline, movement, callouts, summary, snapProfile, oldestUntouched } = data;
    const banner = `<tr><td bgcolor="#dbeafe" style="padding:18px 24px;background:#dbeafe;border-top:5px solid #1d4ed8;"><div style="font-size:20px;font-weight:800;color:#1e3a8a;">Part 1 — Factory SNAP orders</div><div style="font-size:12px;color:#1e3a8a;margin-top:4px;">SNAP order type in the Factory group &nbsp;•&nbsp; ownership follows Current Dept / Status</div></td></tr>`;

    if (!movement) {
        return `${banner}
        ${sectionHeader('Baseline established', 'Current SNAP holdings by owner — movement tracking starts next Monday')}
        <tr><td style="padding:0 24px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            ${metricCard('Open SNAP items', summary.snapOpen, 'baseline count', '#1d4ed8')}
            ${metricCard('Past 6 weeks', summary.snapPast6w, `older than ${config.PAST_DUE_DAYS} days`, '#b45309')}
            ${metricCard('Closed this week', summary.closedThisWeek, `last ${config.CLOSED_LOOKBACK_DAYS} days, both lists`, '#15803d')}
            ${metricCard('Oldest untouched', oldestUntouched.snap ? `${oldestUntouched.snap.days}d` : '—', oldestUntouched.snap ? escapeName(oldestUntouched.snap.name) : 'no update history', '#7c3aed')}
        </tr></table></td></tr>
        ${renderHoldingsTable(snapProfile, 'SNAP holdings by owner', false)}
        ${renderFootnotes(false)}`;
    }

    const snap = movement.snap;
    const baselineSummary = baseline.week.summary || {};
    const openDelta = Number.isFinite(baselineSummary.snapOpen) ? summary.snapOpen - baselineSummary.snapOpen : null;
    const past6wDelta = Number.isFinite(baselineSummary.snapPast6w) ? summary.snapPast6w - baselineSummary.snapPast6w : null;
    const notes = [
        ...callouts.snap,
        `Open SNAP items ${Number.isFinite(baselineSummary.snapOpen) ? `went from ${baselineSummary.snapOpen} to ${summary.snapOpen} (${formatDelta(openDelta)})` : `now at ${summary.snapOpen}`}`,
        `${snap.closedCount} carried-over item${snap.closedCount === 1 ? '' : 's'} closed; ${snap.handoffsToSupplier} handed off to supplier`,
        `Items past six weeks: ${Number.isFinite(baselineSummary.snapPast6w) ? `${baselineSummary.snapPast6w} → ${summary.snapPast6w} (${formatDelta(past6wDelta)})` : summary.snapPast6w}`
    ];
    if (snap.removedNoTrace > 0) {
        notes.push(`${snap.removedNoTrace} item${snap.removedNoTrace === 1 ? '' : 's'} left the board without a recorded Shipped event (excluded from the numbers above)`);
    }

    return `${banner}
    <tr><td style="padding:22px 24px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${metricCard('Open SNAP items', summary.snapOpen, formatDelta(openDelta), '#1d4ed8', 20)}
        ${metricCard('% moved', snap.totals.movedPct === null ? '—' : `${snap.totals.movedPct}%`, `${snap.totals.moved} of ${snap.totals.carried} carried over`, '#15803d', 20)}
        ${metricCard('Closed this week', summary.closedThisWeek, `last ${config.CLOSED_LOOKBACK_DAYS} days, both lists`, '#0f766e', 20)}
        ${metricCard('Past 6 weeks', summary.snapPast6w, formatDelta(past6wDelta), '#b45309', 20)}
        ${metricCard('Oldest untouched', oldestUntouched.snap ? `${oldestUntouched.snap.days}d` : '—', oldestUntouched.snap ? escapeName(oldestUntouched.snap.name) : 'no update history', '#7c3aed', 20)}
    </tr></table></td></tr>
    ${sectionHeader(`SNAP movement by owner — ${formatDateKey(baseline.weekKey)} to ${formatDateKey(data.dateKey)}`, 'Credited to whoever held the item at the baseline, including handoffs to supplier')}
    <tr><td style="padding:0 24px 18px;">${renderMovementTable(snap)}</td></tr>
    ${sectionHeader('Movement notes', 'Computed from the weekly snapshots')}
    <tr><td style="padding:0 24px 18px;">${renderNoteList(notes)}</td></tr>
    ${renderFootnotes(true)}`;
}

function renderFieldSection(data) {
    const { baseline, movement, callouts, summary, fieldProfile, gate, byUnit, oldestUntouched } = data;
    const banner = `<tr><td bgcolor="#ccfbf1" style="padding:18px 24px;background:#ccfbf1;border-top:5px solid #0f766e;"><div style="font-size:20px;font-weight:800;color:#134e4a;">Part 2 — Field Service orders</div><div style="font-size:12px;color:#115e59;margin-top:4px;">All order types in the Field Service group &nbsp;•&nbsp; ownership follows Current Dept / Status</div></td></tr>`;
    const gateBreakdown = Object.entries(gate.byStatus).map(([status, count]) => `${status} ${count}`).join(' + ') || 'none';
    const priorityFlagged = countPriorityFlagged(data.fieldItems);
    const unitRows = Object.entries(byUnit).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([label, count]) => tableCountRow(label, count, summary.fieldOpen)).join('');

    const movementBlock = movement ? `
    ${sectionHeader(`Field Service movement by owner — ${formatDateKey(baseline.weekKey)} to ${formatDateKey(data.dateKey)}`, 'Credited to whoever held the item at the baseline')}
    <tr><td style="padding:0 24px 18px;">${renderMovementTable(movement.fieldService)}</td></tr>
    ${callouts.fieldService.length ? `${sectionHeader('Movement notes', 'Computed from the weekly snapshots')}
    <tr><td style="padding:0 24px 18px;">${renderNoteList(callouts.fieldService)}</td></tr>` : ''}` : `
    ${sectionHeader('First look', 'This is a starting position, not a scorecard — movement gets measured from the next run onward')}`;

    return `${banner}
    <tr><td style="padding:22px 24px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${metricCard('Open field items', summary.fieldOpen, `across ${Object.keys(byUnit).length} unit${Object.keys(byUnit).length === 1 ? '' : 's'}`, '#0f766e', 20)}
        ${metricCard('Priority flagged', priorityFlagged.total, `${priorityFlagged.critical} critical / ${priorityFlagged.high} high`, '#b45309', 20)}
        ${metricCard('At shipping gate', gate.total, gateBreakdown, '#7c3aed', 20)}
        ${metricCard('Past 6 weeks', summary.fieldPast6w, `older than ${config.PAST_DUE_DAYS} days`, '#b45309', 20)}
        ${metricCard('Oldest untouched', oldestUntouched.fieldService ? `${oldestUntouched.fieldService.days}d` : '—', oldestUntouched.fieldService ? escapeName(oldestUntouched.fieldService.name) : 'no update history', '#7c3aed', 20)}
    </tr></table></td></tr>
    ${movementBlock}
    ${renderHoldingsTable(fieldProfile, 'Field Service — open items by owner (current holdings)', true)}
    ${sectionHeader('Open items by unit', 'Customer column on the Field Service lines')}
    <tr><td style="padding:0 24px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="48%" valign="top">${miniTable('Units', unitRows)}</td><td width="52%"></td></tr></table></td></tr>`;
}

function renderMovementTable(movement) {
    const labels = core.sortBucketLabels(movement.rows, 'carried');
    const rows = labels.map(label => {
        const row = movement.rows[label];
        const muted = label === core.INFORMATIONAL_LABEL;
        const alert = label === core.UNMAPPED_LABEL;
        const nameStyle = muted
            ? 'font-style:italic;color:#b91c1c;font-weight:400;'
            : alert ? 'color:#b45309;font-weight:800;' : 'font-weight:700;color:#0f172a;';
        const display = muted ? `${label} <span style="color:#94a3b8;font-style:normal;">(informational — not chased)</span>` : escapeHtml(label);
        return `<tr>
            <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;${nameStyle}">${display}</td>
            <td align="right" style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;color:#15803d;">${row.moved}</td>
            <td align="right" style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;color:#0f172a;">${row.sitting}</td>
            <td align="right" style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:${row.past6w ? '#b91c1c' : '#94a3b8'};font-weight:700;">${row.past6w || '—'}</td>
            <td align="right" style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:800;color:${movedPctColor(row.movedPct)};">${row.movedPct === null ? '—' : `${row.movedPct}%`}</td>
        </tr>`;
    }).join('');
    const totals = movement.totals;
    const totalRow = `<tr bgcolor="#f8fafc">
        <td style="padding:10px 12px;font-size:13px;font-weight:800;color:#0f172a;">Total</td>
        <td align="right" style="padding:10px 12px;font-size:13px;font-weight:800;">${totals.moved}</td>
        <td align="right" style="padding:10px 12px;font-size:13px;font-weight:800;">${totals.sitting}</td>
        <td align="right" style="padding:10px 12px;font-size:13px;font-weight:800;">${totals.past6w}</td>
        <td align="right" style="padding:10px 12px;font-size:13px;font-weight:800;">${totals.movedPct === null ? '—' : `${totals.movedPct}%`}</td>
    </tr>`;
    const emptyRow = `<tr><td colspan="5" align="center" style="padding:14px;color:#64748b;font-size:12px;">No items carried over from the baseline.</td></tr>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;">
        <tr bgcolor="#172554"><th align="left" style="padding:9px 12px;font-size:11px;color:#ffffff;text-transform:uppercase;">Owner</th><th align="right" style="padding:9px 12px;font-size:11px;color:#ffffff;text-transform:uppercase;">Moved</th><th align="right" style="padding:9px 12px;font-size:11px;color:#ffffff;text-transform:uppercase;">Sitting</th><th align="right" style="padding:9px 12px;font-size:11px;color:#ffffff;text-transform:uppercase;">Past 6 wks</th><th align="right" style="padding:9px 12px;font-size:11px;color:#ffffff;text-transform:uppercase;">% moved</th></tr>
        ${rows || emptyRow}${rows ? totalRow : ''}
    </table>`;
}

function renderHoldingsTable(profile, title, includeUnits) {
    const labels = core.sortBucketLabels(profile, 'items');
    const unitHeaders = includeUnits
        ? `<th align="right" style="padding:9px 12px;font-size:11px;color:#ffffff;text-transform:uppercase;">Units</th><th align="left" style="padding:9px 12px;font-size:11px;color:#ffffff;text-transform:uppercase;">Where they're sitting</th>`
        : '';
    const rows = labels.map(label => {
        const row = profile[label];
        const muted = label === core.INFORMATIONAL_LABEL;
        const alert = label === core.UNMAPPED_LABEL;
        const nameStyle = muted
            ? 'font-style:italic;color:#b91c1c;font-weight:400;'
            : alert ? 'color:#b45309;font-weight:800;' : 'font-weight:700;color:#0f172a;';
        const unitCells = includeUnits
            ? `<td align="right" style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;">${row.units}</td><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#475569;">${escapeHtml(row.topStatuses)}</td>`
            : '';
        return `<tr>
            <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;${nameStyle}">${muted ? `${label} <span style="color:#94a3b8;font-style:normal;">(informational — not chased)</span>` : escapeHtml(label)}</td>
            <td align="right" style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:800;">${row.items}</td>
            <td align="right" style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;color:${row.critical ? '#b91c1c' : '#94a3b8'};">${row.critical || '—'}</td>
            <td align="right" style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;color:${row.high ? '#b45309' : '#94a3b8'};">${row.high || '—'}</td>
            <td align="right" style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:${ageColor(row.oldestAgeDays)};font-weight:700;">${row.oldestAgeDays === null ? '—' : `${row.oldestAgeDays}d`}</td>
            ${unitCells}
        </tr>`;
    }).join('');
    const columnCount = includeUnits ? 7 : 5;
    return `${sectionHeader(title, 'Ownership by the status each item is in right now')}
    <tr><td style="padding:0 24px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;">
        <tr bgcolor="#172554"><th align="left" style="padding:9px 12px;font-size:11px;color:#ffffff;text-transform:uppercase;">Owner</th><th align="right" style="padding:9px 12px;font-size:11px;color:#ffffff;text-transform:uppercase;">Items</th><th align="right" style="padding:9px 12px;font-size:11px;color:#ffffff;text-transform:uppercase;">Critical</th><th align="right" style="padding:9px 12px;font-size:11px;color:#ffffff;text-transform:uppercase;">High</th><th align="right" style="padding:9px 12px;font-size:11px;color:#ffffff;text-transform:uppercase;">Oldest</th>${unitHeaders}</tr>
        ${rows || `<tr><td colspan="${columnCount}" align="center" style="padding:14px;color:#64748b;font-size:12px;">No open items.</td></tr>`}
    </table></td></tr>`;
}

function renderOwnerMapSection() {
    const rows = Object.entries(config.OWNER_MAP).map(([status, value]) => {
        let snapOwner;
        let fieldOwner;
        if (value === null) {
            snapOwner = fieldOwner = '<span style="font-style:italic;color:#b91c1c;">Informational — no owner</span>';
        } else if (typeof value === 'string') {
            snapOwner = fieldOwner = escapeHtml(value);
        } else {
            snapOwner = value.snap ? escapeHtml(value.snap) : '—';
            fieldOwner = value.fieldService ? escapeHtml(value.fieldService) : '—';
        }
        return `<tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;font-weight:700;color:#0f172a;">${escapeHtml(status)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#334155;">${snapOwner}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#334155;">${fieldOwner}</td>
        </tr>`;
    }).join('');
    return `<tr><td bgcolor="#f8fafc" style="padding:18px 24px 6px;background:#f8fafc;border-top:3px solid #cbd5e1;"><div style="font-size:16px;font-weight:800;color:#0f172a;">Who owns what — by Current Dept / Status</div><div style="font-size:11px;color:#64748b;margin-top:3px;">The board has no Owner column, so ownership follows the status. Reply to flag a wrong assignment — every number above depends on this map being right.</div></td></tr>
    <tr><td bgcolor="#f8fafc" style="padding:8px 24px 20px;background:#f8fafc;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;background:#ffffff;">
        <tr bgcolor="#e2e8f0"><th align="left" style="padding:8px 12px;font-size:11px;color:#334155;text-transform:uppercase;">Current Dept / Status</th><th align="left" style="padding:8px 12px;font-size:11px;color:#334155;text-transform:uppercase;">SNAP lines</th><th align="left" style="padding:8px 12px;font-size:11px;color:#334155;text-transform:uppercase;">Field Service lines</th></tr>
        ${rows}
    </table></td></tr>`;
}

function renderNoteList(notes) {
    const rows = notes.map(note => `<tr><td width="14" valign="top" style="padding:5px 0;font-size:13px;color:#1d4ed8;font-weight:800;">•</td><td style="padding:5px 0;font-size:13px;color:#334155;">${escapeHtml(note)}</td></tr>`).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dbe3ef;background:#f8fafc;"><tr><td style="padding:12px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr></table>`;
}

function renderFootnotes(includeMovement) {
    const notes = [];
    if (includeMovement) {
        notes.push('Moved = status, quantity, order date, or CX Alloy ID changed, or the item reached a closed status. Credited to whoever held the item at the baseline, including handoffs to supplier. Ordered from Supplier is a waiting state rather than anyone\'s queue, so it is listed separately and the totals still close.');
    }
    notes.push('"Untouched" uses Monday\'s last-updated timestamp: any column edit, comment, or automation resets it.');
    return `<tr><td style="padding:0 24px 18px;"><div style="font-size:10px;color:#94a3b8;line-height:15px;">${notes.map(escapeHtml).join('<br>')}</div></td></tr>`;
}

function countPriorityFlagged(items) {
    let critical = 0;
    let high = 0;
    let other = 0;
    for (const item of items) {
        if (/critical/i.test(item.priority)) critical += 1;
        else if (/high/i.test(item.priority)) high += 1;
        else if (item.priority) other += 1;
    }
    return { total: critical + high + other, critical, high };
}

function movedPctColor(pct) {
    if (pct === null) return '#94a3b8';
    if (pct >= 60) return '#15803d';
    if (pct >= 30) return '#b45309';
    return '#b91c1c';
}

function escapeName(name) {
    return String(name).length > 28 ? `${String(name).slice(0, 27)}…` : String(name);
}

function applyEmailFontFamily(html) {
    return html.replace(/<(td|th)\b([^>]*)>/gi, (tag, tagName, attributes) => {
        if (/\bstyle\s*=\s*(["'])/i.test(attributes)) {
            return tag.replace(/\bstyle\s*=\s*(["'])/i, `style=$1font-family:${EMAIL_FONT_FAMILY};`);
        }
        return `<${tagName}${attributes} style="font-family:${EMAIL_FONT_FAMILY};">`;
    });
}

function metricCard(label, value, note, color, width = 25) {
    return `<td width="${width}%" valign="top" style="padding:4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dbe3ef;"><tr><td style="padding:14px 12px;border-top:4px solid ${color};"><div style="font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">${escapeHtml(label)}</div><div style="font-size:25px;font-weight:800;color:#0f172a;margin:4px 0;">${escapeHtml(value)}</div><div style="font-size:10px;color:#64748b;">${escapeHtml(note)}</div></td></tr></table></td>`;
}

function sectionHeader(title, subtitle) {
    return `<tr><td style="padding:20px 24px 10px;"><div style="font-size:17px;font-weight:800;color:#0f172a;">${escapeHtml(title)}</div><div style="font-size:11px;color:#64748b;margin-top:3px;">${escapeHtml(subtitle)}</div></td></tr>`;
}

function miniTable(title, rows) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;"><tr><td colspan="2" bgcolor="#f8fafc" style="padding:9px 10px;font-size:11px;font-weight:800;color:#334155;text-transform:uppercase;">${escapeHtml(title)}</td></tr>${rows || '<tr><td style="padding:10px;color:#64748b;font-size:12px;">No data</td></tr>'}</table>`;
}

function tableCountRow(label, count, total) {
    const percent = total ? Math.round(count / total * 100) : 0;
    return `<tr><td style="padding:7px 9px;border-top:1px solid #e2e8f0;font-size:11px;color:#475569;">${escapeHtml(label)}</td><td align="right" style="padding:7px 9px;border-top:1px solid #e2e8f0;font-size:11px;font-weight:800;color:#0f172a;">${count} <span style="font-weight:400;color:#94a3b8;">${percent}%</span></td></tr>`;
}

async function createRuntimeStore() {
    if (!process.env.REDIS_URL) {
        return createFileRuntimeStore();
    }
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', error => console.error(`Redis error: ${error.message}`));
    await client.connect();
    return {
        async readHistory() {
            const raw = await client.get(REDIS_HISTORY_KEY);
            return raw ? JSON.parse(raw) : {};
        },
        async writeHistory(history) { await client.set(REDIS_HISTORY_KEY, JSON.stringify(history)); },
        async readLastRun() { return await client.get(REDIS_LAST_RUN_KEY) || ''; },
        async writeLastRun(dateKey) { await client.set(REDIS_LAST_RUN_KEY, dateKey); },
        async close() { if (client.isOpen) await client.quit(); }
    };
}

function createFileRuntimeStore() {
    return {
        async readHistory() { return readJson(HISTORY_FILE, {}); },
        async writeHistory(history) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); },
        async readLastRun() { return fs.existsSync(LAST_RUN_FILE) ? fs.readFileSync(LAST_RUN_FILE, 'utf8').trim() : ''; },
        async writeLastRun(dateKey) { fs.writeFileSync(LAST_RUN_FILE, dateKey); },
        async close() {}
    };
}

async function sendEmail(html, dateKey) {
    const recipientValue = process.env.MOVEMENT_REPORT_TO_EMAIL || config.DEFAULT_RECIPIENT;
    const recipients = splitRecipients(recipientValue);
    if (!recipients.length) {
        throw new Error('No weekly movement report recipients are configured.');
    }
    if (!process.env.M365_TENANT_ID || !process.env.M365_CLIENT_ID || !process.env.M365_CLIENT_SECRET || !process.env.M365_SENDER_UPN) {
        throw new Error('Microsoft Graph mail settings are incomplete.');
    }

    const tokenResponse = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(process.env.M365_TENANT_ID)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: process.env.M365_CLIENT_ID,
            client_secret: process.env.M365_CLIENT_SECRET,
            scope: 'https://graph.microsoft.com/.default',
            grant_type: 'client_credentials'
        })
    });
    if (!tokenResponse.ok) {
        throw new Error(`Microsoft Graph token request failed (${tokenResponse.status}): ${await tokenResponse.text()}`);
    }
    const { access_token: accessToken } = await tokenResponse.json();
    const mailResponse = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.M365_SENDER_UPN)}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: {
                subject: `Weekly Open Orders — Movement by Owner — ${formatDateKey(dateKey)}`,
                body: { contentType: 'HTML', content: html },
                toRecipients: recipients.map(address => ({ emailAddress: { address } }))
            },
            saveToSentItems: true
        })
    });
    if (!mailResponse.ok) {
        throw new Error(`Microsoft Graph sendMail failed (${mailResponse.status}): ${await mailResponse.text()}`);
    }
    console.log(`Email sent via Microsoft Graph to ${recipients.join(', ')}.`);
}

function saveHtml(html, dateKey) {
    const directory = path.join(__dirname, 'exports');
    fs.mkdirSync(directory, { recursive: true });
    const outputPath = path.join(directory, `weekly-movement-report-${dateKey}.html`);
    fs.writeFileSync(outputPath, html, 'utf8');
    return outputPath;
}

function getZonedDateParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        dateKey: `${values.year}-${values.month}-${values.day}`,
        hour: Number(values.hour),
        weekday: weekdays[values.weekday]
    };
}

function parseMondayDate(value) {
    if (!value) return null;
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)) : null;
}

function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(start, end) {
    return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86400000));
}

function dateKeyToUtc(dateKey) {
    return new Date(`${dateKey}T12:00:00.000Z`);
}

function formatDateKey(dateKey) {
    const [year, month, day] = dateKey.split('-');
    return `${Number(month)}/${Number(day)}/${year}`;
}

function formatDelta(value) {
    if (value === null || value === undefined) return 'Baseline';
    if (value === 0) return 'No change';
    return `${value > 0 ? '+' : ''}${value}`;
}

function ageColor(ageDays) {
    if (ageDays === null || ageDays <= 30) return '#334155';
    return ageDays > 60 ? '#b91c1c' : '#b45309';
}

function splitRecipients(value) {
    return String(value || '').split(/[;,]/).map(entry => entry.trim()).filter(Boolean);
}

function readJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

generateReport().catch(error => {
    console.error(`Fatal error: ${error.message}`);
    process.exitCode = 1;
});
