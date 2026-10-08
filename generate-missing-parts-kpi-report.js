require('dotenv').config({quiet:true});
const fs=require('node:fs'),path=require('node:path');
const {createKpiStore}=require('./missing-parts-kpi-store');
const {createHistoryStore}=require('./dynamic-owner-history-store');
const {prepareKpi,writeKpiExtract}=require('./missing-parts-kpi-runtime');
const {collectKpiSource}=require('./missing-parts-kpi-source');
const {withHistoricalReview}=require('./missing-parts-kpi-review');
const {renderKpiTable,graphAttachments,escapeHtml}=require('./missing-parts-kpi-render');
const {centralDay}=require('./missing-parts-kpi-evidence');
const {sendEmail}=require('./generate-dynamic-owner-preview');
const ZONE='America/Chicago';
function scheduleConfig(env=process.env){
    const hour=Number(env.MISSING_PARTS_KPI_SEND_HOUR??7),weekday=Number(env.MISSING_PARTS_KPI_WEEKDAY??1);
    if(!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(weekday)||weekday<0||weekday>6)throw new Error('Invalid KPI schedule hour/weekday.');
    return {hour,weekday};
}
function deliveryDue(now,options=scheduleConfig()){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:ZONE,day:'2-digit',hour:'numeric',hourCycle:'h23',weekday:'short'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));
    return Number(parts.hour)===options.hour&&(Number(parts.day)===1||['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday)===options.weekday);
}
function recipients(env=process.env){
    const result=[...new Set(String(env.MISSING_PARTS_KPI_TO_EMAIL||'efowler@psiengines.com').split(/[;,]/).map(s=>s.trim().toLowerCase()).filter(Boolean))];
    if(!result.length||result.some(s=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)))throw new Error('Invalid Missing Parts KPI recipients.');
    return result;
}
function renderEmail(prepared){
    const {view}=prepared,current=view.periods.at(-1),monthEnd=view.periods.filter(p=>p.status!=='mtd').at(-1);
    const summary=monthEnd?`${monthEnd.month}: ${monthEnd.totals.factoryNew} Factory new issues; ${monthEnd.totals.fieldNew} Field new issues; ${monthEnd.totals.factoryBackorders??'unavailable'} Factory backorders; ${monthEnd.totals.fieldBackorders??'unavailable'} Field backorders. ${monthEnd.status==='reconstructed'?'Historical estimate — review required.':''}`:'No completed month has sufficient source evidence yet.';
    const stamp=new Intl.DateTimeFormat('en-US',{timeZone:ZONE,dateStyle:'medium',timeStyle:'short'}).format(new Date(view.lastCapturedAt));
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Missing Parts KPI Report</title></head><body style="margin:0;background:#eef2f7;font-family:Arial,sans-serif;color:#172033"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 10px"><table role="presentation" width="100%" style="max-width:1000px;background:white;border:1px solid #dce3ed" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 28px;background:#103b42;color:white"><div style="font-size:25px;font-weight:700">Missing Parts KPI Report</div><div style="font-size:12px;margin-top:8px">Weekly and first-of-month · ${escapeHtml(stamp)} Central</div></td></tr><tr><td style="padding:20px 28px;line-height:1.6"><b>Latest completed month</b><br>${escapeHtml(summary)}${current?.status==='mtd'?`<br><b>${current.month} month to date:</b> ${current.totals.factoryNew} Factory new; ${current.totals.fieldNew} Field new; ${current.totals.factoryBackorders} Factory open; ${current.totals.fieldBackorders} Field open.`:''}</td></tr>${renderKpiTable(view,{email:true})}<tr><td style="padding:20px 28px;line-height:1.6;font-size:12px;color:#526078">Attached: monthly KPI summary and supporting source lines. Counts are order lines, not quantity. New issues include shipped lines. Backorders are all open, non-cancelled Factory SNAP and Field Missing Parts lines; Warranty is excluded. This report is independent of the movement report's seven-day activity and shipment totals.<br>Delivery: Mondays and the first of every month at 7:00 AM Central. One email when dates overlap.</td></tr></table></td></tr></table></body></html>`;
}
async function main(argv=process.argv.slice(2)){
    const flags=new Set(argv),option=name=>{const i=argv.indexOf(name);if(i<0)return;if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`${name} needs a value.`);return argv[i+1];};
    const schedule=scheduleConfig(),to=recipients();
    if(flags.has('--check-delivery-config')){console.log(JSON.stringify({recipients:to,timezone:ZONE,...schedule,firstOfMonth:true,deduplicateOverlap:true}));return;}
    const send=flags.has('--send')&&!flags.has('--dry-run');
    const sourceFile=option('--source-file');
    if(sourceFile&&(send||process.env.RENDER==='true'))throw new Error('Frozen sources are restricted to local previews; never emailed.');
    const fixture=sourceFile?JSON.parse(fs.readFileSync(sourceFile,'utf8')):null;
    const now=fixture?new Date(fixture.fetchedAt):new Date();
    if(send&&!flags.has('--force')&&!deliveryDue(now,schedule)){console.log('No email due: Monday/first-of-month at configured Central hour.');return;}
    const store=await createKpiStore({filePath:option('--state')});
    try{
        const prior=await store.read(),source=await collectKpiSource(prior,{fixture,now,history:true});
        const observed=prepareKpi(prior,{...source,logs:source.captureLogs,unavailableIds:source.captureUnavailableIds});
        const prepared=withHistoricalReview(observed,source);
        prepared.attachments=graphAttachments(prepared.candidate,prepared.view);
        const directory=option('--output-dir')||path.join(__dirname,'exports','missing-parts-kpi',centralDay(now));
        writeKpiExtract(prepared,directory);
        const html=renderEmail(prepared),output=path.join(directory,'missing-parts-kpi-email-preview.html');
        fs.writeFileSync(output,html,'utf8');
        if(send){
            if(!process.env.REDIS_URL)throw new Error('REDIS_URL required for scheduled KPI delivery protection.');
            const delivery=await createHistoryStore({deliveryNamespace:'missing-parts-kpi'}),key=centralDay(now);
            let claimed=false;
            try{
                claimed=await delivery.claimDelivery(key);
                if(!claimed){console.log('KPI report already delivered or in progress today.');return;}
                // Save observations, never provisional reconstruction as accepted history.
                await store.save(observed.candidate,prior.revision);
                await sendEmail(html,now,prepared.attachments,{recipients:to,subject:`Missing Parts KPI Report — ${key}${Number(key.slice(-2))===1?' · Month-end':''}`});
                await delivery.markDelivered(key);
            }finally{if(claimed)await delivery.releaseDelivery(key);await delivery.close();}
        }
        console.log(JSON.stringify({mode:send?'emailed':'preview only',output,recipients:to,schedule:'Monday and first of month, 7 AM America/Chicago',periods:prepared.view.periods.map(p=>({month:p.month,status:p.status,totals:p.totals}))},null,2));
        if(!send)console.log('No email sent; no history written.');
    }finally{await store.close();}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main,deliveryDue,scheduleConfig,recipients,renderEmail};
