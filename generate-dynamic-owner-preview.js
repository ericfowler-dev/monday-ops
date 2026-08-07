require('dotenv').config();

const fs = require('fs');
const path = require('path');
const config = require('./weekly-movement-report.config');
const { normalizeBoardActivityLogs, computeDynamicOwnerActivity } = require('./dynamic-owner-activity-core');

const MONDAY_API_VERSION = process.env.MONDAY_API_VERSION || '2026-07';
const WINDOW_DAYS = 7;
const WAITING_HOURS = 24;
const ACTIVITY_LIMIT = 10000;
const FONT = "'Segoe UI',Arial,sans-serif";

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

    const html = renderHtml({
        now,
        fromDate,
        result,
        events,
        items,
        userNames,
        send: deliveryMode,
        activityLimitReached: rawLogs.length >= ACTIVITY_LIMIT,
        rawLogCount: rawLogs.length
    });
    const outputPath = saveHtml(html, now, deliveryMode);
    if (deliveryMode && !dryRun) await sendEmail(html, now);
    logSummary(result, items, events, rawLogs.length, outputPath, deliveryMode, dryRun);
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
    const columnIds = [config.COL_IDS.ORDER_TYPE, config.COL_IDS.CURRENT_STATUS, config.COL_IDS.ORDER_DATE];
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
    const columnIds = [config.COL_IDS.ORDER_TYPE, config.COL_IDS.CURRENT_STATUS, config.COL_IDS.ORDER_DATE];
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
        ageDays: daysBetween(orderDate || createdAt, now),
        isOpen: raw.state === 'active' && !isClosed,
        url: `https://${config.MONDAY_SLUG}.monday.com/boards/${config.BOARD_ID}/pulses/${raw.id}`
    };
}

function renderHtml(data) {
    const { result, now, fromDate } = data;
    const warnings = [
        data.activityLimitReached ? alert('Activity API limit reached', `Monday returned ${data.rawLogCount.toLocaleString()} records; this preview may be incomplete.`) : '',
        result.unavailableEventItems ? alert('Unavailable historical items', `${result.unavailableEventItems} item IDs could not be attributed because they are no longer retrievable.`) : ''
    ].filter(Boolean).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <style>body,table,td,th,div,h1,h2,a,span{font-family:${FONT}!important} @media(max-width:760px){.metric{display:block!important;width:auto!important}.shell{width:100%!important}}</style></head>
    <body style="margin:0;background:#eef2f7;color:#172033"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 10px">
    <table class="shell" role="presentation" width="1120" cellpadding="0" cellspacing="0" style="width:1120px;max-width:100%;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.08)">
      <tr><td style="padding:30px 34px;background:#12213f;color:#fff;border-bottom:6px solid #14b8a6">
        <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#99f6e4">${data.send ? 'Weekly report' : 'Preview v2'} · dynamic ownership</div>
        <h1 style="margin:7px 0 5px;font-size:29px;line-height:35px">Open Orders — Action &amp; Waiting Report</h1>
        <div style="font-size:13px;color:#dbeafe">${escapeHtml(formatLongDate(now))} · ${escapeHtml(formatShortDate(fromDate))}–${escapeHtml(formatShortDate(now))} · prior 7 days</div>
      </td></tr>
      <tr><td style="padding:20px 28px 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${principle('Accountability', 'Credit follows the department owner responsible when the action occurred.')}
        ${principle('Activity', 'Status, fulfillment, supplier, and shipping changes qualify—not cosmetic edits.')}
        ${principle('Exceptions', '“Waiting” means the current owner has had no qualifying action for 24+ hours.')}
      </tr></table></td></tr>
      ${warnings ? `<tr><td style="padding:6px 28px 10px">${warnings}</td></tr>` : ''}
      ${renderPopulation('Part 1 — Factory SNAP orders', '#2563eb', '#eff6ff', result.populations.snap)}
      ${renderPopulation('Part 2 — Field Service orders', '#0f766e', '#f0fdfa', result.populations.fieldService)}
      ${renderActorSection(result.actorRows, data.userNames)}
      ${data.send ? '' : renderRequestedExample(data.events, data.items, data.userNames, result.eventAttributions)}
      ${renderActivityEvidence(data.events, data.items, data.userNames, result.eventAttributions)}
      ${renderBreakdown(result.breakdownRows)}
      <tr><td style="padding:19px 28px;background:#e8eef8;color:#475569;font-size:11px;line-height:17px">
        <b>How totals work:</b> Owner metrics count distinct owner–item relationships, so one order can credit Dept A and Dept B after a handoff. A status transition credits the owner of the status being left; the destination owner receives the item. Draft-group activity appears under “Performed by” but creates no owner credit until the item enters SNAP or Field Service. “Waiting ≥7d” is a lower bound because this report reads seven days of history.${data.send ? '' : ' Preview only: no email or Redis history was changed.'}
      </td></tr>
    </table></td></tr></table></body></html>`;
}

function renderPopulation(title, color, background, population) {
    const rows = Object.entries(population.rows)
        .sort((a, b) => b[1].waiting - a[1].waiting || b[1].current - a[1].current || b[1].actioned - a[1].actioned || a[0].localeCompare(b[0]));
    const body = rows.map(([owner, row]) => ownerRow(owner, row)).join('');
    const totals = population.totals;
    return `<tr><td style="padding:20px 28px 13px;background:${background};border-top:5px solid ${color}">
      <div style="font-size:20px;font-weight:800">${escapeHtml(title)}</div><div style="margin-top:4px;font-size:12px;color:#526078">Current load plus activity credited to each owner during the reporting window</div>
    </td></tr>
    <tr><td style="padding:14px 24px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${metric('Current open', population.currentOpen, `${population.informationalOpen} supplier-waiting`, color)}
      ${metric('Owner actioned', totals.actioned, 'owner–item pairs', '#15803d')}
      ${metric('Received', totals.received, 'new assignments', '#7c3aed')}
      ${metric('Handed off', totals.handedOff, 'completed transitions', '#0369a1')}
      ${metric('Waiting >24h', totals.waiting, 'current exceptions', totals.waiting ? '#b91c1c' : '#64748b')}
    </tr></table></td></tr>
    ${sectionTitle('Owner scorecard', 'Actioned may overlap Waiting when an owner acted earlier in the week but the item has since gone quiet.')}
    <tr><td style="padding:0 28px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed">
      <tr style="background:#12213f"><th align="left" style="${th()}">Accountable owner</th><th align="right" style="${th()}">Current</th><th align="right" style="${th()}">Received</th><th align="right" style="${th()}">Actioned</th><th align="right" style="${th()}">Handed off</th><th align="right" style="${th()}">Waiting &gt;24h</th><th align="right" style="${th()}">Oldest waiting</th><th align="right" style="${th()}">Past 6 wks</th><th align="right" style="${th()}">% acted</th></tr>
      ${body || emptyRow(9, 'No matching owner activity.')}${body ? totalRow(totals) : ''}
    </table></td></tr>
    ${renderAttention(population.attention)}${renderHandoffs(population.handoffs)}`;
}

function ownerRow(owner, row) {
    const oldest = row.oldestWaitingHours === null ? '—' : `${row.oldestWaitingLowerBound ? '≥' : ''}${formatDuration(row.oldestWaitingHours)}`;
    return `<tr><td style="${td()}font-weight:700">${escapeHtml(owner)}</td><td align="right" style="${td()}">${dash(row.current)}</td><td align="right" style="${td()}">${dash(row.received)}</td><td align="right" style="${td()}font-weight:800;color:#15803d">${dash(row.actioned)}</td><td align="right" style="${td()}">${dash(row.handedOff)}</td><td align="right" style="${td()}font-weight:800;color:${row.waiting ? '#b91c1c' : '#94a3b8'}">${dash(row.waiting)}</td><td align="right" style="${td()}">${oldest}</td><td align="right" style="${td()}color:${row.past6w ? '#b91c1c' : '#94a3b8'}">${dash(row.past6w)}</td><td align="right" style="${td()}font-weight:800">${row.actionRate === null ? '—' : `${row.actionRate}%`}</td></tr>`;
}

function totalRow(row) {
    return `<tr style="background:#f7f9fc"><td style="${td()}font-weight:800">Total owner–item pairs</td><td align="right" style="${td()}font-weight:800">${row.current}</td><td align="right" style="${td()}font-weight:800">${row.received}</td><td align="right" style="${td()}font-weight:800">${row.actioned}</td><td align="right" style="${td()}font-weight:800">${row.handedOff}</td><td align="right" style="${td()}font-weight:800">${row.waiting}</td><td style="${td()}"></td><td align="right" style="${td()}font-weight:800">${row.past6w}</td><td align="right" style="${td()}font-weight:800">${row.actionRate === null ? '—' : `${row.actionRate}%`}</td></tr>`;
}

function renderAttention(items) {
    const rows = items.slice(0, 15).map(item => `<tr><td style="${td()}"><a href="${escapeHtml(item.url)}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${escapeHtml(item.name)}</a></td><td style="${td()}">${escapeHtml(item.owner)}</td><td style="${td()}">${escapeHtml(item.status)}</td><td align="right" style="${td()}font-weight:800;color:#b91c1c">${item.waitingLowerBound ? '≥' : ''}${formatDuration(item.waitingHours)}</td><td align="right" style="${td()}">${item.ageDays === null ? '—' : `${item.ageDays}d`}</td></tr>`).join('');
    return `${sectionTitle('Needs attention now', 'Current-owner exceptions sorted by longest time since qualifying action.')}
    <tr><td style="padding:0 28px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#f7f9fc"><th align="left" style="${lightTh()}">Order</th><th align="left" style="${lightTh()}">Current owner</th><th align="left" style="${lightTh()}">Current status</th><th align="right" style="${lightTh()}">Waiting</th><th align="right" style="${lightTh()}">Order age</th></tr>${rows || emptyRow(5, 'No items have been waiting more than 24 hours.')}</table></td></tr>`;
}

function renderHandoffs(handoffs) {
    const rows = handoffs.slice(0, 8).map(row => `<tr><td style="${td()}">${escapeHtml(row.source)}</td><td style="${td()}">→ ${escapeHtml(row.destination)}</td><td align="right" style="${td()}font-weight:800">${row.distinctItems}</td><td align="right" style="${td()}">${row.events}</td></tr>`).join('');
    return `${sectionTitle('Owner handoffs', 'The same order can create action credit for each owner who performs their part.')}
    <tr><td style="padding:0 28px 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#f7f9fc"><th align="left" style="${lightTh()}">From</th><th align="left" style="${lightTh()}">To</th><th align="right" style="${lightTh()}">Orders</th><th align="right" style="${lightTh()}">Transitions</th></tr>${rows || emptyRow(4, 'No owner handoffs in this window.')}</table></td></tr>`;
}

function renderActorSection(actorRows, names) {
    const rows = actorRows.slice(0, 20).map(row => `<tr><td style="${td()}font-weight:700">${escapeHtml(names.get(row.userId) || `User ${row.userId}`)}</td><td align="right" style="${td()}">${row.distinctItems}</td><td align="right" style="${td()}">${row.statusChanges}</td><td align="right" style="${td()}">${row.operationalEdits}</td><td align="right" style="${td()}">${row.groupMoves}</td><td align="right" style="${td()}font-weight:800">${row.events}</td></tr>`).join('');
    return `<tr><td style="padding:20px 28px 13px;background:#fff7ed;border-top:5px solid #ea580c"><div style="font-size:20px;font-weight:800">Performed by — activity evidence</div><div style="margin-top:4px;font-size:12px;color:#7c2d12">This identifies who made the change. It is deliberately separate from the accountable owner scorecard.</div></td></tr>
    <tr><td style="padding:18px 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#12213f"><th align="left" style="${th()}">Person</th><th align="right" style="${th()}">Orders touched</th><th align="right" style="${th()}">Status</th><th align="right" style="${th()}">Operational fields</th><th align="right" style="${th()}">Group moves</th><th align="right" style="${th()}">Events</th></tr>${rows || emptyRow(6, 'No qualifying activity.')}</table></td></tr>`;
}

function renderRequestedExample(events, items, names, attributions) {
    const target = items.find(item => item.name.toLowerCase().includes('201225-w3 replacement red lion'));
    if (!target) return '';
    const relevantEvents = events.filter(event => event.itemId === target.id).sort((a, b) => a.at - b.at);
    const attributionMap = new Map(attributions.map(row => [row.eventId, row]));
    const rows = relevantEvents.map(event => evidenceRow(event, target, names, attributionMap.get(event.id), false)).join('');
    const currentOwner = config.OWNER_MAP[target.status];
    const ownerLabel = typeof currentOwner === 'string'
        ? currentOwner
        : currentOwner && typeof currentOwner === 'object' ? currentOwner[target.population] : 'Informational / unmapped';
    return `<tr><td style="padding:20px 28px 13px;background:#fdf4ff;border-top:5px solid #a21caf"><div style="font-size:20px;font-weight:800">Requested example audit</div><div style="margin-top:4px;font-size:12px;color:#701a75">${escapeHtml(target.name)} · current group: ${escapeHtml(target.groupName)} · current status: ${escapeHtml(target.status)} · current owner: ${escapeHtml(ownerLabel)}</div></td></tr>
    <tr><td style="padding:18px 28px"><div style="font-size:12px;line-height:18px;color:#526078;margin-bottom:10px">Every qualifying event below counts for the person who performed it. The <b>Owner credit</b> column follows the accountable department at that moment; Draft activity intentionally has no department credit.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#12213f"><th align="left" style="${th()}">When</th><th align="left" style="${th()}">Performed by</th><th align="left" style="${th()}">Field</th><th align="left" style="${th()}">Change</th><th align="left" style="${th()}">Owner credit</th></tr>${rows || emptyRow(5, 'No qualifying activity for this item in the seven-day window.')}</table></td></tr>`;
}

function renderActivityEvidence(events, items, names, attributions) {
    const itemMap = new Map(items.map(item => [item.id, item]));
    const attributionMap = new Map(attributions.map(row => [row.eventId, row]));
    const rows = [...events].sort((a, b) => b.at - a.at).slice(0, 30)
        .map(event => evidenceRow(event, itemMap.get(event.itemId), names, attributionMap.get(event.id), true)).join('');
    return `${sectionTitle('Recent qualifying events', 'A concrete audit trail for validating how the report interprets Monday activity (latest 30 shown).')}
    <tr><td style="padding:0 28px 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#f7f9fc"><th align="left" style="${lightTh()}">When</th><th align="left" style="${lightTh()}">Order</th><th align="left" style="${lightTh()}">Performed by</th><th align="left" style="${lightTh()}">Field</th><th align="left" style="${lightTh()}">Change</th><th align="left" style="${lightTh()}">Owner credit</th></tr>${rows || emptyRow(6, 'No qualifying events.')}</table></td></tr>`;
}

function evidenceRow(event, item, names, attribution, showItem) {
    const action = event.type === 'status'
        ? `${event.previousStatus} → ${event.nextStatus}`
        : event.type === 'group_move'
            ? `${event.sourceGroupName || event.sourceGroupId || 'Outside'} → ${event.destinationGroupName || event.destinationGroupId || 'Outside'}`
            : `${event.previousValue || 'blank'} → ${event.nextValue || 'blank'}`;
    const credit = attribution?.creditOwner
        ? attribution.receivedOwner && attribution.receivedOwner !== attribution.creditOwner
            ? `${attribution.creditOwner}; received by ${attribution.receivedOwner}`
            : attribution.creditOwner
        : attribution?.receivedOwner ? `Received by ${attribution.receivedOwner}` : 'None — outside report group';
    const itemCell = showItem ? `<td style="${td()}">${item ? `<a href="${escapeHtml(item.url)}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${escapeHtml(item.name)}</a>` : escapeHtml(event.itemName || event.itemId)}</td>` : '';
    return `<tr><td style="${td()}white-space:nowrap">${escapeHtml(formatDateTime(event.at))}</td>${itemCell}<td style="${td()}">${escapeHtml(names.get(event.actorUserId) || `User ${event.actorUserId}`)}</td><td style="${td()}">${escapeHtml(event.type === 'group_move' ? 'Moved between groups' : event.columnTitle)}</td><td style="${td()}color:#526078">${escapeHtml(action)}</td><td style="${td()}font-weight:700;color:${attribution?.creditOwner ? '#15803d' : '#64748b'}">${escapeHtml(credit)}</td></tr>`;
}

function renderBreakdown(rows) {
    const body = rows.map(row => `<tr><td style="${td()}">${escapeHtml(row.label)}</td><td align="right" style="${td()}">${row.distinctItems}</td><td align="right" style="${td()}font-weight:800">${row.events}</td></tr>`).join('');
    return `${sectionTitle('What counted as activity', 'Distinct orders and qualifying event volume by field.')}
    <tr><td style="padding:0 28px 22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce3ed"><tr style="background:#f7f9fc"><th align="left" style="${lightTh()}">Qualifying field</th><th align="right" style="${lightTh()}">Orders</th><th align="right" style="${lightTh()}">Events</th></tr>${body || emptyRow(3, 'No qualifying activity.')}</table></td></tr>`;
}

function principle(title, text) { return `<td width="33.33%" valign="top" style="padding:5px"><div style="height:100%;padding:13px 14px;background:#f8fafc;border:1px solid #dce3ed"><div style="font-size:11px;font-weight:800;text-transform:uppercase;color:#0f766e">${escapeHtml(title)}</div><div style="font-size:12px;line-height:18px;color:#526078;margin-top:4px">${escapeHtml(text)}</div></div></td>`; }
function metric(label, value, note, color) { return `<td class="metric" width="20%" valign="top" style="padding:4px"><div style="padding:13px 12px;border:1px solid #dce3ed;border-top:4px solid ${color}"><div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#64748b">${escapeHtml(label)}</div><div style="font-size:25px;font-weight:800;margin:4px 0">${value}</div><div style="font-size:10px;color:#64748b">${escapeHtml(note)}</div></div></td>`; }
function sectionTitle(title, subtitle) { return `<tr><td style="padding:17px 28px 9px"><div style="font-size:17px;font-weight:800">${escapeHtml(title)}</div><div style="font-size:11px;color:#64748b;margin-top:3px">${escapeHtml(subtitle)}</div></td></tr>`; }
function alert(title, text) { return `<div style="padding:10px 13px;margin:5px 0;background:#fff7ed;border:1px solid #fdba74;color:#9a3412;font-size:12px"><b>${escapeHtml(title)}:</b> ${escapeHtml(text)}</div>`; }
function th() { return 'padding:9px 8px;color:#fff;font-size:10px;text-transform:uppercase;'; }
function lightTh() { return 'padding:8px 9px;color:#64748b;font-size:10px;text-transform:uppercase;'; }
function td() { return 'padding:8px 9px;border-top:1px solid #e5eaf1;font-size:11px;'; }
function emptyRow(columns, text) { return `<tr><td colspan="${columns}" align="center" style="padding:14px;color:#64748b;font-size:12px">${escapeHtml(text)}</td></tr>`; }
function dash(value) { return value || '—'; }
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
                subject: `Open Orders — Action & Waiting — ${formatShortDate(now)}`,
                body: { contentType: 'HTML', content: html },
                toRecipients: recipients.map(address => ({ emailAddress: { address } }))
            },
            saveToSentItems: true
        })
    });
    if (!mailResponse.ok) throw new Error(`Microsoft Graph sendMail failed (${mailResponse.status}): ${await mailResponse.text()}`);
    console.log(`Email sent via Microsoft Graph to ${recipients.join(', ')}.`);
}

function logSummary(result, items, events, rawLogs, outputPath, send, dryRun) {
    console.log(`Loaded ${items.length} attributable items, ${rawLogs} board activity records, and ${events.length} qualifying events.`);
    for (const [key, label] of [['snap', 'Factory SNAP'], ['fieldService', 'Field Service']]) {
        const population = result.populations[key];
        console.log(`${label}: ${population.currentOpen} current; ${population.totals.actioned} owner-item pairs actioned; ${population.totals.waiting} waiting >24h; ${population.totals.handedOff} handed off.`);
    }
    console.log(`People with qualifying activity: ${result.actorRows.length}; orders touched: ${result.distinctItemsWithActivity}.`);
    console.log(`Dynamic-owner ${send ? 'report' : 'preview'} saved: ${outputPath}`);
    if (!send || dryRun) console.log(`${dryRun ? 'Dry run' : 'Preview only'}: no email was sent and no Redis/report history was changed.`);
}

function parseMondayDate(value) { const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], 12)) : null; }
function parseDate(value) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date : null; }
function daysBetween(start, end) { return start ? Math.max(0, Math.floor((end - start) / 86400000)) : null; }
function formatLongDate(date) { return new Intl.DateTimeFormat('en-US', { timeZone: config.TIME_ZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(date); }
function formatShortDate(date) { return new Intl.DateTimeFormat('en-US', { timeZone: config.TIME_ZONE, month: 'numeric', day: 'numeric', year: 'numeric' }).format(date); }
function formatDateTime(date) { return new Intl.DateTimeFormat('en-US', { timeZone: config.TIME_ZONE, month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date); }
function splitRecipients(value) { return String(value || '').split(/[;,]/).map(entry => entry.trim()).filter(Boolean); }
function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

generateReport().catch(error => { console.error(`Fatal error: ${error.message}`); process.exitCode = 1; });
