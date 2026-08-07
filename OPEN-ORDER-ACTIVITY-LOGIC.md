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
| Handed off | Distinct owner-item relationships that transitioned to another owner, outside group, informational stage, or closed stage |
| Waiting >24h | Current owner has had no qualifying action since receiving/acting on the item for more than 24 hours |
| Waiting >=7d | No qualifying action was found in the available seven-day history; actual waiting time may be longer |
| Past 6 weeks | Current order age exceeds 42 days using Order Date, with item creation as fallback |
| % acted | Actioned divided by eligible owner-item relationships (actioned during the window or currently waiting >24h), each relationship counted once |
| Performed by | Raw Monday `user_id` evidence; this identifies the actor and does not replace accountable-owner attribution |

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

Render supports manual cron runs from the `weekly-movement-report` service's **Runs** page using **Trigger Run**. The deployed command is `node generate-dynamic-owner-preview.js --send`; it emails the dynamic report. Of the two Monday UTC cron invocations used for daylight-saving coverage, only the one corresponding to 5:00 AM America/Chicago sends. A Trigger Run outside that scheduled window is treated as manual and sends immediately.
