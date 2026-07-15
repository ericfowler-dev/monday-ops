module.exports = {
    MONDAY_SLUG: 'psiengines-company',
    BOARD_ID: '18414349860',
    BOARD_NAME: 'Order Tracker',
    VIEW_ID: '269601110',
    VIEW_NAME: 'Open SNAP Orders',
    SNAP_GROUP_ID: 'group_title',
    SNAP_GROUP_NAME: 'SNAPs',
    FIELD_SERVICE_VIEW_ID: '263347143',
    FIELD_SERVICE_VIEW_NAME: 'Field Service',
    FIELD_SERVICE_GROUP_ID: 'topics',
    FIELD_SERVICE_GROUP_NAME: 'Field Service Orders',
    DRAFT_GROUP_ID: 'group_mm4dcjc9',
    DRAFT_GROUP_NAME: 'Order Drafts (Not ready to assign)',
    MISSING_FACTORY_GROUP_ID: 'group_mm3jgm1',
    MISSING_FACTORY_GROUP_NAME: 'Missing Part Factory Requests',
    TIME_ZONE: 'America/Chicago',
    SCHEDULE_HOUR: 5,
    DEFAULT_RECIPIENT: 'efowler@psiengines.com',
    HISTORY_RETENTION_DAYS: 90,
    TREND_COMPARISON_DAYS: 7,
    ATTENTION_ITEM_LIMIT: 30,
    CLOSED_LOOKBACK_DAYS: [7, 14, 30],
    RECENT_SHIPPED_DAYS: 7,

    // Monday marks only "Shipped" as done in Current Dept / Status. "Shipped to
    // Darien" is an active internal workflow stage and must remain in this report.
    CLOSED_CURRENT_STATUSES: ['Shipped'],

    COL_IDS: {
        CURRENT_STATUS: 'color_mm3jmw19',
        PRIORITY: 'color_mm3jz8vj',
        REQUESTED_BY: 'multiple_person_mm3jv3wx',
        CUSTOMER: 'dropdown_mm3jf5w6',
        ORDER_DATE: 'date_mm3j6pr5',
        EPICOR_JOB: 'text_mm3jpez7',
        PART_NUMBER: 'text_mm3jn77d',
        PART_DESCRIPTION: 'long_text_mm3jfbh6',
        QUANTITY: 'numeric_mm3jkav5',
        CX_ALLOY_ID: 'text_mm46fzkm',
        TRACKING_NUMBER: 'text_mm3jqzdr',
        DATE_SHIPPED: 'date_mm3jybr7',
        PURCHASE_ORDER: 'text_mm3jydkz',
        SUPPLIER_ORDER_DATE: 'date_mm3jestv',
        SUPPLIER_TRACKING: 'text_mm3jt8wp'
    }
};
