// Maintenance utility: drop weekly-snapshot keys that were not written on the
// scheduled weekday. Needed after 8/12–8/18, when the Render cron ran nightly
// and stored a "week" every day — each snapshot covers a trailing 7-day window,
// so the daily keys overlap and inflate the Weekly actioned trend totals.
//
// Dry run (default):  node prune-dynamic-history.js
// Apply:              node prune-dynamic-history.js --apply
//
// Uses REDIS_URL when set (external connection string when run from a laptop,
// internal when run inside Render); otherwise the local history file.

require('dotenv').config();

const config = require('./weekly-movement-report.config');
const { createHistoryStore } = require('./dynamic-owner-history-store');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekdayOf(dateKey) {
    const match = String(dateKey).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    // Date keys are already Central-time calendar dates; read the weekday at
    // midday UTC so no timezone conversion can shift the day.
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], 12));
    return date.getUTCDay();
}

(async () => {
    const apply = process.argv.includes('--apply');
    let store;
    try {
        store = await createHistoryStore();
        const history = await store.readHistory();
        const weeks = history.weeks || {};
        const keys = Object.keys(weeks).sort();
        if (!keys.length) {
            console.log(`No snapshots stored (${store.kind}). Nothing to do.`);
            return;
        }

        console.log(`Store: ${store.kind} · ${keys.length} snapshot key(s)\n`);
        const keep = [];
        const remove = [];
        for (const key of keys) {
            const day = weekdayOf(key);
            const label = day === null ? '??' : WEEKDAYS[day];
            const isScheduled = day === config.SCHEDULE_WEEKDAY;
            (isScheduled ? keep : remove).push(key);
            console.log(`  ${key}  ${label.padEnd(4)} ${isScheduled ? 'KEEP' : 'remove'}`);
        }

        console.log(`\nKeep: ${keep.join(', ') || 'none'}`);
        console.log(`Remove: ${remove.join(', ') || 'none'}`);

        if (!remove.length) {
            console.log('\nAlready clean — one snapshot per scheduled weekday.');
            return;
        }
        if (!keep.length) {
            console.log('\nRefusing to run: every stored key is off-schedule, so pruning would erase all history.');
            console.log('Pick the keys to keep by hand if that is really intended.');
            process.exitCode = 1;
            return;
        }
        if (!apply) {
            console.log('\nDry run — nothing written. Re-run with --apply to make these changes.');
            return;
        }

        for (const key of remove) delete history.weeks[key];
        await store.writeHistory(history);
        console.log(`\nApplied. ${Object.keys(history.weeks).length} snapshot(s) retained: ${Object.keys(history.weeks).sort().join(', ')}`);
    } catch (error) {
        console.error(`Prune failed: ${error.message}`);
        process.exitCode = 1;
    } finally {
        if (store) await store.close().catch(() => {});
    }
})();
