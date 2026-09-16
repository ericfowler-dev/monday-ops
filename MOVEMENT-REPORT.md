# Consolidated daily movement report

The Open Order Workflow Movement Report replaces the Open Parts Orders email.
Production entry point: `generate-dynamic-owner-preview.js --send`.
Render service: `crn-d9pngpcs728c73bt9050` (`daily-movement-report`).
Schedule: **5 AM America/Chicago, Monday-Friday**, including daylight-saving changes.

## What readers see

- Four headline numbers: open lines, shipped in the last 7 completed days,
  lines waiting over 24 hours, and High/Critical priority lines.
- Factory SNAP and Field Service sections with open workload, new open lines
  by Order Date, waiting, and shipments. Field Service shows Missing Parts,
  Warranty and Other/mixed counts that sum to the Field total.
- A 14-day daily shipment bar chart in each section, including zero days;
  last 7 days versus previous 7 days, plus 7/14/30-day totals.
- Person activity bars, a weekly activity heat table, bottleneck bars,
  aging distribution and concise department queue tables.

Detailed order/customer/tracking information remains in the live Monday views.
The report covers Factory SNAP and Field Service, not the whole board's drafts
and other factory request groups. Counts are board lines, not ordered quantity.

## Cancellation and shipment rules

Current `Cancelled` items are excluded before activity, ownership, priority,
aging, closure or shipment aggregation. Historical person trends store the
contributing item IDs (snapshot version 3); each report rechecks their current
status and removes cancelled or no-longer-retrievable items from past totals.
Legacy aggregate-only snapshots are not charted. Retain the old history for
rollback and rebuild recent weeks with item evidence before cutover.

Only items currently `Shipped` count as shipped. `Shipped to Darien` remains
open. Reopened items do not count as shipped. Count each item once, using
`Date Shipped`, or the latest valid Shipped activity timestamp if no date exists.
Bulk events are expanded to individual item IDs; undo and unchanged-status
events do not count. Historical records are fetched by ID where available;
unavailable shipment records are disclosed and not guessed.

Shipment outcomes include automated status updates; person credit continues
to exclude Monday automation. The daily charts and 7/14/30-day totals end
**yesterday in Central time**. Today-so-far is separate, so comparisons use
equal complete periods. Activity scorecards retain the trailing 7-day window.
Historical activity columns end on the date shown; the current window can
overlap the newest historical column, so no misleading cross-column total
is shown.

Activity reads split automatically when Monday's per-request record cap is hit.
The script fails rather than quietly publishing a truncated interval.

## Delivery and recipient changes

`MOVEMENT_REPORT_TO_EMAIL` is the sole distribution setting in production.
Copy the current saved SNAP distribution at cutover, not the old delivery logs.
Addresses are trimmed, normalized and deduplicated; invalid/empty production
lists fail instead of falling back to a default recipient.
Both report manifests use `sync: false` for recipients, so future Blueprint
updates preserve the saved distribution instead of restoring a hardcoded list.

**After changing recipients in Render, deploy the service.** A saved environment
value does not replace the deployed value until a deployment occurs. Selecting
Save only or just triggering another cron run can leave the old list active.
See https://render.com/docs/configure-environment-variables.

Verify the actual deployed configuration without sending email:

```text
node generate-dynamic-owner-preview.js --check-delivery-config
```

Render invokes both UTC hours (`0 10,11 * * 1-5`). The script skips the unused
daylight-saving companion hour. Dashboard **Trigger Run** at other times sends
the report immediately if it has not already been delivered that day. A manual
run in the unused companion hour requires `--force` via a one-off job.
Redis delivery markers and a short send lock protect against duplicate same-day
delivery, including repeated manual runs. Weekly history still
writes only on Mondays; it is separate from daily delivery markers.

## Verification and history rebuild

```text
npm run movement:test
npm run snap:test
npm run movement:preview
node backfill-dynamic-history.js --force --include-anchor --weeks 7 --apply
```

Preview mode reads live data and writes HTML under `exports/`; it sends no
email and changes no history. Backfill is dry-run unless `--apply` is supplied.
Backfill records reconstruct activity, not historical open/priority/aging
state, and are labelled partial. Run production backfills as Render one-off
jobs to reach the private Redis datastore.

## Retired service and rollback

`snap-orders-daily-report` (`crn-d9b9bk57vvec73caaem0`) is to remain suspended
after the replacement is verified. Its script also disables delivery by default;
`SNAP_REPORT_ENABLED=1` is required for an intentional rollback. Dry-run previews
still work. Shared SNAP configuration and the PDX-Monday Redis datastore must
remain: the replacement imports that configuration and retains its own history.

To roll back, first suspend movement, explicitly enable SNAP, redeploy SNAP
with the current distribution, and then resume SNAP. Never resume both email
jobs together. No board data or Redis history is deleted during cutover.
