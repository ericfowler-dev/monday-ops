const { REPORT_METRICS: METRICS } = require('./missing-parts-kpi-core');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const statusLabel = p => ({ accepted: 'Accepted', corrected: `Corrected v${p.revision}`, pending: 'Pending acceptance', unavailable: 'Unavailable', mtd: 'MTD', reconstructed:'Historical estimate · review required' }[p.status]);
function renderKpiTable(view, { email = false } = {}) {
    const periods = view.periods;
    const style = 'padding:9px 6px;border-bottom:1px solid #dce3ed;font-family:Arial,sans-serif;font-size:11px;';
    const heading = `<div style="font-family:Arial,sans-serif;font-size:17px;font-weight:700">${escapeHtml(view.title)}</div>
      <div style="font-family:Arial,sans-serif;font-size:11px;line-height:17px;color:#526078;margin:5px 0 12px">Calendar months · Central time · new issues include shipped lines · backorders use month-end status · Warranty excluded</div>`;
    const table = `<table class="missing-parts-kpi-table" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed">
      <thead><tr><th width="27%" align="left" style="${style}background:#eef3f7">Measure · # lines</th>${periods.map(p => `<th align="right" style="${style}background:#eef3f7">${escapeHtml(p.month.slice(5))}/${escapeHtml(p.month.slice(2, 4))}${p.status === 'mtd' ? '<br>MTD' : ''}</th>`).join('')}</tr></thead>
      <tbody>${METRICS.map(([id, label]) => `<tr><th align="left" style="${style}">${escapeHtml(label)}</th>${periods.map(p => `<td align="right" style="${style}font-variant-numeric:tabular-nums">${p.totals?.[id] != null ? `${p.totals[id]}${['mtd', 'pending','reconstructed'].includes(p.status) ? '*' : ''}` : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    const pending = periods.filter(p => p.totals && !['accepted', 'corrected'].includes(p.status));
    const notes = `<div style="font-family:Arial,sans-serif;font-size:11px;line-height:17px;color:#526078;margin-top:10px">— = unavailable, not zero. * = provisional or pending acceptance; accepted periods are frozen. Backorders are not summed across months.
      ${view.historicalReview ? `<br>Historical estimates use retained source records and activity; they are not accepted actuals. Intake may omit deleted/unavailable lines and uses current classification/cancellation. Month-end backlog uses cutoff status.${periods.some(p=>p.totals?.combinedBackorders===null)?` Backlog lacks sufficient evidence for ${periods.filter(p=>p.totals?.combinedBackorders===null).map(p=>escapeHtml(p.month)).join(', ')}.`:''}${view.omittedUnavailableMonths?.length?` Earlier unsupported months (${view.omittedUnavailableMonths.map(escapeHtml).join(', ')}) are omitted.`:''}` : ''}
      ${pending.length ? `<br>${pending.map(p => `${escapeHtml(p.month)}: ${statusLabel(p)}, ${p.exceptionCount} exception(s)${p.completeness.newIssues ? '' : '; incomplete issue-history coverage'}.`).join(' ')}` : ''}</div>`;
    return email ? `<tr><td style="padding:22px 28px;border-top:4px solid #0f766e">${heading}${table}${notes}</td></tr>` : `${heading}<div style="overflow-x:auto">${table}</div>${notes}`;
}
function csvCell(value) {
    const text = String(value ?? '');
    return `"${/^[\s]*[=+@-]/.test(text) ? "'" : ''}${text.replaceAll('"', '""')}"`;
}
function toCsv(rows) { return '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
function summaryCsv(view) {
    return toCsv([['Period', ...METRICS.map(([, label]) => label), 'Status', 'Cutoff UTC', 'Exceptions', 'Issue history complete', 'Backlog complete', 'Source', 'Snapshot ID', 'Revision'],
        ...view.periods.map(p => [p.month, ...METRICS.map(([id]) => p.totals?.[id] ?? 'Unavailable'), statusLabel(p), p.cutoff || '', p.exceptionCount,
            p.completeness?.newIssues ?? false, p.completeness?.backorders ?? false, p.source?.reference || p.source?.title || '', p.snapshotId || '', p.revision || ''])]);
}
function detailRows(state, view) {
    return view.periods.flatMap(p => p.totals ? METRICS.flatMap(([metric, label]) => p.contributions[metric].map(key => {
        const r = state.records[key];
        return { period: p.month, metric, label, periodStatus: statusLabel(p), cutoff: metric.endsWith('New') ? p.intakeCutoff || p.cutoff : p.cutoff,
            snapshotId: p.snapshotId, ...r, recordKey: key };
    })) : []);
}
function detailCsv(state, view) {
    return toCsv([['Period', 'Measure', 'Item ID', 'Order name', 'Category', 'Order Date', 'Status at cutoff', 'Item state at cutoff', 'Part', 'Customer', 'Cutoff UTC', 'Period status', 'Source IDs', 'Snapshot ID', 'Record key', 'Monday URL'],
        ...detailRows(state, view).map(r => [r.period, r.label, r.id, r.name, r.category, r.orderDate, r.status, r.state, r.part, r.customer, r.cutoff,
            r.periodStatus, r.sourceIds.join(';'), r.snapshotId, r.recordKey, r.url])]);
}
function renderExtract(state, view) {
    const detail = detailRows(state, view);
    const payload = JSON.stringify({ metrics: METRICS, periods: view.periods.map(p => ({month:p.month,status:p.status})), rows: detail }).replaceAll('<', '\\u003c');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Missing Parts monthly KPI extract</title>
    <style>body{font:14px Arial,sans-serif;color:#172033;background:#eef2f7;margin:0}main{max-width:1150px;margin:auto;padding:28px 20px}.panel{padding:22px;background:white;border:1px solid #dce3ed;border-radius:8px;margin:18px 0}h1{font-size:26px}p{line-height:1.6;color:#526078}select,input{font:inherit;padding:8px;border:1px solid #aabccc;border-radius:4px;margin:8px 10px 8px 0}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #dce3ed;text-align:left;font-size:12px}a{color:#006b99}.detail-scroll{overflow:auto;max-height:620px}.detail{min-width:850px}#search{width:280px;max-width:100%}.missing-parts-kpi-table{min-width:850px}.badge{color:#735113;background:#fff0cb;padding:7px 10px;display:inline-block;border-radius:4px;font-size:12px}@media(max-width:600px){main{padding:15px}.panel{padding:14px}}@media print{body{background:white}select,input{display:none}.detail-scroll{max-height:none}}</style></head>
    <body><main><span class="badge">Monthly KPI · ${view.historicalReview ? 'Historical estimates shown for review' : 'Accepted periods frozen'}</span><h1>Missing Parts monthly KPI extract</h1><p>Saved source: ${escapeHtml(view.lastCapturedAt || 'not initialized')} UTC. This extract and the separate KPI email use the same calculation and source records.</p>
    <div class="panel">${renderKpiTable(view)}<p><a href="missing-parts-kpi-summary.csv" download>Download monthly KPI CSV</a> · <a href="missing-parts-kpi-lines.csv" download>Download supporting lines CSV</a></p></div>
    <div class="panel"><h2>Supporting source lines</h2><label>Period <select id="period">${view.periods.filter(p=>p.totals).map(p=>`<option value="${p.month}">${p.month}</option>`).join('')}</select></label><label>Measure <select id="metric">${METRICS.map(([id,label])=>`<option value="${id}">${escapeHtml(label)}</option>`).join('')}</select></label><input id="search" type="search" placeholder="Search item, name, part or customer" aria-label="Search source lines"><p id="count"></p><div class="detail-scroll"><table class="detail"><thead><tr><th>Item / Order</th><th>Part</th><th>Customer</th><th>Order Date</th><th>Status at cutoff</th><th>Source IDs</th></tr></thead><tbody id="lines"></tbody></table></div></div>
    <div class="panel"><h2>Period integrity</h2><p>New issues count distinct line IDs by Order Date even after shipping. Warranty and mixed Warranty/Missing Parts are separate exclusions. Missing dates remain exceptions. Accepted periods use the saved cutoff classification and status; later edits, cancellation or deletion cannot silently rewrite them.</p><p>Available historical reconstructions are shown as estimates for review. Unsupported periods remain unavailable; estimates cannot be accepted without authoritative controls. Explicit corrections preserve all prior accepted versions, reviewer, reason and source hash.</p></div>
    </main><script>const D=${payload};const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const q=id=>document.getElementById(id);function show(){const rows=D.rows.filter(r=>r.period===q('period').value&&r.metric===q('metric').value&&[r.id,r.name,r.part,r.customer].join(' ').toLowerCase().includes(q('search').value.toLowerCase()));q('count').textContent=rows.length+' contributing line(s)';q('lines').innerHTML=rows.map(r=>'<tr><td><a target="_blank" rel="noreferrer" href="'+esc(r.url)+'">'+esc(r.id)+'</a><br>'+esc(r.name)+'</td><td>'+esc(r.part)+'</td><td>'+esc(r.customer)+'</td><td>'+esc(r.orderDate||'Missing')+'</td><td>'+esc(r.status)+'</td><td>'+r.sourceIds.length+' evidence ID(s)</td></tr>').join('')||'<tr><td colspan="6">No contributing lines for this selection.</td></tr>';}q('period').value=D.periods.filter(p=>p.status!=='unavailable').at(-1)?.month||'';for(const id of ['period','metric','search'])q(id).addEventListener('input',show);show();</script></body></html>`;
}
function graphAttachments(state, view) {
    return [['missing-parts-kpi-summary.csv', summaryCsv(view)], ['missing-parts-kpi-lines.csv', detailCsv(state, view)]].map(([name, content]) => ({
        '@odata.type': '#microsoft.graph.fileAttachment', name, contentType: 'text/csv', contentBytes: Buffer.from(content, 'utf8').toString('base64')
    }));
}
module.exports = { renderKpiTable, renderExtract, summaryCsv, detailCsv, detailRows, graphAttachments, escapeHtml };
