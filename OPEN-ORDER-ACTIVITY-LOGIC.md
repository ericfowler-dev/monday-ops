# Open Order Activity Report — Logic Summary

This is the concise cross-reference for the dynamic-owner preview. The report answers two different questions:

1. Which person or department was accountable when work occurred?
2. Which Monday user actually performed the change?

Those values may be different and are deliberately reported separately.

## 1. Population classification

| Visible Monday group | Internal group ID | Order Type requirement | Report population |
|---|---|---|---|
| SNAPs | `group_title` | Contains `SNAP` | Factory SNAP |
| SNAPs | `group_title` | Does not contain `SNAP` | Excluded from Factory SNAP |
| Field Service Orders | `topics` | Any | Field Service |
| Order Drafts (Not ready to assign) | `group_mm4dcjc9` | Any | Outside owner metrics; actor activity remains visible |

`Current Dept / Status` does not select the population. It selects the accountable owner after the group/Order Type population is established.

## 2. Status-to-owner cross-reference

| Current Dept / Status | SNAP owner | Field Service owner |
|---|---|---|
| New Item - Requires Assignment | Vanessa Bonilla-Aguirre | Vanessa Bonilla-Aguirre |
| Purchasing | Jack Richards | Jack Richards |
| FAB | Jessica Hernandez | Jessica Hernandez |
| Beloit WH | Mark Rodriguez | Mark Rodriguez |
| In PC | Jack Richards | Jack Richards |
| Pick/Materials (Darien) | Mark Rodriguez | Mark Rodriguez |
| Staged in Darien | Thania Sandoval | Thania Sandoval |
| Shipped to Darien | Mark Rodriguez | Mark Rodriguez |
| Approved for Shipment | Jessica Sanchez | Jessica Sanchez |
| Project Management | Clare Heckert | Clare Heckert |
| Customer Supplied | Fernando Morales | Fernando Morales |
| Field Service | Ambrea Ayala | Ambrea Ayala |
| Shipment Complication | Thania Sandoval | Thania Sandoval |
| Pending Shipment Approval | Clare Heckert | Ambrea Ayala |
| Awaiting Full Order | Informational—no person exception | Informational—no person exception |
| Ordered from Supplier | Informational—no person exception | Informational—no person exception |
| Shipped | Closed | Closed |
| Cancelled | Closed (excluded from open orders; Eric 8/18) | Closed (excluded from open orders; Eric 8/18) |
| Any unmapped value | `Unmapped — check config` | `Unmapped — check config` |

"Closed" statuses are terminal for this report: the item leaves Current open, owner metrics, and waiting exceptions; a transition into a closed status records as the prior owner handing off to `Closed — <status>` and counts toward "Closed / shipped this period". Note the cancelled exclusion is movement-report-only (`CLOSED_CURRENT_STATUSES` override in `weekly-movement-report.config.js`); the daily SNAP report still lists cancelled lines.

## 3. What qualifies as activity

| Category | Qualifying examples |
|---|---|
| Workflow | Current Dept / Status, Update Status, Demand Status |
| Order setup | CX Alloy ID, Quantity, Order Date |
| Supplier | Purchase Order, Supplier Lead Time, Date Ordered from Supplier/Customer, Tracking from Supplier, Expected Delivery Date |
| Shipping | Tracking/DDL #, Date Shipped, Shipping Method, Shipping Approval Status, Shipping Approved By |
| Movement | Moving an item into or out of SNAPs or Field Service Orders |

Undo records, same-value edits, cosmetic edits, notes, and columns outside this allowlist do not qualify.

Priority and Date Shipped are additionally fetched as **values** (for the critical-lines and closure-time stats). Priority is deliberately **not** a qualifying activity column — changing a priority label earns no action credit. Critical lines are items whose Priority matches `CRITICAL_PRIORITY_REGEX` in `weekly-movement-report.config.js` (default `/critical/i`).

## 4. Attribution rules

| Event | Who receives action credit? | What happens next? |
|---|---|---|
| Status A → Status B | Owner of Status A | Owner of Status B receives the item; handoff recorded if owner changes |
| Qualifying operational edit | Owner of the status active at that moment | Item remains with that owner |
| Move out of a report group | Current source owner | Handoff out recorded |
| Move into a report group | No source-owner action if coming from Draft/outside | Destination owner receives the item |
| Activity while in Draft | No accountable-owner credit | Monday user remains visible under Performed by |
| Multiple events for same owner and item | One distinct Actioned relationship | All raw events remain as supporting evidence |

An order can credit multiple owners during the same week when each owner acts during their own stage.

## 5. Metric definitions

| Metric | Definition |
|---|---|
| Current open | Unique open orders currently in the population, including the unowned stages (Ordered from Supplier, Awaiting Full Order) |
| Received | Distinct owner-item relationships newly assigned during the seven-day window |
| Actioned | Distinct owner-item relationships with at least one qualifying action during the window |
| Handed off (briefly "Moved Onward"; reverted per stakeholder feedback 8/10) | Distinct owner-item relationships that transitioned to another owner, outside group, informational stage, or closed stage |
| Net flow | Received minus Handed off; positive means assignments accumulated during the period |
| Waiting >24h | Current owner has had no qualifying action since receiving/acting on the item for more than 24 hours |
| Waiting % | Waiting >24h divided by current assigned owner-item relationships |
| Median wait | Median time since last qualifying activity across current assigned relationships; values marked `≥` are lower bounds truncated by the seven-day window |
| Activity coverage | Current assigned relationships with at least one qualifying action in the seven-day window, divided by current assigned relationships |
| Closed / shipped | Unique orders that transitioned to a closed status while in the population during the window |
| 7-day activity rate (was % acted) | Actioned divided by eligible owner-item relationships (actioned during the window or currently waiting >24h), each relationship counted once |
| Aging distribution | Current assigned relationships bucketed by order age (Order Date, falling back to creation date); unowned stages excluded |
| Where work is stuck | Current open work grouped by status with waiting counts, waiting %, median time since activity, and oldest order age (top 6 statuses shown) |
| Critical lines open | Open items in either population whose Priority matches the critical regex; "most critical lines held" credits the accountable owner of the current assignment (criticals in an unowned stage report under "Ordered from Supplier / Awaiting Full Order") |
| Avg critical age | Mean order age of open critical lines that have an order/creation date |
| Avg shipment closure | Mean of (Date Shipped − Order Date, falling back to creation date) across orders closed this period; orders missing either date count as closed but not measurable |
| Median dwell | Median time an order sat with an owner before they handed it off this week; `≥` marks episodes that began at the window edge |
| Oldest order | Greatest order age among an owner's current items, with the order date. Unlike waiting/dwell this comes from the Order Date column, so it is NOT truncated by the seven-day window — it is the direct equivalent of the "Oldest" column in Richard's analysis |
| Weekly actioned trend | Per-person actioned counts per stored weekly snapshot (both populations combined), current week appended; hidden until `TREND_MIN_WEEKS` weeks exist, showing at most `TREND_MAX_WEEKS` |

Any duration marked `≥` is a lower bound: the report reads seven days of history, so quiet items may have been waiting longer than shown.

### Renames and layout (August 2026)

The redesign renamed: Needs attention now → Items Requiring Attention · Performed by → Activity Evidence · % acted → 7-day activity rate. The former "Past 6 wks" scorecard column (order age > 42 days) was replaced by the aging distribution table. "Handed off" was briefly renamed "Moved Onward" and then reverted after Ambrea's 8/10 feedback explicitly requested "Owner actioned" / "Handed off" as the two headline numbers.

The 8/10 feedback revision restructured the email: the owner scorecard now shows two numbers per person (Actioned, Handed off) with inline bars and a ★ top-mover highlight; full per-owner metrics moved to "Owner detail" appendix tables (adding Median dwell). Removed from the email entirely: Items Requiring Attention (briefly a one-line callout, dropped 8/18 per Eric — waiting exposure remains via the KPI cards, owner detail, and Where work is stuck), Owner handoffs, Activity Evidence — performed by, Recent qualifying events, What counted as activity, and the Factory SNAP vs Field Service comparison (the underlying computations remain in `dynamic-owner-activity-core.js` for the console summary and data-quality card). Added: "This week's highlights" (critical lines + closure time) and the "Weekly actioned trend" heat table.

### Data quality card

The report opens with a data quality card counting: current assignments with unmapped ownership, qualifying events by unknown/system users, qualifying events by unresolved user IDs, historical items no longer retrievable, and whether the 10,000-record activity API limit was hit. Unmapped or unresolved entries are not individual performance results.

### Weekly snapshot storage

Delivery-mode runs (not previews or dry runs) persist a weekly snapshot (`buildWeeklySnapshot` in `dynamic-owner-activity-core.js`) via `dynamic-owner-history-store.js` — Redis keys `dynamic:history` / `dynamic:last-run` when `REDIS_URL` is set, otherwise a local `history-dynamic-owner.json` fallback (ephemeral on Render). Retention is 26 weeks. Snapshot failure is non-fatal and logged after the email sends.

Snapshot **v2** (8/2026 feedback revision) adds: per-item `priority`/`isCritical`, per-owner `medianDwellHours`/`medianDwellLowerBound`/`dwellSampleHours`, and top-level `critical`/`closure` blocks. Trend readers tolerate v1 weeks (missing fields read as absent). The report now also **reads** history at render time to build the Weekly actioned trend — verify `REDIS_URL` is populated on the Render service or the trend never accumulates. Multi-week dwell medians and return-loop rate remain deferred until enough v2 snapshots accrue.

**Snapshots persist only on the scheduled weekday** (Monday, `TIME_ZONE`) as of 8/18: delivery runs on any other day — validation-period daily sends, Trigger Runs, post-deploy runs — email accurate trailing-7-day data but skip the history write, keeping the trend one snapshot per week. During the approval/testing period the Render schedule is `0 10 * * 1-5` (5 AM Central weekdays, CDT); once the report is approved it returns to `0 10,11 * * 1` (Monday only, DST-safe).

## 6. Fact-check recipe

For any questioned line:

1. Read the raw item group ID/title and Order Type to confirm population.
2. Read Current Dept / Status and the owner table to confirm current accountability.
3. Pull all board activity records for the item in the seven-day window.
4. Remove undo, same-value, and non-allowlisted events.
5. Replay status and group changes in timestamp order to reconstruct the owner at each event.
6. Compare the raw `user_id` (performed by) with the reconstructed accountable owner.

## 7. Running the report

Local current preview:

```powershell
cd C:\Users\efowler\monday-ops
npm run movement:dynamic-preview
```

Render supports manual cron runs from the `weekly-movement-report` service's **Runs** page using **Trigger Run**. The deployed command is `node generate-dynamic-owner-preview.js --send`; it emails the dynamic report with subject `Open Order Workflow Movement Report MM/DD/YYYY`. Of the two Monday UTC cron invocations used for daylight-saving coverage, only the one corresponding to 5:00 AM America/Chicago sends. A Trigger Run outside that scheduled window is treated as manual and sends immediately. Delivery runs also store the weekly snapshot (see section 5); confirm `REDIS_URL` is populated on the Render service or snapshots land on the ephemeral disk and are lost.

### Ownership map alignment (2026-08-19)

`OWNER_MAP` now mirrors the "Who owns what — by Current Dept / Status" table Richard published in his 8/17 analysis, so this report and his manual email attribute the same work to the same people. Changes made: In PC → Jack Richards, Pick/Materials (Darien) → Mark Rodriguez, Shipped to Darien → Mark Rodriguez, Staged in Darien → Thania Sandoval (all four previously credited Jessica Sanchez), and Awaiting Full Order became informational (previously Clare Heckert / Ambrea Ayala).

Where Richard names a primary owner plus collaborators — Pick/Materials and Shipped to Darien are "Mark Rodriguez with Jessica Sanchez and Stacie Knutsen" — the primary owner carries the accountability, matching how his own scorecard scores those rows. The collaborators are recorded as comments in the config. Stacie Knutsen owns no status outright and therefore never appears as an owner.

Two statuses are now ownerless rather than one, so "informational" is resolved through the owner map (any status mapped to `null`) instead of matching the single string "Ordered from Supplier". Where they are reported together the label is "Ordered from Supplier / Awaiting Full Order", matching Richard's combined row.
