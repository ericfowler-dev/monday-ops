require('dotenv').config();

const fs = require('fs');
const path = require('path');
const config = require('./weekly-movement-report.config');
const { normalizeBoardActivityLogs, computeDynamicOwnerActivity, buildWeeklySnapshot, buildActionedTrend, filterActorRows } = require('./dynamic-owner-activity-core');
const { pruneWeeks, ownerFor } = require('./weekly-movement-core');
const { createHistoryStore } = require('./dynamic-owner-history-store');

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
    const deliveryMode = args.has('--send') || process.env.SEND_EMAIL === '1';
    const dryRun = args.has('--dry-run') || process.env.DRY_RUN === '1';
    const now = new Date();
    if (shouldSkipRenderDstCompanionRun(now, deliveryMode)) return;
    const fromDate = new Date(now.getTime() - WINDOW_DAYS * 86400000);
    console.log(`Building dynamic-owner ${deliveryMode ? 'report' : 'preview'} for ${fromDate.toISOString()} through ${now.toISOString()}...`);

    const [currentRawItems, rawLogs] = await Promise.all([
        fetchCurrentRelevantItems(),
        fetchBoardActivity(fromDate, now)
    ]);
    const allEvents = normalizeBoardActivityLogs(rawLogs, QUALIFYING_COLUMNS);
    const relevantGroups = new Set([config.SNAP_GROUP_ID, config.FIELD_SERVICE_GROUP_ID]);
    const knownIds = new Set(currentRawItems.map(item => String(item.id)));
    const historicalCandidateIds = [...new Set(allEvents
        .filter(event => relevantGroups.has(event.groupId)
            || relevantGroups.has(event.sourceGroupId)
            || relevantGroups.has(event.destinationGroupId))
        .map(event => event.itemId)
        .filter(id => !knownIds.has(id)))];
    const recoveredRawItems = await fetchItemsById(historicalCandidateIds);
    const items = [...currentRawItems, ...recoveredRawItems].map(raw => mapItem(raw, now));
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

    const historyWeeks = await readHistoryWeeks();
    const html = renderHtml({
        now,
        fromDate,
        result,
        events,
        items,
        userNames,
        historyWeeks,
        currentWeekKey: formatDateKey(now),
        send: deliveryMode,
        activityLimitReached: rawLogs.length >= ACTIVITY_LIMIT,
        rawLogCount: rawLogs.length
    });
    const outputPath = saveHtml(html, now, deliveryMode);
    if (deliveryMode && !dryRun) {
        await sendEmail(html, now);
        if (isSnapshotDay(now)) {
            await persistSnapshot(result, items, now, userNames);
        } else {
            console.log(`Off-schedule run (${config.TIME_ZONE} weekday is not the scheduled day): email sent, weekly snapshot skipped so test runs never pollute trend history.`);
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

function shouldSkipRenderDstCompanionRun(now, send) {
    if (!send || process.env.RENDER !== 'true') return false;
    const isScheduledWindow = now.getUTCDay() === 1 && [10, 11].includes(now.getUTCHours());
    if (!isScheduledWindow) return false; // Render Trigger Run outside the cron window is a manual run.
    const centralHour = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: config.TIME_ZONE,
        hour: '2-digit',
        hourCycle: 'h23'
    }).format(now));
    if (centralHour === config.SCHEDULE_HOUR) return false;
    console.log(`Skipping DST companion run: current ${config.TIME_ZONE} hour is ${centralHour}; target is ${config.SCHEDULE_HOUR}.`);
    return true;
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

async function fetchBoardActivity(fromDate, toDate) {
    const data = await mondayQuery(`query ($boardIds: [ID!], $from: ISO8601DateTime!, $to: ISO8601DateTime!) {
        boards(ids: $boardIds) {
            activity_logs(from: $from, to: $to, limit: ${ACTIVITY_LIMIT}) { id event data created_at user_id }
        }
    }`, { boardIds: [config.BOARD_ID], from: fromDate.toISOString(), to: toDate.toISOString() });
    return data.boards[0]?.activity_logs || [];
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
        isOpen: raw.state === 'active' && !isClosed,
        url: `https://${config.MONDAY_SLUG}.monday.com/boards/${config.BOARD_ID}/pulses/${raw.id}`
    };
}

function renderHtml(data) {
    const { result, now, fromDate } = data;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <style>body,table,td,th,div,h1,h2,a,span{font-family:${FONT}!important} @media(max-width:760px){.metric{display:block!important;width:auto!important}.shell{width:100%!important}}</style></head>
    <body style="margin:0;background:#eef2f7;color:#172033"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 10px">
    <table class="shell" role="presentation" width="1120" cellpadding="0" cellspacing="0" style="width:1120px;max-width:100%;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.08)">
      <tr><td style="padding:30px 34px;background:#12213f;color:#fff;border-bottom:6px solid #14b8a6">
        <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#99f6e4">${data.send ? 'Weekly report' : 'Preview'} · dynamic ownership</div>
        <h1 style="margin:7px 0 5px;font-size:29px;line-height:35px">Open Order Workflow Movement Report</h1>
        <div style="font-size:13px;color:#dbeafe">Reporting period ${escapeHtml(formatShortDate(fromDate))}–${escapeHtml(formatShortDate(now))} (prior 7 days) · Generated ${escapeHtml(formatLongDate(now))}, ${escapeHtml(formatDateTime(now))}</div>
      </td></tr>
      ${renderDataQuality(result, data)}
      ${renderExecutiveSummary(result.executive)}
      ${renderHighlights(result.critical, result.closure)}
      ${renderPopulation('Part 1 — Factory SNAP orders', '#2563eb', '#eff6ff', result.populations.snap, data.userNames)}
      ${renderPopulation('Part 2 — Field Service orders', '#0f766e', '#f0fdfa', result.populations.fieldService, data.userNames)}
      ${renderOwnerTrend(buildActionedTrend({
          historyWeeks: data.historyWeeks,
          currentWeekKey: data.currentWeekKey,
          currentResult: result,
          maxWeeks: config.TREND_MAX_WEEKS,
          snapshotWeekday: config.SCHEDULE_WEEKDAY,
          userNames: data.userNames,
          excludedActorIds: config.EXCLUDED_ACTOR_IDS
      }))}
      ${renderBottleneck(result.populations)}
      ${renderAgingBuckets(result.populations)}
      ${renderOwnerDetail('Factory SNAP', result.populations.snap)}
      ${renderOwnerDetail('Field Service', result.populations.fieldService)}
      <tr><td style="padding:19px 28px;background:#e8eef8;color:#475569;font-size:11px;line-height:17px">
        <b>How to read this report:</b> Owner metrics count distinct owner–item relationships (owner–item pairs), so one order can credit two owners after a handoff; “Current open” counts unique orders. Credit follows the accountable department owner — status, fulfillment, supplier, and shipping changes qualify, cosmetic edits do not. “Waiting” means no qualifying action for 24+ hours; durations marked “≥” are lower bounds because the report reads seven days of history. Click any order name to open it in monday.com.${data.send ? '' : ' Preview only: no email was sent and no history was stored.'}
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
        [`Activity API limit reached (${data.rawLogCount.toLocaleString()} records returned; data may be incomplete)`, data.activityLimitReached ? 1 : 0]
    ].filter(([, count]) => count > 0);
    if (!entries.length) {
        return `<tr><td style="padding:14px 28px 4px"><div style="padding:10px 13px;background:#f0fdf4;border:1px solid #86efac;color:#166534;font-size:12px"><b>Data quality:</b> no unmapped owners, unresolved users, or data gaps detected this period.</div></td></tr>`;
    }
    const rows = entries.map(([label, count]) => `<li style="margin:2px 0">${escapeHtml(label)}: <b>${count === 1 && label.startsWith('Activity API') ? 'yes' : count}</b></li>`).join('');
    return `<tr><td style="padding:14px 28px 4px"><div style="padding:11px 14px;background:#fff7ed;border:1px solid #fdba74;color:#9a3412;font-size:12px;line-height:18px"><b>Data quality warning</b> — treat affected figures with care; unmapped or unresolved entries are not individual performance results.<ul style="margin:6px 0 0;padding-left:18px">${rows}</ul></div></td></tr>`;
}

function renderExecutiveSummary(executive) {
    const netColor = executive.netFlow > 0 ? '#b91c1c' : executive.netFlow < 0 ? '#15803d' : '#64748b';
    return `${sectionTitle('Executive summary', 'Both workflow populations combined. Owner metrics count owner–item pairs; open and closed counts are unique orders.')}
    <tr><td style="padding:0 24px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${metric('Current open', executive.currentOpenOrders, `${executive.snapOpen} SNAP · ${executive.fieldOpen} Field · ${executive.supplierWaiting} unowned stages`, '#2563eb', '16.66%')}
      ${metric('Received', executive.received, 'owner–item pairs', '#7c3aed', '16.66%')}
      ${metric('Handed off', executive.movedOnward, 'owner–item pairs', '#0369a1', '16.66%')}
      ${metric('Net flow', signed(executive.netFlow), 'received − handed off', netColor, '16.66%')}
      ${metric('Waiting >24h', executive.waiting, `${pctLabel(executive.waitingPct)} of assigned work`, executive.waiting ? '#b91c1c' : '#64748b', '16.66%')}
      ${metric('Activity coverage', pctLabel(executive.activityCoverage), 'assigned items with 7-day activity', '#15803d', '16.66%')}
    </tr></table></td></tr>`;
}

function renderBottleneck(populations) {
    const combined = [
        ...populations.snap.statusBottlenecks.map(row => ({ ...row, populationLabel: 'Factory SNAP' })),
        ...populations.fieldService.statusBottlenecks.map(row => ({ ...row, populationLabel: 'Field Service' }))
    ].sort((a, b) => b.waiting - a.waiting || b.currentCount - a.currentCount || a.status.localeCompare(b.status))
        .slice(0, 6);
    const rows = combined.map(row => {
        const median = row.medianSinceActivityHours === null ? '—' : `${row.medianLowerBound ? '≥' : ''}${formatDuration(row.medianSinceActivityHours)}`;
        return `<tr><td style="${td()}font-weight:700">${escapeHtml(row.status)}</td><td style="${td()}">${escapeHtml(row.populationLabel)}</td><td align="right" style="${td()}">${row.currentCount}</td><td align="right" style="${td()}font-weight:800;color:${row.waiting ? '#b91c1c' : '#94a3b8'}">${dash(row.waiting)}</td><td align="right" style="${td()}">${pctLabel(row.waitingPct)}</td><td align="right" style="${td()}">${median}</td><td align="right" style="${td()}">${row.oldestAgeDays === null ? '—' : `${row.oldestAgeDays}d`}</td><td align="center" style="${td()}">${row.supplierWaiting ? 'Yes' : '—'}</td></tr>`;
    }).join('');
    return `${sectionTitle('Where work is stuck', 'Top workflow statuses by waiting count (top 6 shown). Unowned stages (Ordered from Supplier, Awaiting Full Order) carry no owner, so waiting stats do not apply.')}
    <tr><td style="padding:0 28px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#12213f"><th align="left" style="${th()}">Status</th><th align="left" style="${th()}">Population</th><th align="right" style="${th()}">Current</th><th align="right" style="${th()}">Waiting &gt;24h</th><th align="right" style="${th()}">Waiting %</th><th align="right" style="${th()}">Median since activity</th><th align="right" style="${th()}">Oldest (age)</th><th align="center" style="${th()}">Supplier</th></tr>${rows || emptyRow(8, 'No current open work.')}</table></td></tr>`;
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
    <tr><td style="padding:0 28px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#f7f9fc"><th align="left" style="${lightTh()}">Order age</th><th align="left" style="${lightTh()}width:170px"></th><th align="right" style="${lightTh()}">Factory SNAP</th><th align="right" style="${lightTh()}">Field Service</th><th align="right" style="${lightTh()}">Total</th><th align="right" style="${lightTh()}">% of assigned</th></tr>${rows}${unknownRow}</table></td></tr>`;
}

function renderHighlights(critical, closure) {
    const holders = critical.topHolders;
    const holderNote = holders.length
        ? `${holders.map(entry => entry.owner).join(' · ')} (${holders[0].count} line${holders[0].count === 1 ? '' : 's'} each)`
        : 'no open critical lines';
    return `${sectionTitle('This week’s highlights', 'Critical lines carry a Critical priority on the board. Closure time is Date Shipped minus Order Date for orders closed this period.')}
    <tr><td style="padding:0 24px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${metric('Critical lines open', critical.openCritical, `${critical.perPopulation.snap} SNAP · ${critical.perPopulation.fieldService} Field Service`, critical.openCritical ? '#b91c1c' : '#64748b', '25%')}
      ${metric('Avg critical age', critical.avgAgeDays === null ? '—' : `${critical.avgAgeDays}d`, critical.openCritical ? `across ${critical.agedCount} critical line${critical.agedCount === 1 ? '' : 's'} with dates` : 'no open critical lines', critical.openCritical ? '#ea580c' : '#64748b', '25%')}
      ${metric('Most critical lines held', holders.length ? holders[0].count : '—', holderNote, holders.length ? '#b91c1c' : '#64748b', '25%')}
      ${metric('Avg shipment closure', closure.avgClosureDays === null ? '—' : `${closure.avgClosureDays}d`, `${closure.measuredCount} of ${closure.closedCount} closed order${closure.closedCount === 1 ? '' : 's'} measurable`, '#15803d', '25%')}
    </tr></table></td></tr>`;
}

function renderPopulation(title, color, background, population, userNames) {
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
      <div style="font-size:20px;font-weight:800">${escapeHtml(title)}</div><div style="margin-top:4px;font-size:12px;color:#526078">Who moved work this week, and how each department's queue is holding up</div>
    </td></tr>
    <tr><td style="padding:14px 24px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${metric('Current open', population.currentOpen, `${population.informationalOpen} unowned (supplier / awaiting full order)`, color)}
      ${metric('Received', totals.received, 'owner–item pairs', '#7c3aed')}
      ${metric('Handed off', totals.handedOff, 'owner–item pairs', '#0369a1')}
      ${metric('Waiting >24h', totals.waiting, `${pctLabel(totals.waitingPct)} of assigned`, totals.waiting ? '#b91c1c' : '#64748b')}
      ${metric('Closed / shipped', population.closedOrders, 'this period', '#15803d')}
    </tr></table></td></tr>
    ${sectionTitle('Who moved work this week', 'Counts the person who actually made the change, as distinct orders. Actioned = orders they changed; Handed off = orders they moved to the next stage. ★ marks the top mover. Automated board updates are excluded.')}
    <tr><td style="padding:0 28px 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed">
      <tr style="background:#12213f"><th align="left" style="${th()}">Person</th><th align="right" style="${th()}width:60px">Actioned</th><th align="left" style="${th()}width:160px"></th><th align="right" style="${th()}width:70px">Handed off</th><th align="left" style="${th()}width:160px"></th></tr>
      ${body || emptyRow(5, 'No matching owner activity.')}
    </table></td></tr>`;
}

function scoreRow(owner, row, isTop, maxValue) {
    const highlight = isTop ? 'background:#ecfdf5;' : '';
    const badge = isTop ? ' <span style="font-size:10px;font-weight:800;color:#047857;letter-spacing:.5px">★ TOP MOVER</span>' : '';
    return `<tr${isTop ? ' bgcolor="#ecfdf5"' : ''}><td style="${td()}${highlight}font-weight:700">${escapeHtml(owner)}${badge}</td><td align="right" style="${td()}${highlight}font-weight:800;font-size:14px;color:#15803d">${dash(row.actioned)}</td><td style="${td()}${highlight}">${bar(row.actioned, maxValue, '#15803d')}</td><td align="right" style="${td()}${highlight}font-weight:800;font-size:14px;color:#0369a1">${dash(row.handedOff)}</td><td style="${td()}${highlight}">${bar(row.handedOff, maxValue, '#0369a1')}</td></tr>`;
}

// Outlook's Word renderer ignores CSS widths on divs but honors width/bgcolor
// attributes on table cells, so bars are rendered as single-cell tables.
function bar(value, max, color, maxPx = 140) {
    if (!value) return '';
    const px = Math.max(3, Math.round(value / max * maxPx));
    return `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="${px}" height="10" bgcolor="${color}" style="font-size:0;line-height:0">&nbsp;</td></tr></table>`;
}

function renderOwnerTrend(trend) {
    const subtitle = 'Orders each person changed per week, both populations combined. Darker cells mean more orders.';
    if (trend.weeksAvailable < config.TREND_MIN_WEEKS) {
        return `${sectionTitle('Weekly actioned trend', subtitle)}
        <tr><td style="padding:0 28px 18px"><div style="padding:11px 14px;background:#f8fafc;border:1px dashed #cbd5e1;color:#64748b;font-size:12px">The per-person weekly trend will appear here once at least ${config.TREND_MIN_WEEKS} weeks of history have accrued (currently ${trend.weeksAvailable}). History is stored each time the report is delivered.</div></td></tr>`;
    }
    // The rightmost column is the live window, not a stored Monday snapshot,
    // so label it plainly rather than with a confusing mid-week date.
    const headers = trend.weekKeys.map((key, index) => {
        const label = index === trend.weekKeys.length - 1 ? 'This week' : `wk ${weekLabel(key)}`;
        return `<th align="center" style="${lightTh()}">${escapeHtml(label)}</th>`;
    }).join('');
    const body = trend.owners.map(row => {
        const cells = row.counts.map(count => {
            const [background, color] = heatColors(count, trend.maxCount);
            return `<td align="center" bgcolor="${background}" style="${td()}background:${background};color:${color};font-weight:800">${count || '·'}</td>`;
        }).join('');
        return `<tr><td style="${td()}font-weight:700">${escapeHtml(row.owner)}</td>${cells}<td align="right" style="${td()}font-weight:800">${row.total}</td></tr>`;
    }).join('');
    return `${sectionTitle('Weekly actioned trend', subtitle)}
    <tr><td style="padding:0 28px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#f7f9fc"><th align="left" style="${lightTh()}">Person</th>${headers}<th align="right" style="${lightTh()}">Total</th></tr>${body || emptyRow(trend.weekKeys.length + 2, 'No owner activity recorded yet.')}</table></td></tr>`;
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
    const rows = Object.entries(population.rows)
        .sort((a, b) => b[1].current - a[1].current || b[1].actioned - a[1].actioned || a[0].localeCompare(b[0]));
    const body = rows.map(([owner, row]) => {
        const median = row.medianWaitHours === null ? '—' : `${row.medianWaitLowerBound ? '≥' : ''}${formatDuration(row.medianWaitHours)}`;
        const dwell = row.medianDwellHours === null ? '—' : `${row.medianDwellLowerBound ? '≥' : ''}${formatDuration(row.medianDwellHours)}`;
        const oldest = row.oldestWaitingHours === null ? '—' : `${row.oldestWaitingLowerBound ? '≥' : ''}${formatDuration(row.oldestWaitingHours)}`;
        const oldestOrder = row.oldestOrderAgeDays === null
            ? '—'
            : `${row.oldestOrderAgeDays}d${row.oldestOrderDate ? `<div style="font-size:10px;color:#94a3b8">${escapeHtml(formatShortDate(new Date(row.oldestOrderDate)))}</div>` : ''}`;
        return `<tr><td style="${td()}font-weight:700">${escapeHtml(owner)}</td><td align="right" style="${td()}">${dash(row.current)}</td><td align="right" style="${td()}">${dash(row.received)}</td><td align="right" style="${td()}color:${row.netFlow > 0 ? '#b91c1c' : row.netFlow < 0 ? '#15803d' : '#94a3b8'}">${signed(row.netFlow)}</td><td align="right" style="${td()}font-weight:800;color:${row.waiting ? '#b91c1c' : '#94a3b8'}">${dash(row.waiting)}</td><td align="right" style="${td()}">${pctLabel(row.waitingPct)}</td><td align="right" style="${td()}">${median}</td><td align="right" style="${td()}">${dwell}</td><td align="right" style="${td()}">${oldest}</td><td align="right" style="${td()}font-weight:800;color:${row.oldestOrderAgeDays !== null && row.oldestOrderAgeDays > config.PAST_DUE_DAYS ? '#b91c1c' : '#172033'}">${oldestOrder}</td><td align="right" style="${td()}font-weight:800">${row.actionRate === null ? '—' : `${row.actionRate}%`}</td></tr>`;
    }).join('');
    return `${sectionTitle(`Department queue health — ${label}`, 'Load and ageing by the department that owns each stage, regardless of who last touched the order. Median dwell = typical time an order sat with the owner before hand-off this week (≥ means at least; limited by the 7-day window). Oldest order is true order age and is not window-limited.')}
    <tr><td style="padding:0 28px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#f7f9fc"><th align="left" style="${lightTh()}">Owner</th><th align="right" style="${lightTh()}">Current</th><th align="right" style="${lightTh()}">Received</th><th align="right" style="${lightTh()}">Net flow</th><th align="right" style="${lightTh()}">Waiting &gt;24h</th><th align="right" style="${lightTh()}">Waiting %</th><th align="right" style="${lightTh()}">Median wait</th><th align="right" style="${lightTh()}">Median dwell</th><th align="right" style="${lightTh()}">Oldest waiting</th><th align="right" style="${lightTh()}">Oldest order</th><th align="right" style="${lightTh()}">7-day activity</th></tr>${body || emptyRow(11, 'No owner assignments.')}</table></td></tr>`;
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
    const recipients = splitRecipients(process.env.MOVEMENT_REPORT_TO_EMAIL || config.DEFAULT_RECIPIENT);
    if (!recipients.length) throw new Error('No movement report recipients are configured.');
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
function splitRecipients(value) { return String(value || '').split(/[;,]/).map(entry => entry.trim()).filter(Boolean); }
function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

generateReport().catch(error => { console.error(`Fatal error: ${error.message}`); process.exitCode = 1; });
