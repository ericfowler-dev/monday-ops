require('dotenv').config();

const fs = require('fs');
const path = require('path');
const config = require('./weekly-movement-report.config');
const { normalizeBoardActivityLogs, computeDynamicOwnerActivity, buildWeeklySnapshot, buildActionedTrend, filterActorRows } = require('./dynamic-owner-activity-core');
const { pruneWeeks, ownerFor } = require('./weekly-movement-core');
const { createHistoryStore } = require('./dynamic-owner-history-store');
const { isCancelled, shipmentEvents, buildShipmentSummary, summarizeOpenOrders, isDstCompanionRun, shiftDate } = require('./movement-daily-core');

const MONDAY_API_VERSION = process.env.MONDAY_API_VERSION || '2026-07';
const WINDOW_DAYS = 7;
const WAITING_HOURS = 24;
const ACTIVITY_LIMIT = 10000;
const FONT = "'Segoe UI',Arial,sans-serif";

// Columns fetched as values for every item (activity logs cover the rest).
const ITEM_COLUMN_IDS = [
    config.COL_IDS.ORDER_TYPE,
    config.COL_IDS.CURRENT_STATUS,
    config.COL_IDS.ORDER_DATE,
    config.COL_IDS.PRIORITY,
    config.COL_IDS.DATE_SHIPPED
];

// Deliberately narrow: these fields represent a meaningful workflow action.
// Cosmetic edits, notes, and passive automations do not earn owner credit.
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

async function generateReport() {
    const args = new Set(process.argv.slice(2));
    if (args.has('--check-delivery-config')) {
        console.log(JSON.stringify({ recipients: deliveryRecipients(), commit: process.env.RENDER_GIT_COMMIT || 'local', schedule: '5 AM America/Chicago, Monday-Friday' }));
        return;
    }
    const deliveryMode = args.has('--send') || process.env.SEND_EMAIL === '1';
    const dryRun = args.has('--dry-run') || process.env.DRY_RUN === '1';
    const now = new Date();
    if (deliveryMode && !dryRun && process.env.RENDER === 'true' && !args.has('--force') && isDstCompanionRun(now)) {
        console.log('No email sent: skipping the unused daylight-saving companion hour. The scheduled delivery is 5 AM Central.');
        return;
    }
    const fromDate = new Date(now.getTime() - WINDOW_DAYS * 86400000);
    console.log(`Building dynamic-owner ${deliveryMode ? 'report' : 'preview'} for ${fromDate.toISOString()} through ${now.toISOString()}...`);

    const [currentRawItems, rawLogs, shipmentLogs, historyWeeks] = await Promise.all([
        fetchCurrentRelevantItems(),
        fetchBoardActivity(fromDate, now),
        fetchBoardActivity(new Date(`${shiftDate(formatDateKey(now), -31)}T00:00:00Z`), now, true),
        readHistoryWeeks()
    ]);
    const shippedEvents = shipmentEvents(shipmentLogs, config.COL_IDS.CURRENT_STATUS);
    const allEvents = normalizeBoardActivityLogs(rawLogs, QUALIFYING_COLUMNS, { excludedActorIds: config.EXCLUDED_ACTOR_IDS });
    const relevantGroups = new Set([config.SNAP_GROUP_ID, config.FIELD_SERVICE_GROUP_ID]);
    const knownIds = new Set(currentRawItems.map(item => String(item.id)));
    const historyItemIds = Object.values(historyWeeks).flatMap(week => ['snap', 'fieldService'].flatMap(pop =>
        (week.populations?.[pop]?.actorRows || []).flatMap(row => row.actionedItemIds || [])));
    const historicalCandidateIds = [...new Set([...allEvents
        .filter(event => relevantGroups.has(event.groupId)
            || relevantGroups.has(event.sourceGroupId)
            || relevantGroups.has(event.destinationGroupId))
        .map(event => event.itemId), ...shippedEvents.map(event => event.itemId), ...historyItemIds])].filter(id => !knownIds.has(id));
    const recoveredRawItems = await fetchItemsById(historicalCandidateIds);
    const allItems = [...currentRawItems, ...recoveredRawItems].map(raw => mapItem(raw, now));
    const excludedItemIds = new Set(allItems.filter(isCancelled).map(item => item.id));
    // Missing historical records cannot be verified as non-cancelled, so omit
    // their old person-credit contributions too.
    const retrievedIds = new Set(allItems.map(item => item.id));
    for (const id of historyItemIds) if (!retrievedIds.has(id)) excludedItemIds.add(id);
    const items = allItems.filter(item => !isCancelled(item));
    const itemIds = new Set(items.map(item => item.id));
    const events = allEvents.filter(event => itemIds.has(event.itemId));
    const actorIds = [...new Set(events.map(event => event.actorUserId).filter(id => id && id !== 'unknown'))];
    const userNames = await fetchUserNames(actorIds);

    const result = computeDynamicOwnerActivity({
        items,
        events,
        fromDate,
        refDate: now,
        ownerMap: config.OWNER_MAP,
        snapGroupId: config.SNAP_GROUP_ID,
        fieldServiceGroupId: config.FIELD_SERVICE_GROUP_ID,
        closedStatuses: config.CLOSED_CURRENT_STATUSES,
        waitingHours: WAITING_HOURS,
        pastDueDays: config.PAST_DUE_DAYS
    });

    const shipments = buildShipmentSummary({ items, events: shippedEvents, now,
        snapGroupId: config.SNAP_GROUP_ID, fieldServiceGroupId: config.FIELD_SERVICE_GROUP_ID });
    result.closure = shipments.closure;
    result.populations.snap.closedOrders = shipments.snap.last7;
    result.populations.fieldService.closedOrders = shipments.fieldService.last7;
    result.executive.closedOrders = shipments.total.last7;
    const html = renderHtml({
        now,
        fromDate,
        result,
        events,
        items,
        userNames,
        historyWeeks,
        shipments,
        openSummary: summarizeOpenOrders(items, now),
        excludedItemIds,
        unavailableShipments: new Set(shippedEvents.filter(event => !retrievedIds.has(event.itemId)).map(event => event.itemId)).size,
        currentWeekKey: formatDateKey(now),
        send: deliveryMode,
        activityLimitReached: false,
        rawLogCount: rawLogs.length
    });
    const outputPath = saveHtml(html, now, deliveryMode);
    if (deliveryMode && !dryRun) {
        if (process.env.RENDER === 'true' && !process.env.REDIS_URL) throw new Error('REDIS_URL is required for daily delivery protection.');
        const store = await createHistoryStore();
        const key = formatDateKey(now);
        let claimed = false;
        try {
            claimed = await store.claimDelivery(key);
            if (!claimed) { console.log(`Report already delivered or in progress for ${key}; no email sent.`); return; }
            await sendEmail(html, now);
            await store.markDelivered(key);
            if (isSnapshotDay(now)) await persistSnapshot(result, items, now, userNames);
        } finally {
            if (claimed) await store.releaseDelivery(key);
            await store.close();
        }
    }
    logSummary(result, items, events, rawLogs.length, outputPath, deliveryMode, dryRun, userNames);
}

// Non-fatal by design: the email has already been sent, and trend history can
// tolerate a missed week better than the report can tolerate a failed run.
async function persistSnapshot(result, items, now, userNames) {
    let store;
    try {
        store = await createHistoryStore();
        const history = await store.readHistory();
        history.version = 1;
        history.weeks = history.weeks || {};
        const dateKey = formatDateKey(now);
        history.weeks[dateKey] = buildWeeklySnapshot({
            result,
            items,
            refDate: now,
            isInformational: (status, population) =>
                ownerFor(status || 'Unassigned', population, config.OWNER_MAP).informational === true,
            userNames,
            excludedActorIds: config.EXCLUDED_ACTOR_IDS
        });
        pruneWeeks(history.weeks, config.HISTORY_RETENTION_WEEKS);
        await store.writeHistory(history);
        await store.writeLastRun(dateKey);
        console.log(`Weekly snapshot ${dateKey} stored via ${store.kind} (${Object.keys(history.weeks).length} weeks retained).`);
    } catch (error) {
        console.error(`Snapshot storage failed (report already sent): ${error.message}`);
    } finally {
        if (store) await store.close().catch(() => {});
    }
}

// Weekly trend history must stay one-snapshot-per-week, so only runs on the
// scheduled weekday (Monday, Central time) persist history. Off-schedule test
// sends deliver accurate 7-day data but leave stored history untouched.
function isSnapshotDay(now) {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: config.TIME_ZONE, weekday: 'short' }).format(now);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday) === config.SCHEDULE_WEEKDAY;
}

// Trend data is best-effort: environments without Redis (or with an empty local
// fallback file) simply render the "history accruing" placeholder.
async function readHistoryWeeks() {
    let store;
    try {
        store = await createHistoryStore();
        const history = await store.readHistory();
        return history && history.weeks ? history.weeks : {};
    } catch (error) {
        console.error(`History read failed (trend section will show its placeholder): ${error.message}`);
        return {};
    } finally {
        if (store) await store.close().catch(() => {});
    }
}

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
    if (!response.ok || payload.errors) {
        throw new Error(`Monday API request failed: ${JSON.stringify(payload.errors || payload)}`);
    }
    return payload.data;
}

async function fetchCurrentRelevantItems() {
    const result = [];
    const relevantGroups = new Set([config.SNAP_GROUP_ID, config.FIELD_SERVICE_GROUP_ID]);
    const columnIds = ITEM_COLUMN_IDS;
    let cursor = null;
    do {
        const data = await mondayQuery(`query ($boardIds: [ID!], $cursor: String, $columnIds: [String!]) {
            boards(ids: $boardIds) {
                items_page(limit: 500, cursor: $cursor) {
                    cursor
                    items { id name state created_at group { id title } column_values(ids: $columnIds) { id text } }
                }
            }
        }`, { boardIds: [config.BOARD_ID], cursor, columnIds });
        const page = data.boards[0]?.items_page;
        for (const item of page?.items || []) {
            if (relevantGroups.has(item.group?.id)) result.push(item);
        }
        cursor = page?.cursor || null;
    } while (cursor);
    return result;
}

async function fetchItemsById(ids) {
    const result = [];
    const columnIds = ITEM_COLUMN_IDS;
    for (let offset = 0; offset < ids.length; offset += 100) {
        const data = await mondayQuery(`query ($itemIds: [ID!], $columnIds: [String!]) {
            items(ids: $itemIds, limit: 100) {
                id name state created_at group { id title } column_values(ids: $columnIds) { id text }
            }
        }`, { itemIds: ids.slice(offset, offset + 100), columnIds });
        result.push(...(data.items || []));
    }
    return result;
}

async function fetchBoardActivity(fromDate, toDate, statusOnly = false) {
    const data = await mondayQuery(`query ($boardIds: [ID!], $from: ISO8601DateTime!, $to: ISO8601DateTime!) {
        boards(ids: $boardIds) {
            activity_logs(from: $from, to: $to, limit: ${ACTIVITY_LIMIT}${statusOnly ? `, column_ids: ["${config.COL_IDS.CURRENT_STATUS}"]` : ''}) { id event data created_at user_id }
        }
    }`, { boardIds: [config.BOARD_ID], from: fromDate.toISOString(), to: toDate.toISOString() });
    const logs = data.boards[0]?.activity_logs || [];
    if (logs.length >= ACTIVITY_LIMIT) {
        if (toDate - fromDate < 60000) throw new Error('Activity log limit reached within one minute; refusing to publish incomplete totals.');
        const middle = new Date(Math.floor((fromDate.getTime() + toDate.getTime()) / 2));
        const left = await fetchBoardActivity(fromDate, middle, statusOnly);
        const right = await fetchBoardActivity(middle, toDate, statusOnly);
        return [...new Map([...left, ...right].map(log => [log.id, log])).values()];
    }
    return logs;
}

async function fetchUserNames(ids) {
    const names = new Map([['unknown', 'Unknown / system']]);
    for (let offset = 0; offset < ids.length; offset += 100) {
        const data = await mondayQuery('query ($ids: [ID!]) { users(ids: $ids) { id name } }', { ids: ids.slice(offset, offset + 100) });
        for (const user of data.users || []) names.set(String(user.id), user.name);
    }
    return names;
}

function mapItem(raw, now) {
    const columns = Object.fromEntries((raw.column_values || []).map(column => [column.id, column.text || '']));
    const groupId = raw.group?.id || '';
    const status = columns[config.COL_IDS.CURRENT_STATUS] || 'Unassigned';
    const orderType = columns[config.COL_IDS.ORDER_TYPE] || '';
    const isSnapOrder = orderType.split(',').some(value => value.trim().toLowerCase() === 'snap');
    const orderDate = parseMondayDate(columns[config.COL_IDS.ORDER_DATE]);
    const createdAt = parseDate(raw.created_at);
    const population = groupId === config.FIELD_SERVICE_GROUP_ID
        ? 'fieldService'
        : groupId === config.SNAP_GROUP_ID && isSnapOrder ? 'snap' : null;
    const isClosed = config.CLOSED_CURRENT_STATUSES.some(value => value.toLowerCase() === status.toLowerCase());
    const priority = columns[config.COL_IDS.PRIORITY] || '';
    return {
        id: String(raw.id),
        name: raw.name,
        groupId,
        groupName: raw.group?.title || '',
        population,
        isSnapOrder,
        orderType,
        status,
        createdAt,
        orderDate,
        dateShipped: parseMondayDate(columns[config.COL_IDS.DATE_SHIPPED]),
        priority,
        isCritical: config.CRITICAL_PRIORITY_REGEX.test(priority),
        ageDays: daysBetween(orderDate || createdAt, now),
        isOpen: raw.state === 'active' && !isClosed && status.trim().toLowerCase() !== 'cancelled',
        url: `https://${config.MONDAY_SLUG}.monday.com/boards/${config.BOARD_ID}/pulses/${raw.id}`
    };
}

function renderHtml(data) {
    const { result, now, fromDate } = data;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <style>body,table,td,th,div,h1,h2,a,span{font-family:${FONT}!important} @media(max-width:760px){.metric,.bottleneck-card{display:block!important;width:auto!important}.shell{width:100%!important}.shell>tbody>tr>td{padding-left:12px!important;padding-right:12px!important}.detail-table td,.detail-table th{padding:6px 3px!important;font-size:10px!important}.chart-label{font-size:9px!important}.score-bar{display:none!important}}</style></head>
    <body style="margin:0;background:#eef2f7;color:#172033"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 10px">
    <table class="shell" role="presentation" width="1120" cellpadding="0" cellspacing="0" style="width:1120px;max-width:100%;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.08)">
      <tr><td style="padding:30px 34px;background:#12213f;color:#fff;border-bottom:6px solid #14b8a6">
        <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#99f6e4">${data.send ? 'Daily report' : 'Daily report preview'} · SNAP + Field Service</div>
        <h1 style="margin:7px 0 5px;font-size:29px;line-height:35px">Open Order Workflow Movement Report</h1>
        <div style="font-size:13px;color:#dbeafe">Reporting period ${escapeHtml(formatShortDate(fromDate))}–${escapeHtml(formatShortDate(now))} (prior 7 days) · Generated ${escapeHtml(formatLongDate(now))}, ${escapeHtml(formatDateTime(now))}</div>
      </td></tr>
      ${renderDataQuality(result, data)}
      ${renderDailySummary(data)}
      ${renderPopulation('Part 1 — Factory SNAP orders', '#2563eb', '#eff6ff', result.populations.snap, data.userNames, data.shipments.snap, data.openSummary.snap, data.shipments)}
      ${renderPopulation('Part 2 — Field Service orders', '#0f766e', '#f0fdfa', result.populations.fieldService, data.userNames, data.shipments.fieldService, data.openSummary.fieldService, data.shipments)}
      ${renderOwnerTrend(buildActionedTrend({
          historyWeeks: data.historyWeeks,
          currentWeekKey: data.currentWeekKey,
          currentResult: result,
          maxWeeks: config.TREND_MAX_WEEKS,
          snapshotWeekday: config.SCHEDULE_WEEKDAY,
          userNames: data.userNames,
          excludedActorIds: config.EXCLUDED_ACTOR_IDS,
          excludedItemIds: data.excludedItemIds,
          requireItemEvidence: true
      }))}
      ${renderBottleneck(
          result.populations,
          `https://${config.MONDAY_SLUG}.monday.com/boards/${config.BOARD_ID}/views/${config.OVERVIEW_VIEW_ID}`
      )}
      ${renderAgingBuckets(result.populations)}
      ${renderOwnerDetail('Factory SNAP', result.populations.snap)}
      ${renderOwnerDetail('Field Service', result.populations.fieldService)}
      <tr><td style="padding:19px 28px;background:#e8eef8;color:#475569;font-size:11px;line-height:17px">
        <b>How to read this report:</b> Counts represent individual order lines on the board, not units or complete customer orders. Person activity covers the last 7 days and excludes automated updates. Shipment totals count actual shipped lines, regardless of who updated them. Shipment charts use complete Central-time calendar days through yesterday; today is shown separately. Cancelled items are excluded throughout. “Waiting” means no qualifying human action for 24+ hours; “≥” means at least that long. Sent at 5 AM Central, Monday–Friday.${data.send ? '' : ' Preview only: no email was sent and no history was stored.'}
      </td></tr>
    </table></td></tr></table></body></html>`;
}

function renderDataQuality(result, data) {
    const unresolvedUserEvents = data.events.filter(event =>
        event.actorUserId && event.actorUserId !== 'unknown' && !data.userNames.has(event.actorUserId)).length;
    const entries = [
        ['Current assignments with unmapped ownership', result.dataQuality.unmappedCurrentPairs],
        ['Qualifying events performed by unknown/system users', result.dataQuality.unknownActorEvents],
        ['Qualifying events by unresolved user IDs', unresolvedUserEvents],
        ['Historical items no longer retrievable', result.dataQuality.unavailableEventItems],
        ['Shipment records unavailable for verification (not counted)', data.unavailableShipments || 0],
        [`Activity API limit reached (${data.rawLogCount.toLocaleString()} records returned; data may be incomplete)`, data.activityLimitReached ? 1 : 0]
    ].filter(([, count]) => count > 0);
    if (!entries.length) {
        return `<tr><td style="padding:14px 28px 4px"><div style="padding:10px 13px;background:#f0fdf4;border:1px solid #86efac;color:#166534;font-size:12px"><b>Data quality:</b> no unmapped owners, unresolved users, or data gaps detected this period.</div></td></tr>`;
    }
    const rows = entries.map(([label, count]) => `<li style="margin:2px 0">${escapeHtml(label)}: <b>${count === 1 && label.startsWith('Activity API') ? 'yes' : count}</b></li>`).join('');
    return `<tr><td style="padding:14px 28px 4px"><div style="padding:11px 14px;background:#fff7ed;border:1px solid #fdba74;color:#9a3412;font-size:12px;line-height:18px"><b>Data quality warning</b> — treat affected figures with care; unmapped or unresolved entries are not individual performance results.<ul style="margin:6px 0 0;padding-left:18px">${rows}</ul></div></td></tr>`;
}

function renderBottleneck(populations, overviewUrl) {
    const combined = [
        ...populations.snap.statusBottlenecks.map(row => ({ ...row, populationLabel: 'Factory SNAP' })),
        ...populations.fieldService.statusBottlenecks.map(row => ({ ...row, populationLabel: 'Field Service' }))
    ].sort((a, b) => b.waiting - a.waiting || b.currentCount - a.currentCount || a.status.localeCompare(b.status))
        .slice(0, 6);
    const maxCurrent = Math.max(1, ...combined.map(row => row.currentCount));
    const chartCards = combined.map(row => {
        const populationColor = row.populationLabel === 'Factory SNAP' ? '#2563eb' : '#0f766e';
        const countLabel = row.supplierWaiting
            ? `${row.currentCount} current · unowned stage`
            : `${row.waiting} waiting of ${row.currentCount} · ${pctLabel(row.waitingPct)}`;
        const oldestLabel = row.oldestAgeDays === null ? 'Oldest order age unavailable' : `Oldest order ${row.oldestAgeDays}d`;
        return `<td class="bottleneck-card" width="50%" valign="top" style="padding:5px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #cbd5e1;border-left:5px solid ${populationColor};background:#ffffff"><tr><td style="padding:14px 15px">
            <a href="${overviewUrl}" style="color:#0f172a;text-decoration:none;font-size:15px;font-weight:800;line-height:20px">${escapeHtml(row.status)}</a>
            <div style="margin-top:5px;font-size:11px;line-height:15px;color:${populationColor};font-weight:800;letter-spacing:.4px;text-transform:uppercase">${escapeHtml(row.populationLabel)}</div>
            <div style="margin-top:4px;font-size:14px;font-weight:800;line-height:19px;color:${row.waiting ? '#991b1b' : '#334155'}">${escapeHtml(countLabel)}</div>
            <div style="margin-top:3px;font-size:11px;line-height:16px;color:#475569;font-weight:600">${escapeHtml(oldestLabel)}</div>
            <div style="margin-top:10px">${bottleneckBar(row, maxCurrent)}</div>
          </td></tr></table>
        </td>`;
    });
    const chartRows = [];
    for (let index = 0; index < chartCards.length; index += 2) {
        chartRows.push(`<tr>${chartCards[index]}${chartCards[index + 1] || '<td class="bottleneck-card" width="50%"></td>'}</tr>`);
    }
    return `<tr><td style="padding:17px 28px 7px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle"><div style="font-size:19px;font-weight:800;color:#0f172a">Where work is stuck</div><div style="font-size:12px;line-height:17px;color:#475569;margin-top:4px">Top six statuses by waiting count. Red shows work waiting more than 24 hours; pale bars show the balance of current work. Unowned stages appear in gray.</div></td>
      <td width="200" align="right" valign="middle"><a href="${overviewUrl}" style="display:inline-block;padding:10px 13px;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:12px;font-weight:800;border-radius:4px">Open live Monday overview</a></td>
    </tr></table></td></tr>
    <tr><td style="padding:0 23px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${chartRows.join('') || emptyRow(2, 'No current open work.')}</table></td></tr>`;
}

function bottleneckBar(row, maxCurrent, maxPx = 300) {
    if (!row.currentCount) return '';
    const totalPx = Math.max(4, Math.round(row.currentCount / maxCurrent * maxPx));
    if (row.supplierWaiting) {
        return `<table role="presentation" width="${totalPx}" cellpadding="0" cellspacing="0"><tr><td width="${totalPx}" height="15" bgcolor="#94a3b8" style="font-size:0;line-height:0">&nbsp;</td></tr></table>`;
    }
    const waitingPx = Math.round(row.waiting / row.currentCount * totalPx);
    const activePx = totalPx - waitingPx;
    const waitingSegment = waitingPx ? `<td width="${waitingPx}" height="15" bgcolor="#dc2626" style="font-size:0;line-height:0">&nbsp;</td>` : '';
    const activeSegment = activePx ? `<td width="${activePx}" height="15" bgcolor="#93c5fd" style="font-size:0;line-height:0">&nbsp;</td>` : '';
    return `<table role="presentation" width="${totalPx}" cellpadding="0" cellspacing="0"><tr>${waitingSegment}${activeSegment}</tr></table>`;
}

function renderAgingBuckets(populations) {
    const snap = populations.snap.agingBuckets;
    const field = populations.fieldService.agingBuckets;
    const total = snap.total + field.total;
    const maxCombined = Math.max(1, ...snap.buckets.map((bucket, index) => bucket.count + field.buckets[index].count));
    const rows = snap.buckets.map((bucket, index) => {
        const fieldBucket = field.buckets[index];
        const combined = bucket.count + fieldBucket.count;
        const pct = total ? Math.round(combined / total * 100) : null;
        const barColor = index >= 3 ? '#b91c1c' : index >= 2 ? '#ea580c' : '#2563eb';
        return `<tr><td style="${td()}font-weight:700">${escapeHtml(bucket.label)}</td><td style="${td()}">${bar(combined, maxCombined, barColor)}</td><td align="right" style="${td()}">${dash(bucket.count)}</td><td align="right" style="${td()}">${dash(fieldBucket.count)}</td><td align="right" style="${td()}font-weight:800">${dash(combined)}</td><td align="right" style="${td()}">${pctLabel(pct)}</td></tr>`;
    }).join('');
    const unknown = snap.unknownAge + field.unknownAge;
    const unknownRow = unknown ? `<tr><td style="${td()}color:#64748b">Age unknown (no order date)</td><td style="${td()}"></td><td align="right" style="${td()}">${dash(snap.unknownAge)}</td><td align="right" style="${td()}">${dash(field.unknownAge)}</td><td align="right" style="${td()}font-weight:800">${unknown}</td><td align="right" style="${td()}">${pctLabel(total ? Math.round(unknown / total * 100) : null)}</td></tr>` : '';
    return `${sectionTitle('Aging distribution', 'Currently assigned work bucketed by order age (order date, falling back to creation date). Unowned stages are excluded.')}
    <tr><td style="padding:0 28px 18px"><table class="detail-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#f7f9fc"><th align="left" style="${lightTh()}">Order age</th><th align="left" style="${lightTh()}width:170px"></th><th align="right" style="${lightTh()}">Factory SNAP</th><th align="right" style="${lightTh()}">Field Service</th><th align="right" style="${lightTh()}">Total</th><th align="right" style="${lightTh()}">% of assigned</th></tr>${rows}${unknownRow}</table></td></tr>`;
}

function renderDailySummary(data) {
    const { result, shipments, openSummary } = data;
    const critical = openSummary.snap.critical + openSummary.fieldService.critical;
    const high = openSummary.snap.high + openSummary.fieldService.high;
    return `${sectionTitle('At a glance', 'Open workload now · shipment totals through yesterday')}
    <tr><td style="padding:0 24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${metric('Open order lines', result.executive.currentOpenOrders, `${result.executive.snapOpen} SNAP · ${result.executive.fieldOpen} Field`, '#2563eb', '25%')}
      ${metric('Shipped · last 7 days', shipments.total.last7, `${signed(shipments.total.change)} vs previous 7 days`, '#15803d', '25%')}
      ${metric('Waiting over 24h', result.executive.waiting, 'Assigned lines without recent action', '#b91c1c', '25%')}
      ${metric('Priority lines', critical + high, `${critical} Critical · ${high} High`, '#b45309', '25%')}
    </tr></table></td></tr>`;
}

function renderShipmentChart(summary, allShipments, color) {
    const max = Math.max(1, ...summary.days.map(day => day.count));
    const bars = summary.days.map(day => {
        const height = day.count ? Math.max(3, Math.round(day.count / max * 100)) : 0;
        return `<td width="7.14%" align="center" valign="bottom" style="padding:0 3px">
          <div style="font-size:12px;font-weight:800;color:#172033;padding-bottom:5px">${day.count}</div>
          <table role="presentation" width="70%" cellpadding="0" cellspacing="0"><tr><td height="${height || 1}" bgcolor="${day.count ? color : '#cbd5e1'}" style="font-size:0;line-height:0">&nbsp;</td></tr></table>
        </td>`;
    }).join('');
    const labels = summary.days.map(day => `<td class="chart-label" align="center" style="padding:6px 0;font-size:10px;color:#475569">${weekLabel(day.date)}</td>`).join('');
    const change = summary.previous7 === 0
        ? (summary.last7 ? `${summary.last7} shipped, up from 0 in the previous 7 days` : 'No shipments in either 7-day period')
        : `${summary.change > 0 ? 'Up' : summary.change < 0 ? 'Down' : 'Unchanged'} ${Math.abs(summary.change)}${summary.change ? ` (${Math.abs(summary.changePct)}%)` : ''} vs previous 7 days`;
    return `${sectionTitle('Shipped per day — past 14 days', `${weekLabel(summary.days[0].date)}–${weekLabel(allShipments.end)} · completed days · each bar counts shipped order lines`)}
    <tr><td style="padding:0 28px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed;background:#f8fafc"><tr><td style="padding:16px">
      <div style="font-size:15px;font-weight:800;color:${color};margin-bottom:12px">${escapeHtml(change)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr height="130">${bars}</tr><tr>${labels}</tr></table>
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid #dce3ed;font-size:13px;color:#334155"><b>${summary.last7}</b> last 7 days &nbsp; · &nbsp; <b>${summary.last14}</b> last 14 days &nbsp; · &nbsp; <b>${summary.last30}</b> last 30 days &nbsp; | &nbsp; Today so far: <b>${summary.today}</b></div>
    </td></tr></table></td></tr>`;
}

function renderPopulation(title, color, background, population, userNames, shipments, open, allShipments) {
    const totals = population.totals;
    // Scorecard credits the person who made the change, not the department that
    // owned the stage — queue accountability lives in the owner detail tables.
    const rows = filterActorRows(population.actorRows, config.EXCLUDED_ACTOR_IDS)
        .map(row => [userNames.get(row.userId) || `User ${row.userId}`, row])
        .sort((a, b) => b[1].actioned - a[1].actioned || b[1].handedOff - a[1].handedOff || a[0].localeCompare(b[0]));
    const maxActioned = Math.max(0, ...rows.map(([, row]) => row.actioned));
    const maxValue = Math.max(1, ...rows.map(([, row]) => Math.max(row.actioned, row.handedOff)));
    const body = rows.map(([name, row]) =>
        scoreRow(name, row, maxActioned > 0 && row.actioned === maxActioned, maxValue)).join('');
    return `<tr><td style="padding:20px 28px 13px;background:${background};border-top:5px solid ${color}">
      <div style="font-size:20px;font-weight:800">${escapeHtml(title)}</div><div style="margin-top:6px;font-size:13px;color:#526078">${title.includes('Field') ? `${open.types.missingParts} Missing Parts · ${open.types.warranty} Warranty · ${open.types.other} Other / mixed · ` : ''}${open.total} open lines</div><div style="margin-top:5px;font-size:12px;color:#526078">Open lines added by order date: ${open.new7} in the last 7 days · ${open.new30} in the last 30 days</div>
    </td></tr>
    <tr><td style="padding:14px 24px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${metric('Current open', population.currentOpen, `${population.informationalOpen} unowned (supplier / awaiting full order)`, color, '33.33%')}
      ${metric('Waiting >24h', totals.waiting, `${pctLabel(totals.waitingPct)} of assigned`, totals.waiting ? '#b91c1c' : '#64748b', '33.33%')}
      ${metric('Shipped · last 7 days', shipments.last7, 'Through yesterday', '#15803d', '33.33%')}
    </tr></table></td></tr>
    ${renderShipmentChart(shipments, allShipments, color)}
    ${sectionTitle('Who moved work — last 7 days', 'Actioned = lines a person changed. Handed off = lines they moved onward. Each line counts once per person. ★ marks the most lines actioned. Automated updates are excluded.')}
    <tr><td style="padding:0 28px 20px"><table class="detail-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed">
      <tr style="background:#12213f"><th align="left" style="${th()}">Person</th><th align="right" style="${th()}width:60px">Actioned</th><th class="score-bar" align="left" style="${th()}width:160px"></th><th align="right" style="${th()}width:70px">Handed off</th><th class="score-bar" align="left" style="${th()}width:160px"></th></tr>
      ${body || emptyRow(5, 'No matching owner activity.')}
    </table></td></tr>`;
}

function scoreRow(owner, row, isTop, maxValue) {
    const highlight = isTop ? 'background:#ecfdf5;' : '';
    const badge = isTop ? ' <span style="font-size:10px;font-weight:800;color:#047857;letter-spacing:.5px">★ TOP MOVER</span>' : '';
    return `<tr${isTop ? ' bgcolor="#ecfdf5"' : ''}><td style="${td()}${highlight}font-weight:700">${escapeHtml(owner)}${badge}</td><td align="right" style="${td()}${highlight}font-weight:800;font-size:14px;color:#15803d">${dash(row.actioned)}</td><td class="score-bar" style="${td()}${highlight}">${bar(row.actioned, maxValue, '#15803d')}</td><td align="right" style="${td()}${highlight}font-weight:800;font-size:14px;color:#0369a1">${dash(row.handedOff)}</td><td class="score-bar" style="${td()}${highlight}">${bar(row.handedOff, maxValue, '#0369a1')}</td></tr>`;
}

// Outlook's Word renderer ignores CSS widths on divs but honors width/bgcolor
// attributes on table cells, so bars are rendered as single-cell tables.
function bar(value, max, color, maxPx = 140) {
    if (!value) return '';
    const px = Math.max(3, Math.round(value / max * maxPx));
    return `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="${px}" height="10" bgcolor="${color}" style="font-size:0;line-height:0">&nbsp;</td></tr></table>`;
}

function renderOwnerTrend(trend) {
    const subtitle = 'Lines each person changed in each 7-day window. Darker cells mean more activity. Historical columns end on the dates shown; the latest window may overlap.';
    if (trend.weeksAvailable < config.TREND_MIN_WEEKS) {
        return `${sectionTitle('Activity trend by person', subtitle)}
        <tr><td style="padding:0 28px 18px"><div style="padding:11px 14px;background:#f8fafc;border:1px dashed #cbd5e1;color:#64748b;font-size:12px">The per-person weekly trend will appear here once at least ${config.TREND_MIN_WEEKS} weeks of history have accrued (currently ${trend.weeksAvailable}). Weekly history is stored on Mondays. Earlier totals without item-level evidence are omitted so excluded items cannot remain in the chart.</div></td></tr>`;
    }
    // The rightmost column is the live window, not a stored Monday snapshot,
    // so label it plainly rather than with a confusing mid-week date.
    const headers = trend.weekKeys.map((key, index) => {
        const label = index === trend.weekKeys.length - 1 ? 'Last 7 days' : `to ${weekLabel(key)}`;
        return `<th align="center" style="${lightTh()}">${escapeHtml(label)}</th>`;
    }).join('');
    const body = trend.owners.map(row => {
        const cells = row.counts.map(count => {
            const [background, color] = heatColors(count, trend.maxCount);
            return `<td align="center" bgcolor="${background}" style="${td()}background:${background};color:${color};font-weight:800">${count || '·'}</td>`;
        }).join('');
        return `<tr><td style="${td()}font-weight:700">${escapeHtml(row.owner)}</td>${cells}</tr>`;
    }).join('');
    return `${sectionTitle('Activity trend by person', subtitle)}
    <tr><td style="padding:0 28px 18px"><table class="detail-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#f7f9fc"><th align="left" style="${lightTh()}">Person</th>${headers}</tr>${body || emptyRow(trend.weekKeys.length + 1, 'No owner activity recorded yet.')}</table></td></tr>`;
}

function heatColors(count, max) {
    if (!count) return ['#ffffff', '#94a3b8'];
    const step = Math.min(3, Math.ceil(count / Math.max(1, max) * 3));
    return [['#ccfbf1', '#115e59'], ['#5eead4', '#134e4a'], ['#0d9488', '#ffffff']][step - 1];
}

function weekLabel(key) {
    const match = String(key).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${Number(match[2])}/${Number(match[3])}` : String(key);
}

function renderOwnerDetail(label, population) {
    const rows = Object.entries(population.rows).filter(([, row]) => row.current > 0)
        .sort((a, b) => b[1].waiting - a[1].waiting || b[1].current - a[1].current);
    const body = rows.map(([owner, row]) => {
        const wait = row.medianWaitHours === null ? '—' : `${row.medianWaitLowerBound ? '≥' : ''}${formatDuration(row.medianWaitHours)}`;
        return `<tr><td style="${td()}font-weight:700">${escapeHtml(owner)}</td><td align="right" style="${td()}">${row.current}</td><td align="right" style="${td()}font-weight:800;color:${row.waiting ? '#b91c1c' : '#64748b'}">${row.waiting}</td><td align="right" style="${td()}">${wait}</td><td align="right" style="${td()}">${row.oldestOrderAgeDays === null ? '—' : `${row.oldestOrderAgeDays}d`}</td></tr>`;
    }).join('');
    return `${sectionTitle(`Department queue health — ${label}`, 'Who owns the open work. Typical wait is the median time since the last qualifying human action; ≥ means at least.')}
    <tr><td style="padding:0 28px 18px"><table class="detail-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#f7f9fc"><th align="left" style="${lightTh()}">Owner</th><th align="right" style="${lightTh()}">Open</th><th align="right" style="${lightTh()}">Waiting &gt;24h</th><th align="right" style="${lightTh()}">Typical wait</th><th align="right" style="${lightTh()}">Oldest order</th></tr>${body || emptyRow(5, 'No current assignments.')}</table></td></tr>`;
}
function metric(label, value, note, color, width = '20%') { return `<td class="metric" width="${width}" valign="top" style="padding:4px"><div style="padding:13px 12px;border:1px solid #dce3ed;border-top:4px solid ${color}"><div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#64748b">${escapeHtml(label)}</div><div style="font-size:25px;font-weight:800;margin:4px 0">${value}</div><div style="font-size:10px;color:#64748b">${escapeHtml(note)}</div></div></td>`; }
function sectionTitle(title, subtitle) { return `<tr><td style="padding:17px 28px 9px"><div style="font-size:17px;font-weight:800">${escapeHtml(title)}</div><div style="font-size:11px;color:#64748b;margin-top:3px">${escapeHtml(subtitle)}</div></td></tr>`; }
function th() { return 'padding:9px 8px;color:#fff;font-size:10px;text-transform:uppercase;'; }
function lightTh() { return 'padding:8px 9px;color:#64748b;font-size:10px;text-transform:uppercase;'; }
function td() { return 'padding:8px 9px;border-top:1px solid #e5eaf1;font-size:11px;'; }
function emptyRow(columns, text) { return `<tr><td colspan="${columns}" align="center" style="padding:14px;color:#64748b;font-size:12px">${escapeHtml(text)}</td></tr>`; }
function dash(value) { return value || '—'; }
function signed(value) { return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0'; }
function pctLabel(value) { return value === null || value === undefined ? '—' : `${value}%`; }
function formatDuration(hours) { return hours >= 48 ? `${Math.floor(hours / 24)}d` : `${Math.floor(hours)}h`; }

function saveHtml(html, now, send) {
    const directory = path.join(__dirname, 'exports');
    fs.mkdirSync(directory, { recursive: true });
    const outputPath = path.join(directory, `dynamic-owner-activity-${send ? 'report' : 'preview'}-${now.toISOString().slice(0, 10)}.html`);
    fs.writeFileSync(outputPath, html, 'utf8');
    return outputPath;
}

async function sendEmail(html, now) {
    const recipients = deliveryRecipients();
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
    if (!tokenResponse.ok) throw new Error(`Microsoft Graph token request failed (${tokenResponse.status}): ${await tokenResponse.text()}`);
    const { access_token: accessToken } = await tokenResponse.json();
    const mailResponse = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.M365_SENDER_UPN)}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: {
                subject: `Open Order Workflow Movement Report ${formatSubjectDate(now)}`,
                body: { contentType: 'HTML', content: html },
                toRecipients: recipients.map(address => ({ emailAddress: { address } }))
            },
            saveToSentItems: true
        })
    });
    if (!mailResponse.ok) throw new Error(`Microsoft Graph sendMail failed (${mailResponse.status}): ${await mailResponse.text()}`);
    console.log(`Email sent via Microsoft Graph to ${recipients.join(', ')}.`);
}

function logSummary(result, items, events, rawLogs, outputPath, send, dryRun, userNames) {
    console.log(`Loaded ${items.length} attributable items, ${rawLogs} board activity records, and ${events.length} qualifying events.`);
    for (const [key, label] of [['snap', 'Factory SNAP'], ['fieldService', 'Field Service']]) {
        const population = result.populations[key];
        const people = filterActorRows(population.actorRows, config.EXCLUDED_ACTOR_IDS);
        const topMover = people.length ? `${userNames.get(people[0].userId) || people[0].userId} (${people[0].actioned})` : 'none';
        console.log(`${label}: ${population.currentOpen} current; ${population.totals.actioned} owner-item pairs actioned; ${population.totals.waiting} waiting >24h; ${population.totals.handedOff} handed off; net flow ${population.totals.netFlow}; ${population.closedOrders} closed; top mover (person): ${topMover}.`);
    }
    console.log(`People with qualifying activity: ${result.actorRows.length}; orders touched: ${result.distinctItemsWithActivity}.`);
    console.log(`Critical lines open: ${result.critical.openCritical}; avg age ${result.critical.avgAgeDays ?? '—'}d; top holders: ${result.critical.topHolders.map(entry => `${entry.owner} (${entry.count})`).join(', ') || 'none'}.`);
    console.log(`Closure: ${result.closure.closedCount} closed this period; avg closure ${result.closure.avgClosureDays ?? '—'}d over ${result.closure.measuredCount} measurable.`);
    const priorityLabels = [...new Set(items.map(item => item.priority).filter(Boolean))].sort();
    console.log(`Priority labels on board: ${priorityLabels.join(', ') || 'none'} (critical regex: ${config.CRITICAL_PRIORITY_REGEX}).`);
    console.log(`Dynamic-owner ${send ? 'report' : 'preview'} saved: ${outputPath}`);
    if (!send || dryRun) console.log(`${dryRun ? 'Dry run' : 'Preview only'}: no email was sent and no Redis/report history was changed.`);
}

function parseMondayDate(value) { const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], 12)) : null; }
function parseDate(value) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date : null; }
function daysBetween(start, end) { return start ? Math.max(0, Math.floor((end - start) / 86400000)) : null; }
function formatLongDate(date) { return new Intl.DateTimeFormat('en-US', { timeZone: config.TIME_ZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(date); }
function formatShortDate(date) { return new Intl.DateTimeFormat('en-US', { timeZone: config.TIME_ZONE, month: 'numeric', day: 'numeric', year: 'numeric' }).format(date); }
function formatSubjectDate(date) { return new Intl.DateTimeFormat('en-US', { timeZone: config.TIME_ZONE, month: '2-digit', day: '2-digit', year: 'numeric' }).format(date); }
function formatDateKey(date) { return new Intl.DateTimeFormat('en-CA', { timeZone: config.TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
function formatDateTime(date) { return new Intl.DateTimeFormat('en-US', { timeZone: config.TIME_ZONE, month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date); }
function splitRecipients(value) { return [...new Set(String(value || '').split(/[;,]/).map(entry => entry.trim().toLowerCase()).filter(Boolean))]; }
function deliveryRecipients() {
    const recipients = splitRecipients(process.env.MOVEMENT_REPORT_TO_EMAIL || (process.env.RENDER === 'true' ? '' : config.DEFAULT_RECIPIENT));
    if (!recipients.length || recipients.some(address => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) {
        throw new Error('MOVEMENT_REPORT_TO_EMAIL must contain valid recipient addresses.');
    }
    return recipients;
}
function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

if (require.main === module) {
    generateReport().catch(error => { console.error(`Fatal error: ${error.message}`); process.exitCode = 1; });
}

module.exports = { renderBottleneck, renderHtml, renderShipmentChart, mapItem, fetchBoardActivity, generateReport };
