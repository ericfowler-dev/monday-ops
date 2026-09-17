import mondaySdk from 'monday-sdk-js';
import { ACTIVE_GROUP_IDS, CONFIG } from './config';
import { getMockDashboardData } from './mockData';
import {
  dateKeyForTimeZone,
  classifyOrderPopulation,
  daysBetween,
  buildDashboardShipments,
  isOpenOrder,
  shipmentEvents,
  shiftDate,
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
  const warnings = [];
  const [rawItems, events] = await Promise.all([
    fetchBoardItems(boardId),
    fetchShipmentEvents(boardId, new Date(`${shiftDate(currentDateKey, -31)}T00:00:00Z`), now).catch(error => {
      warnings.push(`Historical shipment fallback was unavailable: ${error.message}`);
      return [];
    })
  ]);

  const populations = { factory: [], fieldMissingParts: [], fieldWarranty: [], other: [] };
  for (const rawItem of rawItems) {
    if (!ACTIVE_GROUP_IDS.has(rawItem.group?.id) || rawItem.state !== 'active') continue;
    const mapped = mapOrderItem(rawItem, boardId, now);
    if (isOpenOrder(mapped)) {
      const population = classifyOrderPopulation(mapped, CONFIG.groups);
      populations[population].push(mapped);
    }
  }

  const knownIds = new Set(rawItems.map(item => String(item.id)));
  const missingIds = [...new Set(events.map(event => event.itemId))].filter(id => !knownIds.has(id));
  const historicalItems = await fetchItemsById(missingIds);
  const retrievedIds = new Set(historicalItems.map(item => String(item.id)));
  const unavailable = missingIds.filter(id => !retrievedIds.has(id)).length;
  if (unavailable) warnings.push(`${unavailable} historical shipment records could not be verified and were excluded.`);
  const shipmentReport = buildDashboardShipments(
    [...rawItems, ...historicalItems].map(item => mapOrderItem(item, boardId, now)), events, now, CONFIG.groups
  );

  return {
    boardName: CONFIG.boardName,
    factory: summarize(populations.factory, now, CONFIG.attentionItemLimit),
    fieldMissingParts: summarize(populations.fieldMissingParts, now, CONFIG.attentionItemLimit),
    fieldWarranty: summarize(populations.fieldWarranty, now, CONFIG.attentionItemLimit),
    other: summarize(populations.other, now, CONFIG.attentionItemLimit),
    ...shipmentReport,
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

async function fetchShipmentLogs(boardId, from, to) {
  const response = await api(`query ($boardId: ID!, $from: ISO8601DateTime!, $to: ISO8601DateTime!) {
    boards(ids: [$boardId]) {
      activity_logs(
        from: $from
        to: $to
        limit: 10000
        column_ids: [${JSON.stringify(CONFIG.columns.currentStatus)}]
      ) { id event data created_at }
    }
  }`, { boardId: String(boardId), from: from.toISOString(), to: to.toISOString() });
  const logs = response.boards?.[0]?.activity_logs || [];
  if (logs.length >= 10000) {
    if (to - from < 60000) throw new Error('Activity limit reached within one minute; shipment history is incomplete.');
    const middle = new Date(Math.floor((from.getTime() + to.getTime()) / 2));
    const left = await fetchShipmentLogs(boardId, from, middle);
    const right = await fetchShipmentLogs(boardId, middle, to);
    return [...new Map([...left, ...right].map(log => [log.id, log])).values()];
  }
  return logs;
}

async function fetchShipmentEvents(boardId, from, to) {
  return shipmentEvents(await fetchShipmentLogs(boardId, from, to), CONFIG.columns.currentStatus);
}

async function fetchItemsById(ids) {
  const rawItems = [];
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

  return rawItems;
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
