export const CONFIG = {
  boardId: '18414349860',
  boardName: 'Order Tracker',
  mondaySlug: 'psiengines-company',
  timeZone: 'America/Chicago',
  closedLookbackDays: [7, 14, 30],
  recentShippedDays: 7,
  attentionItemLimit: 20,
  groups: {
    factory: 'group_title',
    field: 'topics',
    drafts: 'group_mm4dcjc9',
    missingFactory: 'group_mm3jgm1'
  },
  columns: {
    orderType: 'dropdown_mm5a5mf7',
    currentStatus: 'color_mm3jmw19',
    priority: 'color_mm3jz8vj',
    requestedBy: 'multiple_person_mm3jv3wx',
    customer: 'dropdown_mm3jf5w6',
    orderDate: 'date_mm3j6pr5',
    partNumber: 'text_mm3jn77d',
    trackingNumber: 'text_mm3jqzdr',
    dateShipped: 'date_mm3jybr7',
    supplierTracking: 'text_mm3jt8wp'
  }
};

export const ACTIVE_GROUP_IDS = new Set(Object.values(CONFIG.groups));
