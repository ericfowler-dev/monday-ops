// Daily collector, including weekends. It sends no mail. --apply saves a capture.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { createKpiStore } = require('./missing-parts-kpi-store');
const { centralDay } = require('./missing-parts-kpi-evidence');
const { prepareKpi, writeKpiExtract } = require('./missing-parts-kpi-runtime');
const { collectKpiSource } = require('./missing-parts-kpi-source');
async function main(argv = process.argv.slice(2)) {
    const flags = new Set(argv), option = name => {
        const index = argv.indexOf(name);
        if(index<0)return undefined;
        if(!argv[index+1]||argv[index+1].startsWith('--'))throw new Error(`${name} requires a value.`);
        return argv[index+1];
    };
    const file = option('--source-file');
    const fixture = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    if(fixture&&process.env.RENDER==='true')throw new Error('Frozen sources cannot initialize a production collector.');
    const now = fixture ? new Date(fixture.fetchedAt) : new Date();
    // Run at 4 AM by default, before the 5 AM email, including weekends.
    const captureHour=Number(process.env.MISSING_PARTS_KPI_CAPTURE_HOUR||4);
    if(!Number.isInteger(captureHour)||captureHour<0||captureHour>23)throw new Error('Invalid KPI capture hour.');
    if(process.env.RENDER==='true'&&!flags.has('--force')) {
        const localHour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'numeric',hourCycle:'h23'}).format(now));
        if([(captureHour+5)%24,(captureHour+6)%24].includes(now.getUTCHours())&&localHour!==captureHour){console.log('Unused DST companion hour; no capture.');return;}
    }
    const store = await createKpiStore({ filePath: option('--state') });
    try {
        const prior = await store.read();
        const prepared=prepareKpi(prior,await collectKpiSource(prior,{fixture,now}));
        const directory=option('--output-dir')||path.join(__dirname,'exports','missing-parts-kpi',centralDay(now));
        const output=writeKpiExtract(prepared,directory);
        if(flags.has('--apply'))await store.save(prepared.candidate,prior.revision);
        console.log(JSON.stringify({mode:flags.has('--apply')?'capture saved':'preview only',store:store.kind,output,
            capturedAt:prepared.candidate.lastCapturedAt,ledgerItems:Object.keys(prepared.candidate.ledger).length,
            periods:prepared.view.periods.map(p=>({month:p.month,status:p.status,totals:p.totals,exceptions:p.exceptionCount}))},null,2));
        console.log('No email sent.');
    } finally { await store.close(); }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
