const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./snap-orders-report.config');
const core = require('./missing-parts-kpi-core');
const evidence = require('./missing-parts-kpi-evidence');
const { createFileStore, createKpiStore, verifyWrite } = require('./missing-parts-kpi-store');
const { renderKpiTable, summaryCsv, detailRows, graphAttachments } = require('./missing-parts-kpi-render');
const sample = (overrides = {}) => ({ id: '1', name: 'Line', state: 'active', groupId: config.SNAP_GROUP_ID,
    type: 'SNAP', status: 'Purchasing', orderDate: '2026-10-10', createdAt: '2026-10-10T17:00:00Z', sourceIds: ['source-1'], ...overrides });
const capture = (state, now, items, extra = {}) => core.capture(state, { now, items, activityFrom: state.lastCapturedAt || core.monthBounds(String(now).slice(0, 7)).start, ...extra });
const control = (overrides = {}) => ({ month: '2026-09', cutoff: '2026-10-01T05:00:00.000Z',
    source: { kind: 'authoritative', title: 'Approved September item extract', reference: 'company-controls/september.csv' },
    completeness: { newIssues: true, backorders: true }, records: [core.sourceRecord(sample({ orderDate: '2026-09-10', createdAt: '2026-09-10T17:00:00Z' }), ['approved-source-1'])], ...overrides });
const meta = { actor: 'Reviewer', reason: 'Approved item-level control', now: '2026-10-08T12:00:00Z' };
function acceptedState() { return core.acceptPeriod(core.importControl(core.emptyState(), control(), meta), '2026-09', meta); }
test('Calendar cutoffs use Central DST, including spring and fall transition months', () => {
    assert.deepEqual(core.monthBounds('2026-03'), { start: '2026-03-01T06:00:00.000Z', end: '2026-04-01T05:00:00.000Z' });
    assert.deepEqual(core.monthBounds('2026-11'), { start: '2026-11-01T05:00:00.000Z', end: '2026-12-01T06:00:00.000Z' });
});
test('Initial capture leaves older months unavailable; current intake is explicitly incomplete', () => {
    const state = capture(core.emptyState(), '2026-10-15T10:00:00Z', [sample({ status: 'Shipped' }), sample({ id: '2', type: 'Missing Parts', groupId: config.FIELD_SERVICE_GROUP_ID })]);
    const view = core.buildView(state, '2026-10-15T10:00:00Z', 2);
    assert.equal(view.periods[0].status, 'unavailable'); assert.equal(view.periods[0].totals, null);
    assert.equal(view.periods[1].totals.factoryNew, 1); assert.equal(view.periods[1].totals.factoryBackorders, 0);
    assert.equal(view.periods[1].totals.combinedBackorders, 1); assert.equal(view.periods[1].completeness.newIssues, false);
});
test('Exact type/group classification excludes Warranty and mixed types; lines are not quantity', () => {
    const items = [sample({ qty: 1000 }), sample({ id: '2', type: 'Missing Parts', groupId: config.FIELD_SERVICE_GROUP_ID }),
        sample({ id: '3', type: 'Warranty', groupId: config.FIELD_SERVICE_GROUP_ID }), sample({ id: '4', type: 'Warranty, Missing Parts', groupId: config.FIELD_SERVICE_GROUP_ID }), sample({ id: '5', groupId: config.DRAFT_GROUP_ID })];
    const p = core.buildView(capture(core.emptyState(), '2026-10-15T10:00:00Z', items), '2026-10-15T10:00:00Z', 1).periods[0];
    assert.equal(p.totals.combinedBackorders, 2); assert.equal(p.totals.factoryNew, 1); assert.equal(p.totals.fieldNew, 1);
    assert.ok(p.exceptions.some(e => e.id === '4'));
});
test('Daily observations preserve prior item versions; archive/deletion cannot erase the ledger', () => {
    const first = capture(core.emptyState(), '2026-10-15T10:00:00Z', [sample()]);
    const second = capture(first, '2026-10-16T10:00:00Z', [sample({ status: 'Shipped', state: 'archived' })]);
    assert.equal(second.ledger['1'].revisions.length, 2);
    assert.equal(second.records[first.ledger['1'].latestRecordKey].status, 'Purchasing');
    assert.equal(core.buildView(second, '2026-10-16T10:00:00Z', 1).periods[0].totals.factoryNew, 1);
    assert.equal(Object.keys(second.daily).length, 2);
});
test('Repeated identical timestamp capture is idempotent for snapshot and ledger versions', () => {
    const first = capture(core.emptyState(), '2026-10-15T10:00:00Z', [sample()]);
    const second = capture(first, '2026-10-15T10:00:00Z', [sample()]);
    assert.equal(second.daily['2026-10-15'].length, 1); assert.equal(second.ledger['1'].revisions.length, 1);
});
test('Missing dates remain backlog exceptions and are not silently assigned to a month', () => {
    const p = core.buildView(capture(core.emptyState(), '2026-10-15T10:00:00Z', [sample({ orderDate: '' })]), '2026-10-15T10:00:00Z', 1).periods[0];
    assert.equal(p.totals.factoryNew, 0); assert.equal(p.totals.factoryBackorders, 1); assert.equal(p.complete, false);
    assert.match(p.exceptions[0].reason, /Missing Order Date/);
});
test('Unavailable source IDs persist in the ledger for later recovery and prevent false completeness', () => {
    const state = capture(core.emptyState(), '2026-10-15T10:00:00Z', [sample()], { unavailableIds: ['missing'] });
    const next = capture(state, '2026-10-16T10:00:00Z', [sample()]);
    assert.ok(next.ledger.missing); assert.equal(next.records[next.ledger.missing.latestRecordKey].state, 'unavailable');
    assert.ok(core.buildView(next, '2026-10-16T10:00:00Z', 1).periods[0].exceptions.some(e => e.id === 'missing'));
});
test('The first capture after a weekend reconstructs exact month-end, not the 5 AM current status', () => {
    const first = capture(core.emptyState(), '2026-10-01T05:00:00Z', [sample({ createdAt: '2026-09-01T12:00:00Z' })]);
    const logs = [{ id: 'shipment', event: 'update_column_value', created_at: String(Date.parse('2026-11-01T06:00:00Z') * 10000), data: JSON.stringify({ pulse_id: 1, column_id: config.COL_IDS.CURRENT_STATUS, previous_value: {label:{text:'Purchasing'}}, value:{label:{text:'Shipped'}} }) }];
    const next = capture(first, '2026-11-02T11:00:00Z', [sample({status:'Shipped',createdAt:'2026-09-01T12:00:00Z'})], { logs });
    assert.equal(next.boundaries['2026-10'].cutoff, '2026-11-01T05:00:00.000Z');
    const october = core.buildView(next, '2026-11-02T11:00:00Z', 2).periods[0];
    assert.equal(october.totals.factoryBackorders, 1); assert.equal(october.totals.factoryNew, 1); assert.equal(october.complete, true);
});
test('Boundary without covering activity cannot be accepted', () => {
    const first = capture(core.emptyState(), '2026-10-01T05:00:00Z', [sample()]);
    const next = capture(first, '2026-11-02T11:00:00Z', [sample()], { activityFrom: '2026-11-02T00:00:00Z' });
    assert.throws(() => core.acceptPeriod(next, '2026-10', {...meta,now:'2026-11-02T12:00:00Z'}), /Incomplete/);
});
test('Historical authoritative source totals reconcile before import; POC/reconstruction is rejected', () => {
    assert.throws(() => core.importControl(core.emptyState(), control({source:{kind:'reconstructed',title:'POC',reference:'poc.json'}}), meta), /authoritative/);
    assert.throws(() => core.importControl(core.emptyState(), control({ totals:{factoryNew:999} }), meta), /reconcile/);
    assert.throws(() => core.importControl(core.emptyState(), control(), {...meta,actor:''}), /reviewer/);
});
test('An explicit verified zero control is distinct from missing history', () => {
    const zero=control({records:[],totals:Object.fromEntries(core.METRICS.map(([id])=>[id,0]))});
    const accepted=core.acceptPeriod(core.importControl(core.emptyState(),zero,meta),'2026-09',meta);
    assert.equal(core.buildView(accepted,meta.now,2).periods[0].totals.combinedBackorders,0);
    assert.throws(()=>core.importControl(core.emptyState(),control({records:[]}),meta),/source records/);
});
test('Accepted periods are frozen across later cancellation, date edit and deletion', () => {
    const first = acceptedState(), frozen = structuredClone(first.periods['2026-09']);
    const next = capture(first, '2026-10-15T10:00:00Z', [sample({ status:'Cancelled',state:'deleted',orderDate:'2026-10-10' })]);
    assert.deepEqual(next.periods['2026-09'], frozen);
    assert.equal(core.buildView(next, '2026-10-15T10:00:00Z', 2).periods[0].totals.factoryNew, 1);
    assert.throws(() => core.acceptPeriod(next, '2026-09', meta), /frozen/);
    assert.throws(() => core.importControl(next, control(), meta), /frozen/);
});
test('Explicit corrections retain all accepted versions and reviewer/reason/source hashes', () => {
    const first = acceptedState(), correctedControl = control({ records:[core.sourceRecord(sample({status:'Shipped',orderDate:'2026-09-10'}),['corrected-source'])] });
    const next = core.correctPeriod(first, correctedControl, {...meta,reason:'Verified shipment before cutoff'});
    assert.equal(next.periods['2026-09'].versions.length,2);
    assert.deepEqual(next.periods['2026-09'].versions[0],first.periods['2026-09'].versions[0]);
    assert.equal(next.periods['2026-09'].versions[1].totals.factoryBackorders,0);
    assert.equal(next.periods['2026-09'].versions[1].status,'corrected');
    assert.equal(next.periods['2026-09'].versions[1].revision,2);
    assert.ok(next.periods['2026-09'].versions[1].source.contentHash);
});
test('File persistence is durable and detects stale revisions and corrupted history', async t => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'missing-kpi-'));t.after(()=>{
        assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'missing-kpi-'));
        fs.rmSync(dir,{recursive:true,force:true});
    });
    const file=path.join(dir,'state.json'),store=createFileStore(file),state=capture(core.emptyState(),'2026-10-15T10:00:00Z',[sample()]);
    await store.save(state,0);assert.deepEqual(await createFileStore(file).read(),state);
    await assert.rejects(()=>store.save(state,0),/concurrently/);
    fs.writeFileSync(file,'not json');await assert.rejects(()=>store.read());
});
test('Storage forbids editing accepted source rows, dropping snapshots or changing the audit trail', () => {
    const state=acceptedState(),next=structuredClone(state);next.revision++;
    const key=state.periods['2026-09'].versions[0].contributions.factoryNew[0];next.records[key].status='Shipped';
    assert.throws(()=>verifyWrite(state,next,state.revision),/source version/);
    const changed=structuredClone(state);changed.revision++;changed.audit=[];assert.throws(()=>verifyWrite(state,changed,state.revision),/append-only/);
});
test('Production refuses an ephemeral file fallback without Redis', async () => {
    await assert.rejects(()=>createKpiStore({redisUrl:'',requireDurable:true}),/REDIS_URL/);
});
test('Email table, CSV and attachments share exact totals and preserve unavailable values', () => {
    const state=acceptedState(),view=core.buildView(state,'2026-10-08T12:00:00Z',3),html=renderKpiTable(view,{email:true}),csv=summaryCsv(view);
    assert.match(html,/Missing Parts KPI — by month/);assert.equal((html.split('<tbody>')[1].split('</tbody>')[0].match(/<tr>/g)||[]).length,4);
    assert.match(csv,/Unavailable/);assert.match(csv,/"2026-09","1","0","1","0"/);
    assert.equal(detailRows(state,view).filter(r=>r.metric==='factoryNew').length,1);
    assert.equal(Buffer.from(graphAttachments(state,view)[0].contentBytes,'base64').toString('utf8'),csv);
});
test('Bulk evidence and exact boundary use the production evidence module', () => {
    const logs=[{id:'s',event:'update_column_value',created_at:String(Date.parse('2026-11-01T05:00:00Z')*10000),data:JSON.stringify({pulse_id:1,column_id:config.COL_IDS.CURRENT_STATUS,previous_value:{label:{text:'Purchasing',index:4}},value:{label:{text:'Shipped',index:1}},is_batch_action:true})},
        {id:'b',event:'batch_change_pulses_column_value',created_at:String(Date.parse('2026-11-01T05:00:02Z')*10000),data:JSON.stringify({pulse_ids:[1],column_id:config.COL_IDS.CURRENT_STATUS,value:{index:1},action_record_uuid:'bulk'})}];
    const prior=evidence.rewind(sample({status:'Shipped'}),evidence.indexEvents(logs).get('1'),'2026-11-01T05:00:00.000Z');
    assert.equal(prior.status,'Purchasing');assert.deepEqual(prior.uncertain,[]);
});
test('Deletion after month-end restores a retained line at the frozen boundary', () => {
    const log={id:'delete',event:'delete_pulse',created_at:String(Date.parse('2026-11-01T18:00:00Z')*10000),data:JSON.stringify({pulse_id:1})};
    assert.equal(evidence.rewind(sample({state:'deleted'}),evidence.indexEvents([log]).get('1'),'2026-11-01T05:00:00.000Z').state,'active');
});
