const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('redis');
const { emptyState, validateState } = require('./missing-parts-kpi-core');
const DEFAULT_FILE = path.join(__dirname, 'history-missing-parts-kpi.json');
const REDIS_KEY = 'missing-parts-kpi:v1';
function decode(raw) { return raw ? validateState(JSON.parse(raw)) : emptyState(); }
function verifyWrite(prior, next, expectedRevision) {
    validateState(next);
    if (prior.revision !== expectedRevision || next.revision <= expectedRevision) throw new Error('KPI history changed concurrently; reload before saving.');
    for (const [month, period] of Object.entries(prior.periods)) {
        const versions = next.periods[month]?.versions;
        if (!versions || JSON.stringify(versions.slice(0, period.versions.length)) !== JSON.stringify(period.versions)) throw new Error(`Accepted KPI period ${month} is immutable; record a correction instead.`);
    }
    for(const [key,record] of Object.entries(prior.records)) if(JSON.stringify(next.records[key])!==JSON.stringify(record)) throw new Error(`KPI source version ${key} is immutable.`);
    if(JSON.stringify(next.audit.slice(0,prior.audit.length))!==JSON.stringify(prior.audit))throw new Error('KPI audit history is append-only.');
    for(const [date,snapshots] of Object.entries(prior.daily))if(JSON.stringify(next.daily[date]?.slice(0,snapshots.length))!==JSON.stringify(snapshots))throw new Error('Daily KPI snapshots are immutable.');
}
function createFileStore(filePath = DEFAULT_FILE) {
    const resolved = path.resolve(filePath);
    return {
        kind: 'file', location: resolved,
        async read() { return decode(fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : null); },
        async save(next, expectedRevision) {
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            const lockPath = `${resolved}.lock`, temporary = `${resolved}.${crypto.randomUUID()}.tmp`;
            let lock, output;
            try {
                lock = fs.openSync(lockPath, 'wx');
                const prior = decode(fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : null);
                verifyWrite(prior, next, expectedRevision);
                output = fs.openSync(temporary, 'wx');
                fs.writeFileSync(output, JSON.stringify(next));
                fs.fsyncSync(output); fs.closeSync(output); output = undefined;
                fs.renameSync(temporary, resolved);
            } finally {
                if (output !== undefined) fs.closeSync(output);
                if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
                if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockPath); }
            }
        },
        async close() {}
    };
}
const CAS_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local revision = 0
if raw then revision = cjson.decode(raw).revision end
if revision ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;
async function createKpiStore(options = {}) {
    const redisUrl = options.filePath ? null : (options.redisUrl ?? process.env.REDIS_URL);
    if (!redisUrl) {
        if (options.requireDurable ?? process.env.RENDER === 'true') throw new Error('REDIS_URL is required for durable KPI history in production.');
        return createFileStore(options.filePath || process.env.MISSING_PARTS_KPI_FILE || DEFAULT_FILE);
    }
    const client = createClient({ url: redisUrl, socket: { connectTimeout: 10000, reconnectStrategy: false } });
    client.on('error', () => {});
    await client.connect();
    return {
        kind: 'redis', location: REDIS_KEY,
        async read() { return decode(await client.get(REDIS_KEY)); },
        async save(next, expectedRevision) {
            const prior = decode(await client.get(REDIS_KEY));
            verifyWrite(prior, next, expectedRevision);
            const saved = await client.eval(CAS_SCRIPT, { keys: [REDIS_KEY], arguments: [String(expectedRevision), JSON.stringify(next)] });
            if (saved !== 1) throw new Error('KPI history changed concurrently; reload before saving.');
        },
        async close() { if (client.isOpen) await client.quit(); }
    };
}
module.exports = { createKpiStore, createFileStore, verifyWrite, CAS_SCRIPT, DEFAULT_FILE, REDIS_KEY };
