function normalizeStatus(value) {
    return String(value || '').trim().toLowerCase();
}

function statusIsOneOf(value, statuses) {
    const normalizedValue = normalizeStatus(value);
    return statuses.some(status => normalizeStatus(status) === normalizedValue);
}

function excludeItemsByCurrentStatus(items, excludedStatuses) {
    return items.filter(item => !statusIsOneOf(item.currentStatus, excludedStatuses));
}

function sanitizeSnapshot(snapshot, excludedStatuses) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;

    const byCurrentStatus = snapshot.byCurrentStatus;
    if (!byCurrentStatus || typeof byCurrentStatus !== 'object') return snapshot;

    let excludedCount = 0;
    for (const [status, count] of Object.entries(byCurrentStatus)) {
        if (!statusIsOneOf(status, excludedStatuses)) continue;
        if (Number.isFinite(count)) excludedCount += count;
        delete byCurrentStatus[status];
    }

    if (Number.isFinite(snapshot.total) && excludedCount) {
        snapshot.total = Math.max(0, snapshot.total - excludedCount);
    }
    return snapshot;
}

function sanitizeHistory(history, excludedStatuses) {
    for (const stored of Object.values(history || {})) {
        if (!stored || typeof stored !== 'object') continue;

        // Early report history stored a single snapshot directly on each date.
        sanitizeSnapshot(stored, excludedStatuses);

        // Current history stores an independent snapshot for each population.
        for (const snapshot of Object.values(stored)) {
            sanitizeSnapshot(snapshot, excludedStatuses);
        }
    }
    return history;
}

module.exports = {
    excludeItemsByCurrentStatus,
    sanitizeHistory,
    sanitizeSnapshot,
    statusIsOneOf
};
