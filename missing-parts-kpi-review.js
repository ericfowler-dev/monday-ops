// Display historical evidence without promoting reconstruction to accepted actuals.
const crypto = require('node:crypto');
const { sourceRecord, calculate, monthBounds, METRICS } = require('./missing-parts-kpi-core');
const { mapRaw, indexEvents, rewind, centralDay } = require('./missing-parts-kpi-evidence');
const config = require('./snap-orders-report.config');
function withHistoricalReview(prepared, { rawItems, logs, columns = [], now, unavailableIds = [] }) {
    const candidate = structuredClone(prepared.candidate), view = structuredClone(prepared.view);
    const items = [...new Map(rawItems.map(mapRaw).map(i => [i.id, i])).values()];
    const events = indexEvents(logs, columns);
    const times = logs.map(l => Math.round(Number(l.created_at) / 10000)).filter(Number.isFinite);
    const earliestLog = times.length ? new Date(Math.min(...times)).toISOString() : null;
    const earliestCreation = items.map(i => i.createdAt).filter(Boolean).sort()[0];
    function calculation(records, month, cutoff, exceptions = []) {
        const recordKeys = records.map(record => {
            const key = `${record.id}:${crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0,20)}`;
            candidate.records[key] = record;
            return key;
        }).sort();
        return calculate(candidate, { cutoff, capturedAt: new Date(now).toISOString(), recordKeys,
            snapshotId: crypto.createHash('sha256').update(JSON.stringify({cutoff,recordKeys})).digest('hex'),
            source: {kind:'reconstructed', title:'Retained Order Tracker records and activity; not accepted actuals', reference:`monday:${config.BOARD_ID}`},
            completeness:{newIssues:false,backorders:false},exceptions }, month);
    }
    view.periods = view.periods.map(period => {
        if (period.status !== 'unavailable' || !earliestLog || period.month < centralDay(earliestLog).slice(0,7)) return period;
        const cutoff = monthBounds(period.month).end;
        // Migrated items have original Order Dates before their Monday creation.
        // Intake uses retained issue dates; backlog requires actual cutoff evidence.
        const retained = items.map(i => sourceRecord(i,[`monday:${config.BOARD_ID}:${i.id}`]));
        const intake = calculation(retained,period.month,new Date(now).toISOString());
        const exceptions = unavailableIds.map(id=>({id:String(id),reason:'Historical source item unavailable',metrics:['newIssues','backorders']}));
        const backlogAvailable = earliestCreation && period.month >= centralDay(earliestCreation).slice(0,7) && earliestLog <= cutoff;
        const boundary = [];
        if(backlogAvailable) for(const item of items) {
            const prior=rewind(item,events.get(item.id),cutoff);
            if(prior.state==='notCreated')continue;
            const record=sourceRecord(prior,[`monday:${config.BOARD_ID}:${item.id}`,...prior.evidence]);
            // Missing issue-date history does not invalidate known status/category.
            const unresolved=prior.uncertain.filter(reason=>!reason.startsWith('orderDate:'));
            if(unresolved.length){exceptions.push({id:item.id,reason:unresolved.join('; '),metrics:['backorders']});record.state='unavailable';}
            boundary.push(record);
        }
        const result=calculation(boundary,period.month,cutoff,exceptions);
        for(const id of ['factoryNew','fieldNew']){result.totals[id]=intake.totals[id];result.contributions[id]=intake.contributions[id];}
        if(!backlogAvailable)for(const id of ['factoryBackorders','fieldBackorders','combinedBackorders']){result.totals[id]=null;result.contributions[id]=[];}
        result.status='reconstructed';result.complete=false;result.intakeCutoff=intake.cutoff;
        result.exceptions.push(...intake.exceptions);
        result.exceptionCount=result.exceptions.length;
        result.note='New issues are observed retained lines by Order Date, using current classification and cancellation. Backorders are reconstructed at month-end. Historical figures may omit unavailable records; review before acceptance.';
        return result;
    });
    view.omittedUnavailableMonths=view.periods.filter(p=>!p.totals).map(p=>p.month);
    view.periods=view.periods.filter(p=>p.totals);
    view.historicalReview=true;
    return {...prepared,candidate,view};
}
module.exports={withHistoricalReview};
