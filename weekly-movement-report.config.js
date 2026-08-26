const base = require('./snap-orders-report.config');

module.exports = {
    MONDAY_SLUG: base.MONDAY_SLUG,
    BOARD_ID: base.BOARD_ID,
    BOARD_NAME: base.BOARD_NAME,
    VIEW_ID: base.VIEW_ID,
    FIELD_SERVICE_VIEW_ID: base.FIELD_SERVICE_VIEW_ID,
    // Ambrea's management overview. The movement email links here from the
    // bottleneck chart so readers can drill into the live status view.
    OVERVIEW_VIEW_ID: '259431125',
    SNAP_GROUP_ID: base.SNAP_GROUP_ID,
    FIELD_SERVICE_GROUP_ID: base.FIELD_SERVICE_GROUP_ID,
    COL_IDS: base.COL_IDS,
    TIME_ZONE: base.TIME_ZONE,
    // Base treats only "Shipped" as done. This report also treats "Cancelled" as
    // terminal (Eric 8/18) so cancelled lines leave open-order and owner metrics;
    // the daily SNAP report keeps base behavior.
    CLOSED_CURRENT_STATUSES: [...base.CLOSED_CURRENT_STATUSES, 'Cancelled'],

    SCHEDULE_WEEKDAY: 1, // Monday (0 = Sunday)
    SCHEDULE_HOUR: 5,
    HISTORY_RETENTION_WEEKS: 26,
    PAST_DUE_DAYS: 42,
    CLOSED_LOOKBACK_DAYS: 7,
    CALLOUT_THRESHOLD_POINTS: 20,
    SHIPPING_GATE_STATUSES: ['Pending Shipment Approval', 'Approved for Shipment'],
    DEFAULT_RECIPIENT: 'efowler@psiengines.com',

    // Priority labels that count as critical lines. The daily SNAP report treats
    // /critical|high/i as attention-worthy; this report tracks true criticals only.
    CRITICAL_PRIORITY_REGEX: /critical/i,
    // Weekly actioned trend: hide the section until this many stored weeks exist,
    // and show at most this many trailing weeks.
    TREND_MIN_WEEKS: 2,
    TREND_MAX_WEEKS: 8,

    // Monday's built-in automation actor. It generates more board changes than any
    // person, so it is kept out of person-level scorecards and the weekly trend.
    EXCLUDED_ACTOR_IDS: ['-4'],

    // The board has no Owner column, so ownership follows Current Dept / Status.
    // Confirmed with Ambrea (Richard's 8/4 email); Shipment Complication added
    // per Eric 8/18. Values:
    //   string                  same owner for SNAP and Field Service lines
    //   { snap, fieldService }  split ownership by population
    //   null                    informational status - no owner, reported on its own row
    // Mirrors the "Who owns what — by Current Dept / Status" table Richard
    // published in his 8/17 analysis. Where he names a primary owner plus
    // collaborators, the primary owner carries the accountability (his own
    // scorecard scores it that way); collaborators are noted in comments.
    OWNER_MAP: {
        'New Item - Requires Assignment': 'Vanessa Bonilla-Aguirre',
        'Purchasing': 'Jack Richards',
        'In PC': 'Jack Richards', // hands off to Pick/Materials once back from PC
        'FAB': 'Jessica Hernandez',
        'Beloit WH': 'Mark Rodriguez',
        'Pick/Materials (Darien)': 'Mark Rodriguez', // with Jessica Sanchez and Stacie Knutsen
        'Shipped to Darien': 'Mark Rodriguez', // with Jessica Sanchez and Stacie Knutsen
        'Staged in Darien': 'Thania Sandoval',
        'Shipment Complication': 'Thania Sandoval',
        'Approved for Shipment': 'Jessica Sanchez', // after Thania provides a DDL pick-up date
        'Project Management': 'Clare Heckert',
        'Customer Supplied': 'Fernando Morales',
        'Field Service': 'Ambrea Ayala',
        'Pending Shipment Approval': { snap: 'Clare Heckert', fieldService: 'Ambrea Ayala' },
        'Awaiting Full Order': null, // nothing moves until the full order is ready
        'Ordered from Supplier': null // supplier lead time, not anyone's queue
    }
};
