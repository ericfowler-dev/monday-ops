# Movement Report — Session Handoff, 2026-08-19

Updated 2026-08-21. The attribution flaw that was blocking distribution is fixed and
verified; section 1 records it for context. Nothing is blocking now — remaining work is
the open decisions in section 3 and Richard's items in section 4.

---

## 1. Attribution flaw — RESOLVED 2026-08-21 (was blocking)

Ambrea flagged on 8/19 that the report starred **Vanessa Bonilla-Aguirre** as Field
Service "TOP MOVER" (actioned 103) when she had not viewed the board in 7 days. She was
right. Of the 333 qualifying events credited to her she personally performed **one**;
Jack performed 282, Clare 32, Ambrea 18.

**Cause.** A status change credited the owner of the status being *left*. Vanessa owns
`New Item - Requires Assignment`, the intake queue every order passes through, so
triage performed by others accrued to her. Tell to watch for:
`actioned == handedOff == received` means pass-through, not work.

**Fix (Ambrea confirmed 8/21, shipped in `54c41b0`).** The two questions are now
answered by separate sections:

| Section | Keyed by | Answers |
|---|---|---|
| **Who moved work this week** (scorecard) | the Monday user who made the change | who did the work |
| **Department queue health** (owner detail) | the department owning the stage | whose queue is loaded / ageing |

Scorecard: **Actioned** = distinct orders that person changed; **Handed off** = distinct
orders they moved onward; ★ follows Actioned. Monday's automation actor (`-4`, 483
events in one week) is excluded via `EXCLUDED_ACTOR_IDS`.

**Verified after the fix:** Field Service top mover is now **Jack Richards (135)**;
Vanessa no longer appears. The weekly trend charts people too — Jack leads at 768 across
six columns. History was rebuilt with `--force --include-anchor` so every week uses the
same rules.

## 2. Current state — what is live

Branch `main`, Render cron `weekly-movement-report` (`crn-d9pngpcs728c73bt9050`),
deploy `54c41b0` live. Recent commits (each merged to main and auto-deployed):

| Commit | What |
|---|---|
| `3ad1b36` | Ambrea 8/10 feedback revision (2-number scorecard, bars, top-mover star, highlights, trend, removed 5 sections) |
| `8e346c5` | Removed waiting-orders callout under scorecards |
| `6de4aa1` | Shipment Complication → Thania; Cancelled → closed; Monday-only snapshots |
| `8cbc9d2` | Trend charts only scheduled-weekday snapshots; added prune script |
| `c284a43` | Trend column labels ("wk 8/17" / "This week"); added backfill script |
| `fede3c9` | OWNER_MAP aligned to Richard's published matrix; per-owner "Oldest order" |
| `54c41b0` | Scorecard + trend credit the person who made the change; automation excluded |

**Tests:** 41 passing — `npm run movement:test`.

**Schedule:** `0 10 * * 1-5` (5:00 AM Central weekdays) **for testing only**.
Recipient is `efowler@psiengines.com` only. On approval, flip to `0 10,11 * * 1`
(Monday only, DST-safe) via a single API PATCH — no code change.

**Trend history (Redis `dynamic:history`):** 5 weekly snapshots —
`2026-07-20, 07-27, 08-03, 08-10, 08-17`. All five were rebuilt from activity logs
under the corrected owner map AND the actor-based credit model.

---

## 3. Open decisions

1. **Critical priority scope** — currently `/critical/i`. The daily SNAP report uses
   `/critical|high/i`. Config: `CRITICAL_PRIORITY_REGEX`.
2. **Label monday automation** on the data-quality card. It currently shows as
   "Qualifying events by unresolved user IDs" (508 of 1,962 events on 8/18), which
   reads as a defect but is just `user_id -4`.
3. **Sections kept without Ambrea review** — "Where work is stuck" (top 6) and
   "Aging distribution" came from the 8/11 spec; she has not commented on them.
4. **Widening recipients** to Richard / Clare / Ambrea — the blocker is cleared; still Eric's call when to send. A proof-of-concept intro email is drafted.

## 4. Items raised by Richard, still unanswered

From `11AU thru 17AU Analysis from Richard.pdf` (his 8/17 email):

- **Every SNAP priority flag is Critical** (59 of them, zero High/Medium) — verified
  true on the board. He wants the rule for setting Critical on SNAP.
- **17 Field Service lines have no order date** — verified (9 Pick/Materials, 7 FAB,
  1 In PC; he said 9/8). Those lines cannot be aged.
- **Duplicate unit `201375-5` vs `201375-05`** — could NOT reproduce; no item named
  `201375-05` exists. There is a different problem: ten separate line items are named
  `201375-5`, including four identical `201375-5 SNAP-ENCLOSURE- Rev L` rows.
- His High/total flag counts (55/150) do not match the board (76/171); Critical
  matches exactly (59 SNAP + 31 Field = 90).

---

## 5. How to run things

```powershell
cd C:\Users\efowler\monday-ops
npm run movement:test        # 41 tests
npm run movement:preview     # live data, writes exports\ HTML, no email, no history write
```

**Redis is NOT reachable from a laptop** — the Key Value instance blocks non-allowlisted
IPs. Run anything that touches history as a **one-off Render job** instead (this works
on cron services and needs no firewall change):

```bash
KEY=$(grep -A1 '^api:' "$USERPROFILE/.render/cli.yaml" | grep 'key:' | sed 's/.*key:[[:space:]]*//' | tr -d '\r')
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"startCommand":"node backfill-dynamic-history.js"}' \
  "https://api.render.com/v1/services/crn-d9pngpcs728c73bt9050/jobs"
# logs (ownerId is the team id):
curl -s -H "Authorization: Bearer $KEY" \
  "https://api.render.com/v1/logs?ownerId=tea-d5ajdochg0os73cv5seg&resource=<jobId>&limit=80"
```

**Maintenance scripts** (both default to a dry run; add `--apply` to write):

- `prune-dynamic-history.js` — drops snapshots not written on the scheduled weekday.
  Refuses to run if every key is off-schedule.
- `backfill-dynamic-history.js` — rebuilds earlier weeks from activity logs.
  `--weeks N`, `--force`, `--include-anchor`.
  **Re-run with `--force --include-anchor` after ANY `OWNER_MAP` change or change to
  how credit is assigned**, or stored weeks keep the old attribution and the trend
  becomes internally inconsistent. The trend deliberately skips weeks stored before the
  actor-based switch rather than mixing the two measures.

---

## 6. Gotchas worth remembering

- **Render CLI token expires hourly.** `render login` may report "already
  authenticated" while the stored token is stale — check `api.expires_at` in
  `~/.render/cli.yaml`. Symptom is a bare `Unauthorized`.
- **Every deploy of this cron fires a run 1–3 minutes later**, which sends an email.
  Off-schedule runs are treated as manual by design.
- **monday activity-log retention ends ~2026-07-08.** Backfill beyond that returns
  zero events; weeks that reconstruct empty are deliberately not stored.
- **Reading Richard's PDFs:** subset fonts with broken ToUnicode. Pages 2–3 extract as
  clean ASCII; page 1 needs codepoint remapping (digits land in U+034F..U+0358).
- **`history-dynamic-owner.json`** is the local file fallback and is now gitignored.
- `generate-dynamic-owner-preview.js` is the **production** script despite the
  "preview" name. `generate-weekly-movement-report.js` is legacy/reference only.

---

## 7. File map

| File | Role |
|---|---|
| `generate-dynamic-owner-preview.js` | Production entry point: fetch, render, email, persist |
| `dynamic-owner-activity-core.js` | Pure computation (attribution, aggregation, trend, critical, closure) |
| `dynamic-owner-activity-core.test.js` | 41 tests |
| `weekly-movement-report.config.js` | `OWNER_MAP`, thresholds, board/group IDs |
| `dynamic-owner-history-store.js` | Redis + file-fallback snapshot store |
| `weekly-movement-core.js` | Shared label helpers — **also used by the legacy report, change with care** |
| `backfill-dynamic-history.js` | Rebuild earlier weeks from activity logs |
| `prune-dynamic-history.js` | Drop off-schedule snapshots |
| `OPEN-ORDER-ACTIVITY-LOGIC.md` | Authoritative logic cross-reference — keep in sync |
| `Order Tracker Automated Reports/` | Stakeholder docs, feedback, Richard's analyses |

---

## 8. Communications status

- **Ambrea:** confirmed the recommendation on 8/21 ("Agreed, and both of the points
  below sound like a good solution"). Fix shipped. She also promised more detailed
  feedback on the latest report — check for it.
- **Richard / Clare:** a proof-of-concept intro email is drafted (what it measures,
  when, how, definitions, and why it differs from his snapshot-diff method). It is now
  unblocked — send when Eric is ready.
- Nothing has been sent to anyone but Eric. The report has only ever emailed
  `efowler@psiengines.com`.
