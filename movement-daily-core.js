// Shipment outcomes are independent of person activity credit.
const TIME_ZONE = 'America/Chicago';
const statusIs = (value, expected) => String(value || '').trim().toLowerCase() === expected.toLowerCase();
const isCancelled = item => statusIs(item.status, 'Cancelled');
function dateKey(value) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
function shiftDate(key, days) {
    const date = new Date(`${key}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}
function shippedDateKey(value) {
    if (!value) return null;
    // Monday Date columns are calendar dates, not instants in the local zone.
    const key = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) && !Number.isNaN(Date.parse(key)) ? key : null;
}
function shipmentEvents(logs, columnId) {
    const result = [];
    const seen = new Set();
    for (const log of logs) {
        if (log.event !== 'update_column_value') continue;
        let data;
        try { data = JSON.parse(log.data); } catch { continue; }
        if (data.is_undo_action || data.column_id !== columnId) continue;
        const next = data.value?.label?.text;
        const previous = data.previous_value?.label?.text;
        if (!statusIs(next, 'Shipped') || statusIs(previous, 'Shipped')) continue;
        const at = new Date(Math.round(Number(log.created_at) / 10000));
        if (!Number.isFinite(at.getTime())) continue;
        for (const id of [data.pulse_id, ...(data.pulse_ids || [])].filter(Boolean)) {
            const unique = `${log.id || log.created_at}:${id}`;
            if (seen.has(unique)) continue;
            seen.add(unique);
            result.push({ itemId: String(id), at, groupId: String(data.group_id || '') });
        }
    }
    return result;
}
function buildShipmentSummary({ items, events, now, snapGroupId, fieldServiceGroupId }) {
    const today = dateKey(now);
    const end = shiftDate(today, -1);
    const latest = new Map();
    for (const event of events) {
        if (event.at > now) continue;
        if (!latest.has(event.itemId) || latest.get(event.itemId).at < event.at) latest.set(event.itemId, event);
    }
    const records = [];
    const seen = new Set();
    for (const item of items) {
        if (seen.has(String(item.id)) || isCancelled(item) || !statusIs(item.status, 'Shipped')) continue;
        seen.add(String(item.id));
        const event = latest.get(String(item.id));
        const group = event?.groupId || item.groupId;
        const population = group === fieldServiceGroupId ? 'fieldService'
            : group === snapGroupId && item.isSnapOrder ? 'snap' : null;
        if (!population) continue;
        const completed = shippedDateKey(item.dateShipped) || (event && dateKey(event.at));
        if (!completed || completed > today || completed < shiftDate(today, -30)) continue;
        records.push({ item, population, date: completed });
    }
    const summarize = population => {
        const matching = records.filter(record => !population || record.population === population);
        const days = Array.from({ length: 14 }, (_, index) => {
            const date = shiftDate(today, index - 14);
            return { date, count: matching.filter(record => record.date === date).length };
        });
        const count = length => matching.filter(record => record.date >= shiftDate(today, -length) && record.date <= end).length;
        const last7 = count(7);
        const previous7 = count(14) - last7;
        return { days, last7, previous7, last14: count(14), last30: count(30), today: matching.filter(record => record.date === today).length,
            change: last7 - previous7, changePct: previous7 ? Math.round((last7 - previous7) / previous7 * 100) : null };
    };
    const durations = records.filter(record => record.date >= shiftDate(today, -7) && record.date <= end)
        .map(({ item, date }) => {
            const start = shippedDateKey(item.orderDate || item.createdAt);
            return start ? (Date.parse(date) - Date.parse(start)) / 86400000 : NaN;
        }).filter(value => Number.isFinite(value) && value >= 0);
    return { today, end, snap: summarize('snap'), fieldService: summarize('fieldService'), total: summarize(null),
        closure: { closedCount: summarize(null).last7, measuredCount: durations.length,
            avgClosureDays: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length * 10) / 10 : null } };
}
function summarizeOpenOrders(items, now) {
    const today = dateKey(now);
    const summary = {};
    for (const population of ['snap', 'fieldService']) {
        const open = items.filter(item => item.population === population && item.isOpen && !isCancelled(item));
        const newCount = days => open.filter(item => {
            const date = shippedDateKey(item.orderDate);
            return date && date >= shiftDate(today, -(days - 1)) && date <= today;
        }).length;
        const types = { missingParts: 0, warranty: 0, other: 0 };
        for (const item of open) {
            const values = String(item.orderType || '').toLowerCase().split(',').map(value => value.trim());
            const missing = values.includes('missing parts');
            const warranty = values.includes('warranty');
            types[missing && !warranty ? 'missingParts' : warranty && !missing ? 'warranty' : 'other']++;
        }
        summary[population] = { total: open.length, new7: newCount(7), new30: newCount(30), types,
            critical: open.filter(item => /critical/i.test(item.priority)).length,
            high: open.filter(item => /high/i.test(item.priority) && !/critical/i.test(item.priority)).length };
    }
    return summary;
}
function isDeliveryWindow(now) {
    const day = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' }).format(now);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' }).format(now));
    return !['Sat', 'Sun'].includes(day) && hour === 5;
}
function isDstCompanionRun(now) {
    // Render runs at both possible UTC offsets for 5 AM Central. Suppress only
    // the unused companion hour; a dashboard Trigger Run at another time is
    // an intentional manual delivery, still subject to the daily send marker.
    const weekday = now.getUTCDay();
    return weekday >= 1 && weekday <= 5 && [10, 11].includes(now.getUTCHours()) && !isDeliveryWindow(now);
}
module.exports = { isCancelled, statusIs, dateKey, shiftDate, shipmentEvents, buildShipmentSummary, summarizeOpenOrders, isDeliveryWindow, isDstCompanionRun };
