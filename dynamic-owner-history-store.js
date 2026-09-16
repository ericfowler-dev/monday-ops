// Weekly snapshot persistence for the dynamic owner activity report.
// Redis-first with a JSON-file fallback (mirrors the legacy movement report's
// store, but under distinct keys so the two histories never collide).
// The fallback file is ephemeral on Render — Redis is the durable path there.

const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');

const HISTORY_FILE = path.join(__dirname, 'history-dynamic-owner.json');
const REDIS_HISTORY_KEY = process.env.DYNAMIC_REDIS_HISTORY_KEY || 'dynamic:history';
const REDIS_LAST_RUN_KEY = process.env.DYNAMIC_REDIS_LAST_RUN_KEY || 'dynamic:last-run';

async function createHistoryStore() {
    if (!process.env.REDIS_URL) {
        return createFileHistoryStore();
    }
    const client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 10000, reconnectStrategy: false } });
    client.on('error', error => console.error(`Redis error: ${error.message}`));
    await client.connect();
    return {
        kind: 'redis',
        async readHistory() {
            const raw = await client.get(REDIS_HISTORY_KEY);
            return raw ? JSON.parse(raw) : { version: 1, weeks: {} };
        },
        async writeHistory(history) { await client.set(REDIS_HISTORY_KEY, JSON.stringify(history)); },
        async writeLastRun(dateKey) { await client.set(REDIS_LAST_RUN_KEY, dateKey); },
        async claimDelivery(dateKey) {
            if (await client.exists(`dynamic:sent:${dateKey}`)) return false;
            return Boolean(await client.set(`dynamic:sending:${dateKey}`, '1', { NX: true, EX: 900 }));
        },
        async markDelivered(dateKey) { await client.set(`dynamic:sent:${dateKey}`, '1', { EX: 86400 * 45 }); },
        async releaseDelivery(dateKey) { await client.del(`dynamic:sending:${dateKey}`); },
        async close() { if (client.isOpen) await client.quit(); }
    };
}

function createFileHistoryStore() {
    const sentFile = path.join(__dirname, 'exports', 'movement-deliveries.json');
    const readSent = () => fs.existsSync(sentFile) ? JSON.parse(fs.readFileSync(sentFile, 'utf8')) : {};
    return {
        kind: 'file',
        async readHistory() {
            if (!fs.existsSync(HISTORY_FILE)) return { version: 1, weeks: {} };
            try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
            catch { return { version: 1, weeks: {} }; }
        },
        async writeHistory(history) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); },
        async writeLastRun() {},
        async claimDelivery(dateKey) { return !readSent()[dateKey]; },
        async markDelivered(dateKey) {
            fs.mkdirSync(path.dirname(sentFile), { recursive: true });
            fs.writeFileSync(sentFile, JSON.stringify({ ...readSent(), [dateKey]: true }));
        },
        async releaseDelivery() {},
        async close() {}
    };
}

module.exports = { createHistoryStore, HISTORY_FILE, REDIS_HISTORY_KEY, REDIS_LAST_RUN_KEY };
