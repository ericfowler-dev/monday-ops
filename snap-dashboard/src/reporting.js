export function parseDate(value) {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00.000Z`)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseActivityTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(Math.round(timestamp / 10000));
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

export function dateKeyToUtc(dateKey) {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

export function filterWithinLookback(items, currentDateKey, lookbackDays) {
  const cutoff = dateKeyToUtc(currentDateKey);
  cutoff.setUTCDate(cutoff.getUTCDate() - (lookbackDays - 1));
  const end = dateKeyToUtc(currentDateKey);
  end.setUTCDate(end.getUTCDate() + 1);
  return items.filter(item => item.completedAt >= cutoff && item.completedAt < end);
}

export function mergeClosedItems(currentShipped, activityClosedItems) {
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
