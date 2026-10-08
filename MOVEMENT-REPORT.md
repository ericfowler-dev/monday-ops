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

## Missing Parts KPI implementation (deployed October 8, 2026)

Following Eric's review, the KPI is a separate email, with four rows: Factory
SNAPs - New Issues; Field Missing Parts - New Issues; Factory SNAPs - Backorders;
Field Snaps - Backorders. Each measure counts distinct order lines, not part
quantities. Combined backorders are omitted from the email and CSV extracts.
It does not use seven-day activity/shipment aggregation.
The movement email omits KPI collection/sections by default; the optional
`MISSING_PARTS_KPI_ENABLED=1` integration is retained for future use.

The standalone entry point is `generate-missing-parts-kpi-report.js --send`.
The new services deploy the dedicated `missing-parts-kpi-report` branch, leaving
the existing movement service on `main` at its prior deployed commit.
Email service: `crn-db3sds7lk1mc73co8ig0` (`missing-parts-kpi-report`).
Capture service: `crn-db3se02d0e5s73bcok30` (`missing-parts-kpi-capture`).
Initial live capture succeeded against Redis with 1,156 ledger items. A production
verification email with both CSV attachments was sent to efowler@psiengines.com
on October 8, 2026 at 11:44 AM Central. All 77 calculation, rendering and schedule
tests passed. Both jobs are active with automatic code deployment disabled;
future changes require an explicit Render deploy.
Confirmed distribution: **efowler@psiengines.com, Mondays and the first of each
month at 7:00 AM America/Chicago**, observing daylight-saving changes. An overlap
produces one email. Both CSVs are attached; the focused HTML extract uses the same
calculation and evidence. Separate Redis delivery keys prevent a movement email
from suppressing a KPI email. Graph attachment format:
https://learn.microsoft.com/en-us/graph/api/user-sendmail.

**Definitions:** calendar months in America/Chicago; distinct Monday line IDs by
Order Date, including already shipped lines. Factory = SNAPs group + SNAP type.
Field = Field Service Orders + Missing Parts, excluding Warranty/mixed types.
Backorders = active unshipped, non-cancelled lines at the exact month-end cutoff;
Shipped to Darien remains open. The cutoff's status and category govern historical
intake and backlog. Missing dates/status and unretrievable lines remain exceptions.
Accepted values never follow later current-status cancellation filters.

`missing-parts-kpi-core.js` owns calculation, item-version ledger, daily snapshots,
month-end boundaries, acceptance and explicit corrections. Immutable source
versions store item IDs, category, status, Order Date and activity/control source
IDs. Snapshots record cutoff, capture time, source, completeness and exceptions.
The separate Redis key is `missing-parts-kpi:v1`, with atomic revision checks;
production refuses an ephemeral file fallback. Local development uses
`history-missing-parts-kpi.json`, atomically saved and gitignored. Concurrent writers
fail and must reload, rather than overwrite another capture/correction. Daily
observations and accepted source versions are append-only; no automatic retention
purge removes accepted periods.

**Deployment configuration:** `render-missing-parts-kpi.yaml` declares the separate
email and collector jobs. The deployed services were created with the Render CLI;
required Monday, mail and Redis credentials were copied directly from the existing
movement service without storing secret values in the repository. Each service has
its own delivery/capture settings. The Blueprint's environment group provides the
equivalent configuration for future infrastructure management.
The email schedule is `0 12,13 * * *` UTC, with a Central day/hour guard that sends
only Mondays or the first, including weekend firsts. Both deployments are live;
the initial live capture verified durable Redis persistence. Run the mail-free collector every
calendar day (including weekends), at `0 9,10 * * *` UTC (4 AM Central), with command
`node capture-missing-parts-kpi.js --apply`, the same `MONDAY_API_TOKEN` and durable
`REDIS_URL`. Its local-time guard skips the unused DST companion hour. Keep the
movement email on its existing weekday 5 AM schedule. The separate KPI email and
collector use the same store; 4 AM collection precedes the 7 AM email. If
changing that hour, align the UTC schedule and `MISSING_PARTS_KPI_CAPTURE_HOUR`.
The first run after a month boundary reconstructs exact midnight from item-level
activity; it never substitutes the morning open count for month-end.

**Historical evidence and controls:** available retained intake and reconstructed
backlog are now shown as labelled estimates rather than hidden until acceptance.
`missing-parts-kpi-review.js` overlays review values only on unavailable periods;
it never writes a historical boundary or accepted version. New issues use retained
Order Dates and current classification/cancellation; reconstructed backlog uses
cutoff classification/status. Unsupported backlog stays unavailable, not zero.
Accepted authoritative controls always override estimates. Entirely unsupported
months are omitted from the displayed matrix. Bootstrap in
the middle of a month leaves that month's intake coverage incomplete. A completed
boundary remains pending acceptance; exceptions block acceptance.

Admin commands default to review-only. `--apply` explicitly saves their changes:

```text
node manage-missing-parts-kpi.js --import control.json --reviewer "Eric Fowler" --reason "Verified monthly source"
node manage-missing-parts-kpi.js --accept 2026-09 --reviewer "Eric Fowler" --reason "Reconciled to approved control"
node manage-missing-parts-kpi.js --correct revised-control.json --reviewer "Eric Fowler" --reason "Documented correction"
```

Controls contain `month`, exact UTC `cutoff`, `source` with `kind: authoritative`,
`title` and `reference`, `completeness` for `newIssues` and `backorders`, and
`records` containing distinct `id`, `category`, cutoff `status`, `state`,
`orderDate` and nonempty `sourceIds`. Optional `totals` must reconcile to all five
computed metrics. Categories are `factory`, `field`, `warranty`, `mixed`,
`otherField` or `outside`. Corrections preserve prior versions, reviewer, reason
and the control's content hash. Use `--state local.json` for an isolated review
store; production requires Redis.

Read-only previews send no mail or history writes:

```text
npm run kpi:preview
node generate-missing-parts-kpi-report.js --source-file output/vince-kpi-poc/source-data.json --state output/vince-kpi-implementation/review-ledger.json --output-dir output/vince-kpi-weekly
npm run kpi:test
npm run movement:test
```

The source-file option is restricted to previews/dry runs. The collector's
`--source-file` option is also forbidden on Render. Preview capture projections
are not stored unless the separate collector is intentionally run with `--apply`.

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
