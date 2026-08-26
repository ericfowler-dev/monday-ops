const test = require('node:test');
const assert = require('node:assert/strict');
const { renderBottleneck } = require('./generate-dynamic-owner-preview');

function row(overrides) {
    return {
        status: 'Pick/Materials (Darien)',
        currentCount: 12,
        waiting: 8,
        waitingPct: 67,
        medianSinceActivityHours: 54,
        medianLowerBound: false,
        oldestAgeDays: 21,
        supplierWaiting: false,
        ...overrides
    };
}

test('bottleneck section is a compact two-column visual with inline metrics', () => {
    const overviewUrl = 'https://psiengines-company.monday.com/boards/18414349860/views/259431125';
    const html = renderBottleneck({
        snap: { statusBottlenecks: [row({})] },
        fieldService: {
            statusBottlenecks: [row({
                status: 'Ordered from Supplier',
                currentCount: 5,
                waiting: 0,
                waitingPct: null,
                medianSinceActivityHours: null,
                oldestAgeDays: 14,
                supplierWaiting: true
            })]
        }
    }, overviewUrl);

    assert.match(html, /class="bottleneck-card" width="50%"/);
    assert.match(html, /8 waiting of 12 · 67%/);
    assert.match(html, /Oldest order 21d/);
    assert.match(html, /5 current · unowned stage/);
    assert.match(html, /Open live Monday overview/);
    assert.match(html, new RegExp(`href="${overviewUrl}"`, 'g'));
    assert.match(html, /font-size:15px;font-weight:800;line-height:20px/);
    assert.match(html, /font-size:14px;font-weight:800;line-height:19px;color:#991b1b/);
    assert.match(html, /border-left:5px solid #2563eb/);
    assert.match(html, /height="15" bgcolor="#dc2626"/);
    assert.doesNotMatch(html, />Waiting %</);
    assert.doesNotMatch(html, />Median since activity</);
    assert.doesNotMatch(html, />Supplier</);
});
