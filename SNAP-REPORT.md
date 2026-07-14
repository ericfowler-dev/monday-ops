# Open SNAP Orders daily report

This report reads the **Order Tracker** board and links to the **Open SNAP Orders**
table view:

- Board: `18414349860`
- View: `269601110`
- SNAP group: `group_title`
- Schedule: 5:00 AM `America/Chicago` every day
- Initial recipient: `efowler@psiengines.com`

## Report logic

An item is included when it is active, belongs to the SNAPs group, and its
**Current Dept / Status** is not `Shipped`. `Shipped to Darien` remains open
because it is an active internal workflow stage on the board.

Daily snapshots retain the total backlog and counts by **Current Dept / Status**.
The email includes headline metrics, seven-day stage changes, aging, priorities,
top customers, recent snapshots, and an attention queue.

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
