require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');
const config = require('./snap-orders-report.config');

const HISTORY_FILE = path.join(__dirname, 'history-snap-orders.json');
const LAST_RUN_FILE = path.join(__dirname, 'last-run-snap-orders.txt');
const REDIS_HISTORY_KEY = process.env.SNAP_REDIS_HISTORY_KEY || 'snap-orders:history';
const REDIS_LAST_RUN_KEY = process.env.SNAP_REDIS_LAST_RUN_KEY || 'snap-orders:last-run';
const MONDAY_API_VERSION = process.env.MONDAY_API_VERSION || '2025-10';

async function generateReport() {
    const args = new Set(process.argv.slice(2));
    const force = args.has('--force') || args.has('-f') || process.env.FORCE_RUN === '1';
    const dryRun = args.has('--dry-run') || process.env.DRY_RUN === '1';
    const now = new Date();
    const central = getZonedDateParts(now, config.TIME_ZONE);
    let runtimeStore;

    try {
        if (!force && central.hour !== config.SCHEDULE_HOUR) {
            console.log(`Not scheduled time (${config.SCHEDULE_HOUR}:00 ${config.TIME_ZONE}); current local hour is ${central.hour}.`);
            return;
        }

        runtimeStore = await createRuntimeStore();
        const lastRun = await runtimeStore.readLastRun();
        if (!force && lastRun === central.dateKey) {
            console.log(`SNAP report already sent for ${central.dateKey}.`);
            return;
        }

        console.log(`Gathering ${config.VIEW_NAME} from ${config.BOARD_NAME}...`);
        const [board, history] = await Promise.all([
            fetchBoard(),
            runtimeStore.readHistory()
        ]);
        const items = await fetchOpenSnapItems(board);
        const previousSnapshot = findComparisonSnapshot(history, central.dateKey, config.TREND_COMPARISON_DAYS);
        const report = summarize(items, previousSnapshot);
        console.log(`Open SNAP orders: ${report.total}; average age: ${report.averageAge ?? 'n/a'} days; over 30 days: ${report.over30Days}.`);
        console.log(`Current Dept / Status: ${Object.entries(report.byCurrentStatus).sort((a, b) => b[1] - a[1]).map(([status, count]) => `${status}=${count}`).join(', ')}`);

        history[central.dateKey] = {
            total: report.total,
            byCurrentStatus: report.byCurrentStatus
        };
        pruneHistory(history, config.HISTORY_RETENTION_DAYS, central.dateKey);
        await runtimeStore.writeHistory(history);

        const html = generateHtml(report, history, central.dateKey);
        const outputPath = saveHtml(html, central.dateKey);
        console.log(`HTML preview saved: ${outputPath}`);

        if (dryRun) {
            console.log('Dry run enabled; email was not sent.');
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
    const view = board.views.find(candidate => candidate.id === config.VIEW_ID);
    if (!view) {
        throw new Error(`Monday view ${config.VIEW_ID} was not found on board ${config.BOARD_ID}.`);
    }
    return board;
}

async function fetchOpenSnapItems(board) {
    const items = [];
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
            if (rawItem.state !== 'active' || rawItem.group?.id !== config.SNAP_GROUP_ID) {
                continue;
            }
            const columns = Object.fromEntries(rawItem.column_values.map(value => [value.id, value.text || '']));
            const currentStatus = columns[config.COL_IDS.CURRENT_STATUS] || 'Unassigned';
            if (config.CLOSED_CURRENT_STATUSES.some(status => status.toLowerCase() === currentStatus.toLowerCase())) {
                continue;
            }

            const orderDate = parseMondayDate(columns[config.COL_IDS.ORDER_DATE]);
            const createdAt = parseDate(rawItem.created_at);
            const ageStart = orderDate || createdAt;
            items.push({
                id: rawItem.id,
                name: rawItem.name,
                url: `https://${config.MONDAY_SLUG}.monday.com/boards/${board.id}/pulses/${rawItem.id}`,
                currentStatus,
                priority: columns[config.COL_IDS.PRIORITY] || '',
                requestedBy: columns[config.COL_IDS.REQUESTED_BY] || '',
                customer: columns[config.COL_IDS.CUSTOMER] || '',
                orderDate,
                createdAt,
                ageDays: ageStart ? daysBetween(ageStart, new Date()) : null,
                epicorJob: columns[config.COL_IDS.EPICOR_JOB] || '',
                partNumber: columns[config.COL_IDS.PART_NUMBER] || '',
                partDescription: columns[config.COL_IDS.PART_DESCRIPTION] || '',
                quantity: columns[config.COL_IDS.QUANTITY] || '',
                cxAlloyId: columns[config.COL_IDS.CX_ALLOY_ID] || '',
                trackingNumber: columns[config.COL_IDS.TRACKING_NUMBER] || '',
                dateShipped: parseMondayDate(columns[config.COL_IDS.DATE_SHIPPED]),
                purchaseOrder: columns[config.COL_IDS.PURCHASE_ORDER] || '',
                supplierOrderDate: parseMondayDate(columns[config.COL_IDS.SUPPLIER_ORDER_DATE]),
                supplierTracking: columns[config.COL_IDS.SUPPLIER_TRACKING] || ''
            });
        }
        cursor = page?.cursor || null;
    } while (cursor);

    return items;
}

function summarize(items, comparisonSnapshot) {
    const byCurrentStatus = countBy(items, item => item.currentStatus || 'Unassigned');
    const byPriority = countBy(items, item => item.priority || 'Not set');
    const byCustomer = countBy(items, item => item.customer || 'Not set');
    const datedItems = items.filter(item => Number.isFinite(item.ageDays));
    const averageAge = datedItems.length
        ? Math.round(datedItems.reduce((sum, item) => sum + item.ageDays, 0) / datedItems.length)
        : null;
    const agingBuckets = {
        '0–7 days': datedItems.filter(item => item.ageDays <= 7).length,
        '8–14 days': datedItems.filter(item => item.ageDays >= 8 && item.ageDays <= 14).length,
        '15–30 days': datedItems.filter(item => item.ageDays >= 15 && item.ageDays <= 30).length,
        '31–60 days': datedItems.filter(item => item.ageDays >= 31 && item.ageDays <= 60).length,
        '61+ days': datedItems.filter(item => item.ageDays >= 61).length,
        'No date': items.length - datedItems.length
    };
    const priorityAttention = items.filter(item => /critical|high/i.test(item.priority));
    const dataGaps = items.filter(item => !item.orderDate || !item.requestedBy || !item.partNumber);
    const attentionItems = [...items].sort(attentionSort).slice(0, config.ATTENTION_ITEM_LIMIT);

    return {
        total: items.length,
        byCurrentStatus,
        byPriority,
        byCustomer,
        averageAge,
        agingBuckets,
        over30Days: datedItems.filter(item => item.ageDays > 30).length,
        newLast7Days: items.filter(item => item.orderDate && daysBetween(item.orderDate, new Date()) <= 7).length,
        priorityAttention: priorityAttention.length,
        dataGaps: dataGaps.length,
        attentionItems,
        comparisonSnapshot,
        totalDelta: comparisonSnapshot ? items.length - comparisonSnapshot.snapshot.total : null
    };
}

function attentionSort(a, b) {
    const priorityRank = item => /critical/i.test(item.priority) ? 0 : /high/i.test(item.priority) ? 1 : 2;
    return priorityRank(a) - priorityRank(b)
        || (b.ageDays ?? -1) - (a.ageDays ?? -1)
        || a.name.localeCompare(b.name);
}

function generateHtml(report, history, dateKey) {
    const viewUrl = `https://${config.MONDAY_SLUG}.monday.com/boards/${config.BOARD_ID}/views/${config.VIEW_ID}`;
    const generatedLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: config.TIME_ZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    }).format(new Date());
    const sortedStatuses = Object.entries(report.byCurrentStatus).sort((a, b) => b[1] - a[1]);
    const maxStatusCount = Math.max(1, ...sortedStatuses.map(([, count]) => count));
    const statusRows = sortedStatuses.map(([status, count]) => {
        const prior = report.comparisonSnapshot?.snapshot.byCurrentStatus?.[status] || 0;
        const delta = report.comparisonSnapshot ? count - prior : null;
        return `<tr>
            <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;color:#0f172a;">${escapeHtml(status)}</td>
            <td width="45%" style="padding:10px 12px;border-bottom:1px solid #e2e8f0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="${Math.max(3, Math.round(count / maxStatusCount * 100))}%" height="9" bgcolor="#2563eb" style="background:#2563eb;border-radius:4px;"></td><td></td></tr></table></td>
            <td align="right" style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:800;color:#0f172a;">${count}</td>
            <td align="right" style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;font-weight:700;color:${deltaColor(delta)};">${formatDelta(delta)}</td>
        </tr>`;
    }).join('');

    const agingRows = Object.entries(report.agingBuckets).map(([label, count]) => tableCountRow(label, count, report.total)).join('');
    const priorityRows = Object.entries(report.byPriority).sort((a, b) => b[1] - a[1]).map(([label, count]) => tableCountRow(label, count, report.total)).join('');
    const customerRows = Object.entries(report.byCustomer).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, count]) => tableCountRow(label, count, report.total)).join('');
    const trendRows = Object.entries(history).sort(([a], [b]) => b.localeCompare(a)).slice(0, 14).reverse().map(([day, snapshot]) => {
        const topStage = Object.entries(snapshot.byCurrentStatus || {}).sort((a, b) => b[1] - a[1])[0];
        return `<tr><td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#475569;">${escapeHtml(formatDateKey(day))}</td><td align="right" style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;font-weight:800;">${snapshot.total}</td><td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#475569;">${topStage ? `${escapeHtml(topStage[0])} (${topStage[1]})` : '—'}</td></tr>`;
    }).join('');
    const itemRows = report.attentionItems.map(item => `<tr>
        <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;"><a href="${item.url}" style="color:#1d4ed8;text-decoration:none;font-weight:700;">${escapeHtml(item.name)}</a>${item.partNumber ? `<br><span style="color:#64748b;">Part ${escapeHtml(item.partNumber)}</span>` : ''}</td>
        <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#334155;">${escapeHtml(item.currentStatus)}</td>
        <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#334155;">${escapeHtml(item.priority || '—')}</td>
        <td style="padding:9px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#334155;">${escapeHtml(item.customer || '—')}</td>
        <td align="right" style="padding:9px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;font-weight:700;color:${ageColor(item.ageDays)};">${item.ageDays === null ? '—' : item.ageDays}</td>
    </tr>`).join('');
    const comparisonLabel = report.comparisonSnapshot
        ? `vs. ${formatDateKey(report.comparisonSnapshot.dateKey)}`
        : 'trend baseline starts today';

    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
    <body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f1f5f9"><tr><td align="center" style="padding:24px 10px;">
    <table role="presentation" width="760" cellpadding="0" cellspacing="0" style="width:760px;max-width:100%;background:#ffffff;">
        <tr><td bgcolor="#172554" style="padding:28px 32px;background:#172554;color:#ffffff;">
            <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#bfdbfe;">Order Tracker Operations</div>
            <h1 style="margin:7px 0 5px;font-size:28px;line-height:34px;">Open SNAP Orders</h1>
            <div style="font-size:13px;color:#dbeafe;">${escapeHtml(generatedLabel)} &nbsp;•&nbsp; Grouped by Current Dept / Status</div>
        </td></tr>
        <tr><td style="padding:22px 24px 8px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                ${metricCard('Open orders', report.total, formatDelta(report.totalDelta), '#1d4ed8')}
                ${metricCard('Average age', report.averageAge === null ? '—' : `${report.averageAge}d`, `${report.over30Days} over 30d`, '#0f766e')}
                ${metricCard('New in 7 days', report.newLast7Days, 'by order date', '#7c3aed')}
                ${metricCard('High / critical', report.priorityAttention, `${report.dataGaps} data gaps`, '#b45309')}
            </tr></table>
            <div style="font-size:11px;color:#64748b;margin:8px 4px 0;">${escapeHtml(comparisonLabel)}</div>
        </td></tr>
        ${sectionHeader('Current Dept / Status', 'Current workload and change by workflow stage')}
        <tr><td style="padding:0 24px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;"><tr bgcolor="#f8fafc"><th align="left" style="padding:9px 12px;font-size:11px;color:#64748b;text-transform:uppercase;">Department / stage</th><th></th><th align="right" style="padding:9px 12px;font-size:11px;color:#64748b;text-transform:uppercase;">Open</th><th align="right" style="padding:9px 12px;font-size:11px;color:#64748b;text-transform:uppercase;">7-day Δ</th></tr>${statusRows}</table></td></tr>
        ${sectionHeader('Operational profile', 'Aging, priority, and customer concentration')}
        <tr><td style="padding:0 24px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="32%" valign="top">${miniTable('Aging', agingRows)}</td><td width="2%"></td>
            <td width="32%" valign="top">${miniTable('Priority', priorityRows)}</td><td width="2%"></td>
            <td width="32%" valign="top">${miniTable('Top customers', customerRows)}</td>
        </tr></table></td></tr>
        ${sectionHeader('Daily trend', 'Snapshot history builds automatically each morning')}
        <tr><td style="padding:0 24px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;"><tr bgcolor="#f8fafc"><th align="left" style="padding:8px 10px;font-size:11px;color:#64748b;">Date</th><th align="right" style="padding:8px 10px;font-size:11px;color:#64748b;">Open</th><th align="left" style="padding:8px 10px;font-size:11px;color:#64748b;">Largest stage</th></tr>${trendRows}</table></td></tr>
        ${sectionHeader('Attention queue', `Critical/high priority first, then oldest ${config.ATTENTION_ITEM_LIMIT} orders`)}
        <tr><td style="padding:0 24px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;"><tr bgcolor="#f8fafc"><th align="left" style="padding:8px 10px;font-size:11px;color:#64748b;">Order</th><th align="left" style="padding:8px 10px;font-size:11px;color:#64748b;">Current dept / status</th><th align="left" style="padding:8px 10px;font-size:11px;color:#64748b;">Priority</th><th align="left" style="padding:8px 10px;font-size:11px;color:#64748b;">Customer</th><th align="right" style="padding:8px 10px;font-size:11px;color:#64748b;">Age</th></tr>${itemRows}</table></td></tr>
        <tr><td bgcolor="#e0e7ff" align="center" style="padding:20px;background:#e0e7ff;"><a href="${viewUrl}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-size:13px;font-weight:800;padding:11px 20px;border-radius:4px;">Open the Monday view</a><div style="margin-top:12px;font-size:11px;color:#475569;">Automated daily at 5:00 AM Central &nbsp;•&nbsp; Only “Shipped” items are treated as complete</div></td></tr>
    </table></td></tr></table></body></html>`;
}

function metricCard(label, value, note, color) {
    return `<td width="25%" valign="top" style="padding:4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dbe3ef;"><tr><td style="padding:14px 12px;border-top:4px solid ${color};"><div style="font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">${escapeHtml(label)}</div><div style="font-size:25px;font-weight:800;color:#0f172a;margin:4px 0;">${escapeHtml(value)}</div><div style="font-size:10px;color:#64748b;">${escapeHtml(note)}</div></td></tr></table></td>`;
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

function findComparisonSnapshot(history, currentDateKey, daysBack) {
    const target = dateKeyToUtc(currentDateKey);
    target.setUTCDate(target.getUTCDate() - daysBack);
    for (let offset = 0; offset <= 2; offset += 1) {
        const candidate = new Date(target);
        candidate.setUTCDate(candidate.getUTCDate() - offset);
        const dateKey = candidate.toISOString().slice(0, 10);
        if (history[dateKey]) {
            return { dateKey, snapshot: history[dateKey] };
        }
    }
    return null;
}

function pruneHistory(history, retentionDays, currentDateKey) {
    const cutoff = dateKeyToUtc(currentDateKey);
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
    for (const key of Object.keys(history)) {
        if (dateKeyToUtc(key) < cutoff) {
            delete history[key];
        }
    }
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
    const recipientValue = process.env.SNAP_REPORT_TO_EMAIL || config.DEFAULT_RECIPIENT;
    const recipients = splitRecipients(recipientValue);
    if (!recipients.length) {
        throw new Error('No SNAP report recipients are configured.');
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
                subject: `Open SNAP Orders Daily Report - ${formatDateKey(dateKey)}`,
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
    const outputPath = path.join(directory, `snap-orders-report-${dateKey}.html`);
    fs.writeFileSync(outputPath, html, 'utf8');
    return outputPath;
}

function getZonedDateParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return { dateKey: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
}

function countBy(items, selector) {
    return items.reduce((counts, item) => {
        const key = selector(item);
        counts[key] = (counts[key] || 0) + 1;
        return counts;
    }, {});
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

function deltaColor(value) {
    if (value === null || value === undefined || value === 0) return '#64748b';
    return value > 0 ? '#b45309' : '#047857';
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
