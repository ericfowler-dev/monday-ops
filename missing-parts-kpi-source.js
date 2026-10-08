const { fetchCurrentRelevantItems, fetchBoardColumns, fetchBoardActivity, fetchItemsById } = require('./generate-dynamic-owner-preview');
const { monthBounds } = require('./missing-parts-kpi-core');
const { centralDay } = require('./missing-parts-kpi-evidence');
const config=require('./snap-orders-report.config');
async function collectKpiSource(prior,{fixture,now,history=false}) {
    const activityFrom=prior.lastCapturedAt||monthBounds(centralDay(now).slice(0,7)).start;
    const historyFrom=monthBounds(`${centralDay(now).slice(0,4)}-01`).start;
    const from=history&&historyFrom<activityFrom?historyFrom:activityFrom;
    const [boardItems,logs,columns]=await Promise.all([
        fixture?fixture.items:fetchCurrentRelevantItems(true),
        fixture?fixture.logs.filter(l=>{const at=Math.round(Number(l.created_at)/10000);return at>=Date.parse(from)&&at<=new Date(now).getTime();}):fetchBoardActivity(new Date(from),new Date(now)),
        fixture?fixture.metadata.columns:fetchBoardColumns()
    ]);
    const known=new Set(boardItems.map(i=>String(i.id))),candidates=new Set(Object.keys(prior.ledger));
    for(const log of logs){let d;try{d=JSON.parse(log.data);}catch{continue;}for(const id of [d.pulse_id,d.pulse?.id,...(d.pulse_ids||[])].filter(Boolean))candidates.add(String(id));}
    const ids=[...candidates].filter(id=>!known.has(id));
    const recovered=fixture?fixture.recovered.filter(i=>ids.includes(String(i.id))):await fetchItemsById(ids,true);
    const rawItems=[...boardItems,...recovered.filter(i=>!i.board||String(i.board.id)===config.BOARD_ID)];
    const retrievable=new Set(rawItems.map(i=>String(i.id)));
    const captureLogs=logs.filter(l=>Math.round(Number(l.created_at)/10000)>=Date.parse(activityFrom));
    const captureIds=new Set(Object.keys(prior.ledger));
    for(const log of captureLogs){let d;try{d=JSON.parse(log.data);}catch{continue;}for(const id of [d.pulse_id,d.pulse?.id,...(d.pulse_ids||[])].filter(Boolean))captureIds.add(String(id));}
    return {rawItems,logs,columns,now,activityFrom,unavailableIds:ids.filter(id=>!retrievable.has(id)),
        captureLogs,captureUnavailableIds:[...captureIds].filter(id=>!retrievable.has(id))};
}
module.exports={collectKpiSource};
