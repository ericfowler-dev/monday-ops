const test=require('node:test'),assert=require('node:assert/strict');
const core=require('./missing-parts-kpi-core');
const {deliveryDue,recipients,scheduleConfig,renderEmail}=require('./generate-missing-parts-kpi-report');
const {withHistoricalReview}=require('./missing-parts-kpi-review');
const {summaryCsv,detailRows}=require('./missing-parts-kpi-render');
const config=require('./snap-orders-report.config');
function raw(id,date='2026-09-10',status='Purchasing',created='2026-07-14T12:00:00Z'){
    return {id,name:'Issue line',state:'active',created_at:created,group:{id:config.SNAP_GROUP_ID},column_values:[
        {id:config.COL_IDS.ORDER_TYPE,text:'SNAP',value:null},{id:config.COL_IDS.CURRENT_STATUS,text:status,value:null},
        {id:config.COL_IDS.ORDER_DATE,text:date,value:null}]};
}
const historyLog={id:'retained-history',event:'create_pulse',created_at:String(Date.parse('2026-05-21T12:00:00Z')*10000),data:'{"pulse_id":"old"}'};
function review(state=core.emptyState(),items=[raw('1')],logs=[historyLog]){
    const now=new Date('2026-10-08T11:33:34Z');
    const view=core.buildView(state,now,10);
    return withHistoricalReview({candidate:state,view},{rawItems:items,logs,now});
}
test('Weekly and first-of-month delivery works through DST and weekend month starts',()=>{
    assert.equal(deliveryDue('2026-10-12T12:00:00Z'),true); // Monday CDT
    assert.equal(deliveryDue('2026-10-12T13:00:00Z'),false); // unused UTC companion
    assert.equal(deliveryDue('2026-10-13T12:00:00Z'),false);
    assert.equal(deliveryDue('2026-11-01T13:00:00Z'),true); // Sunday, CST after transition
    assert.equal(deliveryDue('2026-11-01T12:00:00Z'),false);
    assert.equal(deliveryDue('2026-11-02T13:00:00Z'),true);
    assert.equal(deliveryDue('2027-02-01T13:00:00Z'),true); // Monday and first share one delivery date
    assert.deepEqual(scheduleConfig({}),{hour:7,weekday:1});
    assert.deepEqual(recipients({}),['efowler@psiengines.com']);
});
test('Retained historical intake is visible without converting unsupported backlog to zero or freezing it',()=>{
    const p=review(core.emptyState(),[raw('may','2026-05-10'),raw('sep')]);
    const may=p.view.periods.find(x=>x.month==='2026-05'),sep=p.view.periods.find(x=>x.month==='2026-09');
    assert.equal(may.totals.factoryNew,1);assert.equal(may.totals.factoryBackorders,null);
    assert.equal(sep.totals.factoryNew,1);assert.equal(sep.totals.factoryBackorders,2);
    assert.equal(sep.status,'reconstructed');assert.equal(sep.complete,false);
    assert.equal(p.candidate.periods['2026-09'],undefined);assert.equal(p.candidate.boundaries['2026-09'],undefined);
    assert.ok(!p.view.periods.some(x=>x.month==='2026-01'));
    assert.match(summaryCsv(p.view),/"2026-05","1","0","Unavailable"/);
});
test('Later cancellations and post-cutoff shipments do not restate reconstructed historical backlog',()=>{
    const logs=[historyLog,...[['1','Cancelled'],['2','Shipped']].map(([id,status])=>({id:`change-${id}`,event:'update_column_value',created_at:String(Date.parse('2026-10-02T12:00:00Z')*10000),data:JSON.stringify({pulse_id:id,column_id:config.COL_IDS.CURRENT_STATUS,previous_value:{label:{text:'Purchasing'}},value:{label:{text:status}}})}))];
    const p=review(core.emptyState(),[raw('1','2026-09-10','Cancelled'),raw('2','2026-09-10','Shipped')],logs);
    const sep=p.view.periods.find(x=>x.month==='2026-09');assert.equal(sep.totals.factoryBackorders,2);
    // Retained intake is separately labelled current cancellation, not an accepted actual.
    assert.equal(sep.totals.factoryNew,1);
    assert.equal(detailRows(p.candidate,p.view).filter(r=>r.period==='2026-09'&&r.metric==='factoryBackorders').length,2);
});
test('Accepted controls take precedence over historical review estimates',()=>{
    const meta={actor:'Eric',reason:'Approved source',now:'2026-10-08T11:00:00Z'};
    const control={month:'2026-09',cutoff:core.monthBounds('2026-09').end,source:{kind:'authoritative',title:'Verified',reference:'control'},completeness:{newIssues:true,backorders:true},records:[],totals:Object.fromEntries(core.METRICS.map(([id])=>[id,0]))};
    const state=core.acceptPeriod(core.importControl(core.emptyState(),control,meta),'2026-09',meta);
    const p=review(state);assert.equal(p.view.periods.find(x=>x.month==='2026-09').status,'accepted');
    assert.equal(p.view.periods.find(x=>x.month==='2026-09').totals.factoryBackorders,0);
    assert.deepEqual(p.candidate.periods,state.periods);
    assert.match(renderEmail(p),/Missing Parts KPI Report/);
});
