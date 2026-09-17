import movementReporting from '@monday-ops/reporting-core';

const { buildShipmentSummary, shipmentEvents, shiftDate, statusIs } = movementReporting;
export { shipmentEvents, shiftDate };

export function isOpenOrder(item) {
  return item.state === 'active' && !statusIs(item.currentStatus, 'Shipped') && !statusIs(item.currentStatus, 'Cancelled');
}

// Both surfaces use the same shipment rules, including completed Central-time
// days, current Shipped status, Date Shipped precedence, and event fallback.
export function buildDashboardShipments(items, events, now, groups) {
  const shipments = buildShipmentSummary({
    items: items.map(item => ({ ...item, status: item.currentStatus,
      isSnapOrder: String(item.orderType || '').split(',').some(value => value.trim().toLowerCase() === 'snap') })),
    events, now, snapGroupId: groups.factory, fieldServiceGroupId: groups.field
  });
  const closedCounts = Object.fromEntries([7, 14, 30].map(days => [days, shipments.total[`last${days}`]]));
  const recentShipped = shipments.records
    .filter(record => record.date >= shiftDate(shipments.today, -7) && record.date <= shipments.end)
    .map(record => ({ ...record.item, completedAt: parseDate(record.date) }))
    .sort((a, b) => b.completedAt - a.completedAt || a.name.localeCompare(b.name));
  return { shipments, closedCounts, recentShipped };
}

export function parseDate(value) {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00.000Z`)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function daysBetween(start, end) {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86400000));
}

export function isDateWithinLookback(date, now, lookbackDays) {
  if (!date || !now || lookbackDays < 1) return false;
  const dateDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const currentDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays = Math.floor((currentDay - dateDay) / 86400000);
  return ageDays >= 0 && ageDays < lookbackDays;
}

export function dateKeyForTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function classifyOrderPopulation(item, groups) {
  const orderTypes = new Set(String(item.orderType || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean));

  if (item.groupId === groups.factory && orderTypes.has('snap')) return 'factory';
  if (item.groupId !== groups.field) return 'other';

  const isMissingParts = orderTypes.has('missing parts');
  const isWarranty = orderTypes.has('warranty');
  if (isMissingParts && !isWarranty) return 'fieldMissingParts';
  if (isWarranty && !isMissingParts) return 'fieldWarranty';
  return 'other';
}

export function summarize(items, now, attentionItemLimit = 20) {
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

  return {
    total: items.length,
    byCurrentStatus,
    byPriority,
    byCustomer,
    averageAge,
    agingBuckets,
    over30Days: datedItems.filter(item => item.ageDays > 30).length,
    newLast7Days: items.filter(item => isDateWithinLookback(item.orderDate, now, 7)).length,
    newLast30Days: items.filter(item => isDateWithinLookback(item.orderDate, now, 30)).length,
    priorityAttention: items.filter(item => /critical|high/i.test(item.priority)).length,
    dataGaps: items.filter(item => !item.orderDate || !item.requestedBy || !item.partNumber).length,
    attentionItems: [...items].sort(attentionSort).slice(0, attentionItemLimit)
  };
}

export function countBy(items, selector) {
  return items.reduce((counts, item) => {
    const key = selector(item) || 'Not set';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function attentionSort(a, b) {
  const priorityRank = item => /critical/i.test(item.priority) ? 0 : /high/i.test(item.priority) ? 1 : 2;
  return priorityRank(a) - priorityRank(b)
    || (b.ageDays ?? -1) - (a.ageDays ?? -1)
    || a.name.localeCompare(b.name);
}
