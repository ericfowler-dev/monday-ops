import mondaySdk from 'monday-sdk-js';
import { ACTIVE_GROUP_IDS, CONFIG } from './config';
import { getMockDashboardData } from './mockData';
import {
  dateKeyForTimeZone,
  classifyOrderPopulation,
  daysBetween,
  filterWithinLookback,
  mergeClosedItems,
  parseActivityTimestamp,
  parseDate,
  summarize
} from './reporting';

export const isMockMode = import.meta.env.MODE === 'mock';
export const monday = mondaySdk();
monday.setApiVersion('2026-07');

export async function getBoardContext() {
  if (isMockMode) return { boardId: CONFIG.boardId, theme: 'light' };
  const response = await monday.get('context');
  return response.data || {};
}

export function listenToMonday(type, callback) {
  if (isMockMode) return () => {};
  return monday.listen(type, callback);
}

export async function loadDashboard(boardId) {
  if (isMockMode) {
    await new Promise(resolve => setTimeout(resolve, 350));
    return getMockDashboardData();
  }
  if (String(boardId) !== CONFIG.boardId) {
    throw new Error(`This view is configured for ${CONFIG.boardName}. Add it to that board to load the report.`);
  }

  const now = new Date();
  const currentDateKey = dateKeyForTimeZone(now, CONFIG.timeZone);
  const maximumLookback = Math.max(...CONFIG.closedLookbackDays);
  const warnings = [];
  const [rawItems, activityClosedItems] = await Promise.all([
    fetchBoardItems(boardId),
    fetchActivityClosedItems(boardId, currentDateKey, maximumLookback).catch(error => {
      warnings.push(`Historical shipment fallback was unavailable: ${error.message}`);
      return [];
    })
  ]);

  const populations = { factory: [], fieldMissingParts: [], fieldWarranty: [], other: [], currentShipped: [] };
  for (const rawItem of rawItems) {
    if (!ACTIVE_GROUP_IDS.has(rawItem.group?.id) || rawItem.state !== 'active') continue;
    const mapped = mapOrderItem(rawItem, boardId, now);
    if (mapped.currentStatus.toLowerCase() === 'shipped') {
      populations.currentShipped.push(mapped);
    } else {
      const population = classifyOrderPopulation(mapped, CONFIG.groups);
      populations[population].push(mapped);
    }
  }

  const closedItems = mergeClosedItems(populations.currentShipped, activityClosedItems);
  const closedCounts = Object.fromEntries(CONFIG.closedLookbackDays.map(days => [
    days,
    filterWithinLookback(closedItems, currentDateKey, days).length
  ]));

  return {
    boardName: CONFIG.boardName,
    factory: summarize(populations.factory, now, CONFIG.attentionItemLimit),
    fieldMissingParts: summarize(populations.fieldMissingParts, now, CONFIG.attentionItemLimit),
    fieldWarranty: summarize(populations.fieldWarranty, now, CONFIG.attentionItemLimit),
    other: summarize(populations.other, now, CONFIG.attentionItemLimit),
    closedCounts,
    recentShipped: filterWithinLookback(closedItems, currentDateKey, CONFIG.recentShippedDays),
    refreshedAt: now,
    warnings
  };
}

async function fetchBoardItems(boardId) {
  const columnIds = Object.values(CONFIG.columns);
  const items = [];
  let cursor = null;
  do {
    const response = await api(`query ($boardId: ID!, $cursor: String, $columnIds: [String!]) {
      boards(ids: [$boardId]) {
        items_page(limit: 500, cursor: $cursor) {
          cursor
          items {
            id name state created_at
            group { id title }
            column_values(ids: $columnIds) { id text }
          }
        }
      }
    }`, { boardId: String(boardId), cursor, columnIds });
    const page = response.boards?.[0]?.items_page;
    items.push(...(page?.items || []));
    cursor = page?.cursor || null;
  } while (cursor);
  return items;
}

async function fetchActivityClosedItems(boardId, currentDateKey, lookbackDays) {
  const cutoff = new Date(`${currentDateKey}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - (lookbackDays - 1));
  const end = new Date(`${currentDateKey}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const response = await api(`query ($boardId: ID!) {
    boards(ids: [$boardId]) {
      activity_logs(
        from: ${JSON.stringify(cutoff.toISOString())}
        to: ${JSON.stringify(end.toISOString())}
        limit: 10000
        column_ids: [${JSON.stringify(CONFIG.columns.currentStatus)}]
      ) { data created_at }
    }
  }`, { boardId: String(boardId) });
  const shippedEvents = new Map();

  for (const log of response.boards?.[0]?.activity_logs || []) {
    let activity;
    try { activity = JSON.parse(log.data); } catch { continue; }
    if (!ACTIVE_GROUP_IDS.has(activity.group_id)) continue;
    const isShipped = activity.column_id === CONFIG.columns.currentStatus
      && String(activity.value?.label?.text || '').toLowerCase() === 'shipped';
    if (!isShipped) continue;
    const completedAt = parseActivityTimestamp(log.created_at);
    if (activity.pulse_id) recordLatestEvent(shippedEvents, activity.pulse_id, completedAt);
    for (const id of activity.pulse_ids || []) recordLatestEvent(shippedEvents, id, completedAt);
  }

  if (!shippedEvents.size) return [];
  const rawItems = [];
  const ids = [...shippedEvents.keys()];
  const columnIds = Object.values(CONFIG.columns);
  for (let offset = 0; offset < ids.length; offset += 100) {
    const responsePage = await api(`query ($itemIds: [ID!], $columnIds: [String!]) {
      items(ids: $itemIds, limit: 100) {
        id name state created_at
        group { id title }
        column_values(ids: $columnIds) { id text }
      }
    }`, { itemIds: ids.slice(offset, offset + 100), columnIds });
    rawItems.push(...(responsePage.items || []));
  }

  const now = new Date();
  return rawItems.map(rawItem => ({
    ...mapOrderItem(rawItem, boardId, now),
    completedAt: shippedEvents.get(String(rawItem.id))
  })).filter(item => ACTIVE_GROUP_IDS.has(item.groupId) && item.completedAt);
}

function mapOrderItem(rawItem, boardId, now) {
  const columns = Object.fromEntries((rawItem.column_values || []).map(value => [value.id, value.text || '']));
  const orderDate = parseDate(columns[CONFIG.columns.orderDate]);
  const createdAt = parseDate(rawItem.created_at);
  const ageStart = orderDate || createdAt;
  return {
    id: String(rawItem.id),
    name: rawItem.name,
    groupId: rawItem.group?.id || '',
    groupName: rawItem.group?.title || '',
    state: rawItem.state,
    url: `https://${CONFIG.mondaySlug}.monday.com/boards/${boardId}/pulses/${rawItem.id}`,
    orderType: columns[CONFIG.columns.orderType] || '',
    currentStatus: columns[CONFIG.columns.currentStatus] || 'Unassigned',
    priority: columns[CONFIG.columns.priority] || '',
    requestedBy: columns[CONFIG.columns.requestedBy] || '',
    customer: columns[CONFIG.columns.customer] || '',
    orderDate,
    createdAt,
    ageDays: ageStart ? daysBetween(ageStart, now) : null,
    partNumber: columns[CONFIG.columns.partNumber] || '',
    trackingNumber: columns[CONFIG.columns.trackingNumber] || '',
    supplierTracking: columns[CONFIG.columns.supplierTracking] || '',
    dateShipped: parseDate(columns[CONFIG.columns.dateShipped])
  };
}

function recordLatestEvent(events, itemId, eventDate) {
  if (!eventDate) return;
  const key = String(itemId);
  const existing = events.get(key);
  if (!existing || eventDate > existing) events.set(key, eventDate);
}

async function api(query, variables) {
  let response;
  try {
    response = await monday.api(query, { variables });
  } catch (error) {
    throw new Error(formatMondayError(error));
  }
  if (response.errors?.length) throw new Error(formatMondayError(response.errors));
  return response.data;
}

function formatMondayError(error) {
  const messages = new Set();
  collectErrorMessages(error, messages);
  return [...messages].join('; ') || 'Monday rejected the GraphQL request without an error description.';
}

function collectErrorMessages(value, messages, seen = new Set()) {
  if (value == null || seen.has(value)) return;
  if (typeof value === 'string') {
    if (value.trim()) messages.add(value.trim());
    return;
  }
  if (typeof value !== 'object') return;
  seen.add(value);

  if (typeof value.message === 'string' && value.message.trim()) messages.add(value.message.trim());
  for (const key of ['errors', 'data', 'error_data', 'extensions']) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      for (const item of nested) collectErrorMessages(item, messages, seen);
    } else {
      collectErrorMessages(nested, messages, seen);
    }
  }
}
