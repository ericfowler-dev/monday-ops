const fs = require('node:fs');
const path = require('node:path');
const { mapRaw } = require('./missing-parts-kpi-evidence');
const { capture, buildView } = require('./missing-parts-kpi-core');
const { renderExtract, summaryCsv, detailCsv, graphAttachments } = require('./missing-parts-kpi-render');
function prepareKpi(state, { rawItems, logs, columns = [], now, unavailableIds = [], activityFrom }) {
    const candidate = capture(state, { items: rawItems.map(mapRaw), logs, columns, now, unavailableIds, activityFrom });
    const view = buildView(candidate, now, Math.min(12, Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric' }).format(now)))) ;
    return { candidate, view, attachments: graphAttachments(candidate, view) };
}
function writeKpiExtract(prepared, directory) {
    fs.mkdirSync(directory, { recursive: true });
    const files = {
        'missing-parts-kpi-extract.html': renderExtract(prepared.candidate, prepared.view),
        'missing-parts-kpi-summary.csv': summaryCsv(prepared.view),
        'missing-parts-kpi-lines.csv': detailCsv(prepared.candidate, prepared.view),
        'missing-parts-kpi-periods.json': JSON.stringify(prepared.view, null, 2)
    };
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content, 'utf8');
    return path.join(directory, 'missing-parts-kpi-extract.html');
}
module.exports = { prepareKpi, writeKpiExtract };
