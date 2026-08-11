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
| In PC | Jessica Sanchez | Jessica Sanchez |
| Pick/Materials (Darien) | Jessica Sanchez | Jessica Sanchez |
| Staged in Darien | Jessica Sanchez | Jessica Sanchez |
| Shipped to Darien | Jessica Sanchez | Jessica Sanchez |
| Approved for Shipment | Jessica Sanchez | Jessica Sanchez |
| Project Management | Clare Heckert | Clare Heckert |
| Customer Supplied | Fernando Morales | Fernando Morales |
| Field Service | Ambrea Ayala | Ambrea Ayala |
| Pending Shipment Approval | Clare Heckert | Ambrea Ayala |
| Awaiting Full Order | Clare Heckert | Ambrea Ayala |
| Ordered from Supplier | Informational—no person exception | Informational—no person exception |
| Shipped | Closed | Closed |
| Any unmapped value | `Unmapped — check config` | `Unmapped — check config` |

## 3. What qualifies as activity

| Category | Qualifying examples |
|---|---|
| Workflow | Current Dept / Status, Update Status, Demand Status |
| Order setup | CX Alloy ID, Quantity, Order Date |
| Supplier | Purchase Order, Supplier Lead Time, Date Ordered from Supplier/Customer, Tracking from Supplier, Expected Delivery Date |
| Shipping | Tracking/DDL #, Date Shipped, Shipping Method, Shipping Approval Status, Shipping Approved By |
| Movement | Moving an item into or out of SNAPs or Field Service Orders |

Undo records, same-value edits, cosmetic edits, notes, and columns outside this allowlist do not qualify.

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
| Current open | Unique open orders currently in the population, including informational supplier-waiting stages |
| Received | Distinct owner-item relationships newly assigned during the seven-day window |
| Actioned | Distinct owner-item relationships with at least one qualifying action during the window |
| Moved Onward (was Handed off) | Distinct owner-item relationships that transitioned to another owner, outside group, informational stage, or closed stage |
| Net flow | Received minus Moved Onward; positive means assignments accumulated during the period |
| Waiting >24h | Current owner has had no qualifying action since receiving/acting on the item for more than 24 hours |
| Waiting % | Waiting >24h divided by current assigned owner-item relationships |
| Median wait | Median time since last qualifying activity across current assigned relationships; values marked `≥` are lower bounds truncated by the seven-day window |
| Activity coverage | Current assigned relationships with at least one qualifying action in the seven-day window, divided by current assigned relationships |
| Closed / shipped | Unique orders that transitioned to a closed status while in the population during the window |
| 7-day activity rate (was % acted) | Actioned divided by eligible owner-item relationships (actioned during the window or currently waiting >24h), each relationship counted once |
| Aging distribution | Current assigned relationships bucketed by order age (Order Date, falling back to creation date); supplier-waiting items excluded |
| Where work is stuck | Current open work grouped by status with waiting counts, waiting %, median time since activity, and oldest order age |
| Activity Evidence (was Performed by) | Raw Monday `user_id` evidence; this identifies the actor and does not replace accountable-owner attribution |

Any duration marked `≥` is a lower bound: the report reads seven days of history, so quiet items may have been waiting longer than shown.

### Renames (August 2026 redesign)

Handed off → Moved Onward · Needs attention now → Items Requiring Attention · Performed by → Activity Evidence · % acted → 7-day activity rate. The former "Past 6 wks" scorecard column (order age > 42 days) was replaced by the aging distribution table.

### Data quality card

The report opens with a data quality card counting: current assignments with unmapped ownership, qualifying events by unknown/system users, qualifying events by unresolved user IDs, historical items no longer retrievable, and whether the 10,000-record activity API limit was hit. Unmapped or unresolved entries are not individual performance results.

### Weekly snapshot storage

Delivery-mode runs (not previews or dry runs) persist a weekly snapshot (`buildWeeklySnapshot` in `dynamic-owner-activity-core.js`) via `dynamic-owner-history-store.js` — Redis keys `dynamic:history` / `dynamic:last-run` when `REDIS_URL` is set, otherwise a local `history-dynamic-owner.json` fallback (ephemeral on Render). Retention is 26 weeks. Snapshot failure is non-fatal and logged after the email sends. Trend sections (week-over-week charts, owner trend indicators, true dwell time, return-loop rate) are deferred until enough snapshots accrue.

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
