# Open SNAP Orders daily report

This report reads the **Order Tracker** board and tracks three independent
operational populations:

- Factory SNAP orders
- Field Missing Parts orders
- Field Warranty orders

- Board: `18414349860`
- View: `269601790`
- SNAP group: `group_title`
- Field Service group: `topics`
- Field Service view: `263347143`
- Schedule: 5:00 AM `America/Chicago` every day
- Initial recipient: `efowler@psiengines.com`

## Report logic

The whole-board overview counts active lines from all four main-table groups.
The three detailed operational sections use the **Order Type** column together
with the Factory and Field Service groups. Service, Sales Order, ambiguous
multi-select values, Drafts, and Missing Part Factory Requests remain visible as
the remainder in the active total rather than being folded into a requested
bucket. An item is open when its **Current Dept / Status** is not `Shipped`.
`Shipped to Darien` remains open because it is an active internal workflow
stage on the board.

Daily snapshots separately retain Factory SNAP, Field Missing Parts, Field
Warranty, and remainder totals and counts by **Current Dept / Status**. Each
requested population has its own headline
metrics, seven-day stage changes, aging, recent snapshots, and attention queue.
Each requested population also shows new orders in the last 7 and 30 calendar
days based on **Order Date**.
The overview shows unique items closed over the last 7, 14, and 30 calendar days.
For current rows, an item is closed when **Current Dept / Status** is `Shipped`;
its **Date Shipped** determines the reporting window. Monday's board activity
history supplies a fallback completion date and recovers completed records that
are no longer present on the active board. The recent-shipment table remains
limited to the last seven calendar days.

## Commands

```powershell
npm run snap:preview
npm run snap:report
```

Preview mode fetches live Monday data and writes HTML under `exports/` without
sending mail. The normal command enforces the 5:00 AM Central schedule; use
`node generate-snap-orders-report.js --force` for an intentional test delivery.

## Production

Create the Render cron service from `render-snap.yaml`. The cron invokes the
script at both UTC offsets that can correspond to 5:00 AM Central; the script's
`America/Chicago` check handles daylight-saving time.

Configure the Monday API token, Microsoft Graph application credentials, sender
UPN, and Redis URL listed in the manifest. Redis preserves trend snapshots and
the last successful delivery across cron runs. Override the initial recipient
with `SNAP_REPORT_TO_EMAIL` using semicolon- or comma-separated addresses.
