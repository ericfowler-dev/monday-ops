# Open SNAP Orders daily report

This report reads the **Order Tracker** board and covers both factory-originated
SNAP/PIRF orders and field-issued orders:

- Board: `18414349860`
- View: `269601110`
- SNAP group: `group_title`
- Field Service group: `topics`
- Field Service view: `263347143`
- Schedule: 5:00 AM `America/Chicago` every day
- Initial recipient: `efowler@psiengines.com`

## Report logic

The whole-board overview counts active lines from all four main-table groups.
Detailed operational sections cover SNAPs and Field Service Orders, while Drafts
and Missing Part Factory Requests remain separately visible as intake. An item
is open when its **Current Dept / Status** is not `Shipped`.
`Shipped to Darien` remains open because it is an active internal workflow
stage on the board. All Field Service order-name formats are included; `S#`,
`W#`, and Sales Order names are types, not report filters.

Daily snapshots separately retain Factory SNAP/PIRF and Field Service totals and
counts by **Current Dept / Status**. Each population has its own headline
metrics, seven-day stage changes, aging, recent snapshots, and attention queue.
The report also recovers completed records from Monday's board activity history.
An item appears in the recent-shipment table only when **Current Dept / Status**
changed to `Shipped` in the last seven calendar days. **Date Shipped** and
tracking values are supporting details only because they can represent a partial
shipment. This remains accurate when a completed item has been deleted from the
active table.

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
