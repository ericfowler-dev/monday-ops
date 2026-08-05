import { CONFIG } from './config';
import { summarize } from './reporting';

const now = new Date();

function item(id, overrides = {}) {
  return {
    id: String(id),
    name: `Sample order ${id}`,
    url: '#',
    groupId: CONFIG.groups.factory,
    groupName: 'SNAPs',
    orderType: 'SNAP',
    currentStatus: 'Purchasing',
    priority: 'Medium',
    requestedBy: 'Operations',
    customer: 'Sample customer',
    orderDate: new Date(now.getTime() - 12 * 86400000),
    dateShipped: null,
    completedAt: null,
    ageDays: 12,
    partNumber: `PN-${id}`,
    trackingNumber: '',
    supplierTracking: '',
    ...overrides
  };
}

export function getMockDashboardData() {
  const factory = Array.from({ length: 18 }, (_, index) => item(index + 1, {
    currentStatus: ['Purchasing', 'FAB', 'Beloit WH', 'Pick/Materials (Darien)'][index % 4],
    priority: index % 7 === 0 ? 'High' : 'Medium',
    ageDays: 3 + index * 3,
    orderDate: new Date(now.getTime() - (3 + index * 3) * 86400000)
  }));
  const fieldMissingParts = Array.from({ length: 10 }, (_, index) => item(index + 101, {
    groupId: CONFIG.groups.field,
    groupName: 'Field Service Orders',
    orderType: 'Missing Parts',
    currentStatus: ['FAB', 'Staged in Darien', 'Ordered from Supplier'][index % 3],
    priority: index === 0 ? 'Critical' : 'Medium',
    ageDays: 2 + index * 4,
    orderDate: new Date(now.getTime() - (2 + index * 4) * 86400000)
  }));
  const fieldWarranty = Array.from({ length: 4 }, (_, index) => item(index + 151, {
    groupId: CONFIG.groups.field,
    groupName: 'Field Service Orders',
    orderType: 'Warranty',
    currentStatus: ['FAB', 'Purchasing'][index % 2],
    priority: index === 0 ? 'High' : 'Medium',
    ageDays: 5 + index * 6,
    orderDate: new Date(now.getTime() - (5 + index * 6) * 86400000)
  }));
  const other = [item(181, {
    groupId: CONFIG.groups.field,
    groupName: 'Field Service Orders',
    orderType: 'Service',
    currentStatus: 'Staged in Darien'
  })];
  const recentShipped = Array.from({ length: 7 }, (_, index) => item(index + 201, {
    currentStatus: 'Shipped',
    dateShipped: new Date(now.getTime() - index * 86400000),
    completedAt: new Date(now.getTime() - index * 86400000),
    trackingNumber: `1Z-SAMPLE-${index + 1}`
  }));

  return {
    boardName: CONFIG.boardName,
    factory: summarize(factory, now, CONFIG.attentionItemLimit),
    fieldMissingParts: summarize(fieldMissingParts, now, CONFIG.attentionItemLimit),
    fieldWarranty: summarize(fieldWarranty, now, CONFIG.attentionItemLimit),
    other: summarize(other, now, CONFIG.attentionItemLimit),
    closedCounts: { 7: 7, 14: 11, 30: 19 },
    recentShipped,
    refreshedAt: now,
    warnings: ['Mock preview data is enabled.']
  };
}
