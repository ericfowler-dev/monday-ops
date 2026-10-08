// One calculation model for the email, monthly CSV and item-level extract.
const crypto = require('node:crypto');
const { category, day, centralDay, indexEvents, rewind } = require('./missing-parts-kpi-evidence');
const config = require('./snap-orders-report.config');
const METRICS = [
    ['factoryNew', 'Factory SNAPs - New Issues'], ['fieldNew', 'Field Missing Parts - New Issues'],
    ['factoryBackorders', 'Factory SNAPs - Backorders'], ['fieldBackorders', 'Field Snaps - Backorders'],
    ['combinedBackorders', 'Combined backorders']
];
const REPORT_METRICS = METRICS.filter(([id]) => id !== 'combinedBackorders');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
function emptyState() {
    return { version: 1, revision: 0, initializedAt: null, lastCapturedAt: null,
        records: {}, ledger: {}, daily: {}, boundaries: {}, periods: {}, audit: [] };
}
function validateState(state) {
    if (state.version !== 1 || !Number.isInteger(state.revision) || !state.records || !state.ledger
        || !state.daily || !state.boundaries || !state.periods || !Array.isArray(state.audit)) throw new Error('Invalid KPI store; refusing to reset or replace history.');
    return state;
}
function shiftMonth(month, count) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid KPI month.');
    const date = new Date(`${month}-15T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + count);
    return date.toISOString().slice(0, 7);
}
function centralMidnight(dateKey) {
    if (!day(dateKey)) throw new Error('Invalid cutoff day.');
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    let guess = Date.parse(`${dateKey}T00:00:00Z`);
    const target = guess;
    for (let n = 0; n < 3; n++) {
        const values = Object.fromEntries(parts.formatToParts(new Date(guess)).map(p => [p.type, p.value]));
        const local = Date.UTC(+values.year, +values.month - 1, +values.day, +values.hour, +values.minute, +values.second);
        guess += target - local;
    }
    return new Date(guess).toISOString();
}
function monthBounds(month) {
    return { start: centralMidnight(`${month}-01`), end: centralMidnight(`${shiftMonth(month, 1)}-01`) };
}
function sourceRecord(item, sourceIds = []) {
    const date = day(item.orderDate);
    return { id: String(item.id), name: item.name || '', groupId: item.groupId || '',
        category: category(item.groupId, item.type), type: item.type || '', status: item.status || '', state: item.state,
        orderDate: date, createdAt: item.createdAt || '', customer: item.customer || '', part: item.part || '',
        url: item.url || '', sourceIds: [...new Set(sourceIds.map(String))].sort() };
}
function putRecord(state, record) {
    const key = `${record.id}:${hash(record).slice(0, 20)}`;
    state.records[key] = record;
    return key;
}
function snapshot(state, records, { cutoff, capturedAt, source, completeness, exceptions }) {
    const keys = records.map(r => putRecord(state, r)).sort();
    const result = { cutoff, capturedAt, source, completeness, exceptions, exceptionCount: exceptions.length,
        recordKeys: keys, snapshotId: hash({ cutoff, keys, source, completeness, exceptions }) };
    return result;
}
function calculate(state, captured, month) {
    const contributions = Object.fromEntries(METRICS.map(([id]) => [id, []]));
    const exceptions = [...captured.exceptions];
    for (const key of captured.recordKeys) {
        const r = state.records[key];
        if (!r) throw new Error(`Missing frozen record ${key}`);
        if (!['factory', 'field'].includes(r.category)) {
            if (r.category === 'mixed') exceptions.push({ id: r.id, reason: 'Mixed Warranty / Missing Parts type excluded', metrics: [] });
            continue;
        }
        if (r.state === 'unavailable') continue;
        const prefix = r.category === 'factory' ? 'factory' : 'field';
        const cancelled = r.status.trim().toLowerCase() === 'cancelled';
        // Both new issues and backlog use the same cutoff record. Shipping does
        // not remove an issue; cancellation after an accepted cutoff cannot edit it.
        if (!cancelled && r.state !== 'deleted' && r.orderDate.startsWith(month)) contributions[`${prefix}New`].push(key);
        if (!r.orderDate && !cancelled && r.state !== 'deleted') exceptions.push({ id: r.id, reason: 'Missing Order Date; issue month unavailable', metrics: [`${prefix}New`] });
        if (r.state === 'active' && !cancelled && r.status.trim().toLowerCase() !== 'shipped') {
            if (!r.status.trim()) exceptions.push({ id: r.id, reason: 'Missing status; backorder eligibility unresolved', metrics: [`${prefix}Backorders`] });
            else contributions[`${prefix}Backorders`].push(key);
        }
    }
    contributions.combinedBackorders = [...contributions.factoryBackorders, ...contributions.fieldBackorders];
    for (const keys of Object.values(contributions)) if (new Set(keys.map(k => state.records[k].id)).size !== keys.length) throw new Error('Duplicate KPI source item ID.');
    const totals = Object.fromEntries(METRICS.map(([id]) => [id, contributions[id].length]));
    if (totals.combinedBackorders !== totals.factoryBackorders + totals.fieldBackorders) throw new Error('KPI combined backlog does not reconcile.');
    const complete = captured.completeness.newIssues && captured.completeness.backorders && !exceptions.some(e => e.metrics?.length);
    return { month, cutoff: captured.cutoff, capturedAt: captured.capturedAt, source: captured.source,
        snapshotId: captured.snapshotId, completeness: captured.completeness, complete, exceptions,
        exceptionCount: exceptions.length, totals, contributions, status: 'pending', revision: 1 };
}
function capture(state, { items, logs = [], columns = [], now, unavailableIds = [], activityFrom, fullBoardRead = true }) {
    validateState(state);
    const next = clone(state), at = new Date(now).toISOString(), today = centralDay(at), month = today.slice(0, 7);
    if (next.lastCapturedAt && at < next.lastCapturedAt) throw new Error('Capture precedes the latest ledger observation.');
    const uniqueItems = [...new Map(items.map(i => [String(i.id), i])).values()];
    const events = indexEvents(logs, columns);
    const exceptions = unavailableIds.map(id => ({ id: String(id), reason: 'Source item could not be retrieved', metrics: ['newIssues', 'backorders'] }));
    const records = uniqueItems.map(item => {
        const previous=next.records[next.ledger[String(item.id)]?.latestRecordKey];
        const ids=(events.get(String(item.id))||[]).filter(e=>['create_pulse','move_pulse_from_group','archive_pulse','delete_pulse','restore_pulse','delete_group_pulse','batch_delete_pulses'].includes(e.event)
            ||[config.COL_IDS.ORDER_TYPE,config.COL_IDS.CURRENT_STATUS,config.COL_IDS.ORDER_DATE,config.COL_IDS.CUSTOMER,config.COL_IDS.PART_NUMBER].includes(e.data.column_id)).map(e=>String(e.id));
        return sourceRecord(item,[...(previous?.sourceIds||[]),`monday:${config.BOARD_ID}:${item.id}`,...ids]);
    });
    const known = new Set(records.map(r => r.id));
    for(const id of unavailableIds.map(String)) if(!known.has(id)&&!next.ledger[id]) {
        records.push({ id, name:'Unretrieved source item', groupId:'', category:'unresolved', type:'', status:'', state:'unavailable',
            orderDate:'', createdAt:'', customer:'', part:'', url:'', sourceIds:(events.get(id)||[]).map(e=>String(e.id)) });
        known.add(id);
    }
    for (const [id, entry] of Object.entries(next.ledger)) {
        if (known.has(id)) continue;
        const last = next.records[entry.latestRecordKey];
        // An absent line is preserved as evidence rather than disappearing from history.
        if (last) {
            records.push({ ...last, state: 'unavailable' });
            if (['factory', 'field', 'unresolved'].includes(last.category) && !exceptions.some(e => e.id === id)) exceptions.push({ id, reason: 'Previously observed line absent from capture', metrics: ['newIssues', 'backorders'] });
        }
    }
    const priorCapture = next.lastCapturedAt;
    next.initializedAt ||= at;
    const current = snapshot(next, records, { cutoff: at, capturedAt: at,
        source: { kind: 'observation', boardId: config.BOARD_ID, title: 'Live Order Tracker capture' },
        completeness: { newIssues: next.initializedAt <= monthBounds(month).start && fullBoardRead && !exceptions.length,
            backorders: fullBoardRead && !exceptions.length }, exceptions });
    next.daily[today] ||= [];
    if (!next.daily[today].some(s => s.snapshotId === current.snapshotId)) next.daily[today].push(current);
    for (const record of records) {
        const key = putRecord(next, record), entry = next.ledger[record.id] ||= { firstSeenAt: at, revisions: [] };
        entry.lastSeenAt = record.state === 'unavailable' ? entry.lastSeenAt : at;
        if (entry.latestRecordKey !== key) entry.revisions.push({ recordKey: key, observedAt: at });
        entry.latestRecordKey = key;
    }
    // Only boundaries crossed AFTER ledger initialization may be reconstructed
    // automatically. The POC's old reconstructions are never historical actuals.
    if (priorCapture) {
        let boundaryMonth = shiftMonth(centralDay(priorCapture).slice(0, 7), 1);
        while (monthBounds(boundaryMonth).start <= at) {
            const cutoff = monthBounds(boundaryMonth).start, closedMonth = shiftMonth(boundaryMonth, -1);
            if (cutoff > priorCapture && !next.boundaries[closedMonth]) {
                const boundaryExceptions = [...exceptions];
                const boundaryRecords = [];
                const evidenceCovered = activityFrom && new Date(activityFrom).toISOString() <= cutoff;
                for (const item of uniqueItems) {
                    const prior = rewind(item, events.get(String(item.id)), cutoff);
                    if (prior.state === 'notCreated') continue;
                    if (prior.uncertain.length) boundaryExceptions.push({ id: String(item.id), reason: prior.uncertain.join('; '), metrics: ['newIssues', 'backorders'] });
                    const record = sourceRecord(prior, prior.evidence);
                    if (prior.uncertain.length) record.state = 'unavailable';
                    boundaryRecords.push(record);
                }
                for (const record of records.filter(r => r.state === 'unavailable')) if (!boundaryRecords.some(r => r.id === record.id)) boundaryRecords.push(record);
                if (!evidenceCovered) boundaryExceptions.push({ reason: 'Activity evidence does not cover month-end cutoff', metrics: ['newIssues', 'backorders'] });
                const boundary = snapshot(next, boundaryRecords, { cutoff, capturedAt: at,
                    source: { kind: 'boundary', boardId: config.BOARD_ID, title: 'Month-end from observed ledger and boundary activity' },
                    completeness: { newIssues: next.initializedAt <= monthBounds(closedMonth).start && evidenceCovered && fullBoardRead && !boundaryExceptions.length,
                        backorders: evidenceCovered && fullBoardRead && !boundaryExceptions.length }, exceptions: boundaryExceptions });
                next.boundaries[closedMonth] = boundary;
            }
            boundaryMonth = shiftMonth(boundaryMonth, 1);
        }
    }
    next.lastCapturedAt = at;
    next.audit.push({ at, action: 'capture', snapshotId: current.snapshotId, items: records.length, exceptionCount: exceptions.length });
    next.revision++;
    return next;
}
function latestObservation(state) {
    return Object.values(state.daily).flat().sort((a, b) => b.cutoff.localeCompare(a.cutoff))[0];
}
function buildView(state, now, count = 12) {
    validateState(state);
    const currentMonth = centralDay(now).slice(0, 7), latest = latestObservation(state);
    const periods = Array.from({ length: count }, (_, i) => {
        const month = shiftMonth(currentMonth, i - count + 1);
        if (state.periods[month]) return clone(state.periods[month].versions.at(-1));
        const captured = month === currentMonth ? latest : state.boundaries[month];
        if (!captured || centralDay(captured.cutoff).slice(0, 7) !== (month === currentMonth ? month : shiftMonth(month, 1))) return { month, status: 'unavailable', totals: null, exceptionCount: 0, source: null };
        const result = calculate(state, captured, month);
        result.status = month === currentMonth ? 'mtd' : 'pending';
        return result;
    });
    return { title: 'Missing Parts KPI — by month', timeZone: config.TIME_ZONE,
        generatedAt: new Date(now).toISOString(), metrics: REPORT_METRICS, periods,
        initializedAt: state.initializedAt, lastCapturedAt: state.lastCapturedAt };
}
function importControl(state, control, { actor, reason, now }) {
    validateState(state);
    const month = control.month, bounds = monthBounds(month);
    if (!actor?.trim() || !reason?.trim()) throw new Error('Historical import requires reviewer and reason.');
    if (control.source?.kind !== 'authoritative' || !control.source.title?.trim() || !control.source.reference?.trim()) throw new Error('Backfill requires an authoritative source title and reference; POC/reconstructed controls are not accepted.');
    if (control.cutoff !== bounds.end || !control.completeness?.newIssues || !control.completeness?.backorders) throw new Error('Control must cover all issue lines and backlog at exact Central month-end.');
    if (!Array.isArray(control.records) || (!control.records.length && (!control.totals || METRICS.some(([id]) => control.totals[id] !== 0)))) throw new Error('Control requires item-level source records, or an explicit authoritative all-zero control.');
    if (control.cutoff > new Date(now).toISOString()) throw new Error('Cannot backfill a future month-end.');
    const ids = new Set();
    for (const r of control.records) {
        if (!r.id || ids.has(String(r.id)) || !['factory', 'field', 'warranty', 'mixed', 'otherField', 'outside'].includes(r.category)
            || !['active', 'archived', 'deleted'].includes(r.state) || typeof r.status !== 'string'
            || (r.orderDate && day(r.orderDate) !== r.orderDate) || !Array.isArray(r.sourceIds) || !r.sourceIds.length) throw new Error('Invalid/duplicate historical source record or missing source IDs.');
        ids.add(String(r.id));
    }
    const next = clone(state);
    const captured = snapshot(next, control.records.map(r => ({ ...r, id: String(r.id), orderDate: r.orderDate || '' })), {
        cutoff: control.cutoff, capturedAt: new Date(now).toISOString(), source: { ...control.source, contentHash: hash(control) },
        completeness: control.completeness, exceptions: control.exceptions || [] });
    const candidate = calculate(next, captured, month);
    if (control.totals && METRICS.some(([id]) => control.totals[id] !== candidate.totals[id])) throw new Error('Authoritative control totals do not reconcile to source rows.');
    if (next.periods[month]) throw new Error('Accepted period is frozen; use an explicit correction.');
    next.boundaries[month] = captured;
    next.audit.push({ action: 'import-control', month, actor, reason, at: captured.capturedAt, source: captured.source });
    next.revision++;
    return next;
}
function acceptPeriod(state, month, { actor, reason, now }) {
    if (!actor?.trim() || !reason?.trim()) throw new Error('Acceptance requires reviewer and reason.');
    if (state.periods[month]) throw new Error('Accepted period is frozen.');
    const source = state.boundaries[month];
    if (!source || source.cutoff !== monthBounds(month).end || source.cutoff > new Date(now).toISOString()) throw new Error('No eligible completed month-end source.');
    const next = clone(state), period = calculate(next, source, month);
    if (!period.complete) throw new Error('Incomplete period cannot be accepted; resolve exceptions or supply authoritative controls.');
    Object.assign(period, { status: 'accepted', acceptedBy: actor, acceptedAt: new Date(now).toISOString(), reason });
    next.periods[month] = { versions: [period] };
    next.audit.push({ action: 'accept', month, actor, reason, at: period.acceptedAt, snapshotId: period.snapshotId });
    next.revision++;
    return next;
}
function correctPeriod(state, control, { actor, reason, now }) {
    if (!state.periods[control.month]) throw new Error('Only an accepted period can be corrected.');
    const next = clone(state), existing = clone(next.periods[control.month]);
    delete next.periods[control.month];
    const imported = importControl(next, control, { actor, reason, now });
    const corrected = acceptPeriod(imported, control.month, { actor, reason, now });
    const version = corrected.periods[control.month].versions[0];
    version.revision = existing.versions.length + 1;
    version.status = 'corrected';
    corrected.periods[control.month].versions = [...existing.versions, version];
    corrected.audit.push({ action: 'correct', month: control.month, actor, reason, at: version.acceptedAt,
        previousSnapshotId: existing.versions.at(-1).snapshotId, snapshotId: version.snapshotId });
    return corrected;
}
module.exports = { METRICS, REPORT_METRICS, emptyState, validateState, shiftMonth, centralMidnight, monthBounds,
    sourceRecord, capture, calculate, latestObservation, buildView, importControl, acceptPeriod, correctPeriod };
