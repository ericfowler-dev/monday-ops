// Review-first administration; --apply is the only path that changes the store.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { createKpiStore } = require('./missing-parts-kpi-store');
const { importControl, acceptPeriod, correctPeriod, buildView } = require('./missing-parts-kpi-core');
function parseArgs(argv) {
    const flags = new Set(argv), value = name => {
        const index = argv.indexOf(name);
        if (index < 0) return undefined;
        if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} requires a value.`);
        return argv[index + 1];
    };
    return { importFile: value('--import'), correctionFile: value('--correct'), accept: value('--accept'),
        actor: value('--reviewer'), reason: value('--reason'), filePath: value('--state'), apply: flags.has('--apply'), help: flags.has('--help') };
}
async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help || !options.importFile && !options.correctionFile && !options.accept) {
        console.log('Usage: node manage-missing-parts-kpi.js [--import control.json | --correct control.json | --accept YYYY-MM] --reviewer NAME --reason TEXT [--state local.json] [--apply]\nImports/corrections require authoritative item-level month-end records. Defaults to review-only; use --apply after reviewing the computed results.');
        return;
    }
    if (options.correctionFile && (options.importFile || options.accept)) throw new Error('--correct cannot be combined with --import or --accept.');
    const store = await createKpiStore({ filePath: options.filePath });
    try {
        const prior = await store.read(), now = new Date(), meta = { actor: options.actor, reason: options.reason, now };
        let next = prior;
        if (options.importFile) next = importControl(next, JSON.parse(fs.readFileSync(options.importFile, 'utf8')), meta);
        if (options.accept) next = acceptPeriod(next, options.accept, meta);
        if (options.correctionFile) next = correctPeriod(next, JSON.parse(fs.readFileSync(options.correctionFile, 'utf8')), meta);
        const affected = options.accept || JSON.parse(fs.readFileSync(options.importFile || options.correctionFile, 'utf8')).month;
        console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'review only', store: store.kind, period: buildView(next, now).periods.find(p => p.month === affected), changes: next.audit.slice(prior.audit.length) }, null, 2));
        if (options.apply) { await store.save(next, prior.revision); console.log('Saved; prior accepted versions retained.'); }
        else console.log('No KPI store changes made.');
    } finally { await store.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, parseArgs };
