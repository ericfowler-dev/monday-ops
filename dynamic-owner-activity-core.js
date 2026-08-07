// Event-driven owner attribution for the dynamic open-order activity report.
// Pure calculations only: callers provide current items, Monday activity logs,
// the reporting window, and the status-to-owner mapping.

const movementCore = require('./weekly-movement-core');

function parseActivityTimestamp(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp)) return null;
    const date = new Date(Math.round(timestamp / 10000));
    return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeBoardActivityLogs(logs, qualifyingColumns) {
    const columnMap = new Map(qualifyingColumns.map(column => [column.id, column]));
    const seen = new Set();
    const events = [];

    for (const log of logs || []) {
        const id = String(log.id || '');
        if (id && seen.has(id)) continue;
        let data;
        try { data = JSON.parse(log.data); } catch { continue; }
        const at = parseActivityTimestamp(log.created_at);
        if (!at) continue;

        if (log.event === 'move_pulse_from_group' && data.pulse_id) {
            if (data.is_undo_action) continue;
            if (id) seen.add(id);
            events.push({
                id: id || `${data.pulse_id}:${log.created_at}:move`,
                type: 'group_move',
                itemId: String(data.pulse_id),
                itemName: movementCore.normalizeText(data.pulse?.name),
                at,
                actorUserId: movementCore.normalizeText(log.user_id),
                sourceGroupId: movementCore.normalizeText(data.source_group?.id || data.group_id),
                sourceGroupName: movementCore.normalizeText(data.source_group?.title),
                destinationGroupId: movementCore.normalizeText(data.dest_group?.id),
                destinationGroupName: movementCore.normalizeText(data.dest_group?.title)
            });
            continue;
        }

        if (log.event !== 'update_column_value' || !data.pulse_id || !columnMap.has(data.column_id)) continue;
        if (data.is_undo_action) continue;
        const column = columnMap.get(data.column_id);
        const previousValue = comparableValue(data.previous_value);
        const nextValue = comparableValue(data.value);
        if (previousValue === nextValue) continue;
        if (id) seen.add(id);

        events.push({
            id: id || `${data.pulse_id}:${log.created_at}:${data.column_id}`,
            type: column.kind === 'status' ? 'status' : 'operational',
            category: column.category,
            columnId: data.column_id,
            columnTitle: column.title,
            itemId: String(data.pulse_id),
            itemName: movementCore.normalizeText(data.pulse_name),
            groupId: movementCore.normalizeText(data.group_id),
            at,
            actorUserId: movementCore.normalizeText(log.user_id),
            previousValue,
            nextValue,
            previousStatus: column.kind === 'status' ? previousValue || 'Unassigned' : '',
            nextStatus: column.kind === 'status' ? nextValue || 'Unassigned' : ''
        });
    }

    const priority = { status: 0, operational: 1, group_move: 2 };
    return events.sort((a, b) => a.at - b.at || priority[a.type] - priority[b.type] || a.id.localeCompare(b.id));
}

function comparableValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'object') return String(value).trim();
    if (value.label?.text !== undefined) return movementCore.normalizeText(value.label.text);
    if (value.value !== undefined) return movementCore.normalizeText(value.value);
    if (value.text !== undefined) return movementCore.normalizeText(value.text);
    if (value.date !== undefined) return movementCore.normalizeText(value.date);
    if (value.checked !== undefined) return String(Boolean(value.checked));
    if (Array.isArray(value.chosenValues)) {
        return value.chosenValues.map(entry => entry.name || entry.label || entry.id || JSON.stringify(entry)).sort().join(', ');
    }
    if (Array.isArray(value.personsAndTeams)) {
        return value.personsAndTeams.map(entry => `${entry.kind || ''}:${entry.id || ''}`).sort().join(',');
    }
    if (value.from !== undefined || value.to !== undefined) return `${value.from || ''} → ${value.to || ''}`;
    return stableJson(value);
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    const ignored = new Set(['changed_at', 'post_id', 'icon']);
    return `{${Object.keys(value).filter(key => !ignored.has(key)).sort()
        .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function computeDynamicOwnerActivity({
    items,
    events,
    fromDate,
    refDate,
    ownerMap,
    snapGroupId,
    fieldServiceGroupId,
    closedStatuses,
    waitingHours,
    pastDueDays
}) {
    const itemById = new Map(items.map(item => [String(item.id), item]));
    const windowEvents = events.filter(event => event.at >= fromDate && event.at <= refDate);
    const eventsByItem = new Map();
    for (const event of windowEvents) {
        if (!eventsByItem.has(event.itemId)) eventsByItem.set(event.itemId, []);
        eventsByItem.get(event.itemId).push(event);
    }

    const pairs = new Map();
    const actors = new Map();
    const handoffs = new Map();
    const activityBreakdown = new Map();
    const eventAttributions = [];
    const modelledItemIds = new Set();

    const isClosed = status => closedStatuses.some(value => value.toLowerCase() === movementCore.normalizeText(status).toLowerCase());
    const populationFor = (item, groupId) => {
        if (groupId === fieldServiceGroupId) return 'fieldService';
        if (groupId === snapGroupId && (item.isSnapOrder ?? item.population === 'snap')) return 'snap';
        return null;
    };
    const ownerFor = (status, population) => {
        if (!population || isClosed(status)) return null;
        const label = movementCore.bucketLabelFor(status || 'Unassigned', population, ownerMap);
        return label === movementCore.INFORMATIONAL_LABEL ? null : label;
    };
    const destinationLabelFor = (status, population) => {
        if (isClosed(status)) return `Closed — ${status}`;
        return movementCore.bucketLabelFor(status || 'Unassigned', population, ownerMap);
    };

    for (const item of items) {
        const itemEvents = eventsByItem.get(String(item.id)) || [];
        const createdAt = toDate(item.createdAt);
        const effectiveStart = createdAt && createdAt > fromDate ? createdAt : fromDate;
        let status = item.status || 'Unassigned';
        let groupId = item.groupId || '';

        for (const event of [...itemEvents].sort((a, b) => b.at - a.at)) {
            if (event.type === 'status') status = event.previousStatus;
            else if (event.type === 'group_move') groupId = event.sourceGroupId;
        }

        let population = populationFor(item, groupId);
        let owner = ownerFor(status, population);
        let currentEpisode = population && owner
            ? startEpisode(item, population, owner, effectiveStart, Boolean(createdAt && createdAt >= fromDate))
            : null;
        if (currentEpisode) mergePair(pairs, currentEpisode);

        for (const event of itemEvents) {
            countActor(actors, event);
            countBreakdown(activityBreakdown, event);
            const attribution = {
                eventId: event.id,
                itemId: event.itemId,
                type: event.type,
                creditOwner: null,
                creditPopulation: null,
                receivedOwner: null,
                reason: null
            };

            if (event.type === 'operational') {
                const eventPopulation = populationFor(item, event.groupId || groupId);
                if (eventPopulation && currentEpisode && currentEpisode.population === eventPopulation) {
                    attribution.creditOwner = currentEpisode.owner;
                    attribution.creditPopulation = currentEpisode.population;
                    actionEpisode(currentEpisode, event);
                    mergePair(pairs, currentEpisode);
                } else {
                    attribution.reason = 'outside-report-group';
                }
                eventAttributions.push(attribution);
                continue;
            }

            if (event.type === 'status') {
                if (currentEpisode && population) {
                    attribution.creditOwner = currentEpisode.owner;
                    attribution.creditPopulation = currentEpisode.population;
                    actionEpisode(currentEpisode, event);
                    const nextOwner = ownerFor(event.nextStatus, population);
                    if (nextOwner !== currentEpisode.owner) {
                        currentEpisode.handedOff = true;
                        currentEpisode.current = false;
                        mergePair(pairs, currentEpisode);
                        recordHandoff(handoffs, population, currentEpisode.owner,
                            nextOwner || destinationLabelFor(event.nextStatus, population), item.id);
                        currentEpisode = nextOwner ? startEpisode(item, population, nextOwner, event.at, true) : null;
                        attribution.receivedOwner = nextOwner;
                        if (currentEpisode) mergePair(pairs, currentEpisode);
                    }
                } else {
                    attribution.reason = 'outside-report-group';
                }
                status = event.nextStatus;
                owner = ownerFor(status, population);
                eventAttributions.push(attribution);
                continue;
            }

            if (event.type === 'group_move') {
                const sourcePopulation = populationFor(item, event.sourceGroupId || groupId);
                const destinationPopulation = populationFor(item, event.destinationGroupId);
                if (currentEpisode && sourcePopulation) {
                    attribution.creditOwner = currentEpisode.owner;
                    attribution.creditPopulation = currentEpisode.population;
                    actionEpisode(currentEpisode, event);
                    currentEpisode.handedOff = true;
                    currentEpisode.current = false;
                    mergePair(pairs, currentEpisode);
                    const destinationOwner = ownerFor(status, destinationPopulation);
                    recordHandoff(handoffs, sourcePopulation, currentEpisode.owner,
                        destinationOwner || event.destinationGroupName || 'Outside report', item.id);
                }
                groupId = event.destinationGroupId;
                population = destinationPopulation;
                owner = ownerFor(status, population);
                currentEpisode = population && owner ? startEpisode(item, population, owner, event.at, true) : null;
                attribution.receivedOwner = currentEpisode?.owner || null;
                if (!attribution.creditOwner) attribution.reason = 'entered-report-group';
                if (currentEpisode) mergePair(pairs, currentEpisode);
                eventAttributions.push(attribution);
            }
        }

        const finalPopulation = populationFor(item, item.groupId);
        const finalOwner = ownerFor(item.status, finalPopulation);
        if (item.isOpen && finalPopulation && finalOwner) {
            if (!currentEpisode || currentEpisode.population !== finalPopulation || currentEpisode.owner !== finalOwner) {
                const reconciliationAt = itemEvents.length ? itemEvents[itemEvents.length - 1].at : effectiveStart;
                currentEpisode = startEpisode(item, finalPopulation, finalOwner, reconciliationAt, true);
            }
            currentEpisode.current = true;
            currentEpisode.currentSince = currentEpisode.startedAt;
            currentEpisode.waitingSince = currentEpisode.lastActionAt || currentEpisode.startedAt;
            currentEpisode.waitingLowerBound = currentEpisode.startedAt.getTime() === fromDate.getTime()
                && (!createdAt || createdAt < fromDate);
            currentEpisode.waitingHours = Math.max(0, (refDate - currentEpisode.waitingSince) / 3600000);
            currentEpisode.waiting = currentEpisode.waitingHours >= waitingHours;
            currentEpisode.pastDue = Number.isFinite(item.ageDays) && item.ageDays > pastDueDays;
            mergePair(pairs, currentEpisode);
            modelledItemIds.add(String(item.id));
        }
    }

    const populations = {
        snap: aggregatePopulation('snap', pairs, items, modelledItemIds, handoffs, waitingHours),
        fieldService: aggregatePopulation('fieldService', pairs, items, modelledItemIds, handoffs, waitingHours)
    };
    const actorRows = [...actors.values()].map(actor => ({
        userId: actor.userId,
        events: actor.events,
        distinctItems: actor.itemIds.size,
        statusChanges: actor.statusChanges,
        operationalEdits: actor.operationalEdits,
        groupMoves: actor.groupMoves
    })).sort((a, b) => b.events - a.events || a.userId.localeCompare(b.userId));
    const breakdownRows = [...activityBreakdown.values()].sort((a, b) => b.events - a.events || a.label.localeCompare(b.label));

    return {
        populations,
        actorRows,
        breakdownRows,
        eventAttributions,
        qualifyingEvents: windowEvents.filter(event => itemById.has(event.itemId)).length,
        distinctItemsWithActivity: new Set(windowEvents.filter(event => itemById.has(event.itemId)).map(event => event.itemId)).size,
        unavailableEventItems: new Set(windowEvents.filter(event => !itemById.has(event.itemId)).map(event => event.itemId)).size
    };
}

function startEpisode(item, population, owner, startedAt, received) {
    return {
        key: `${population}\u0000${owner}\u0000${item.id}`,
        itemId: String(item.id),
        itemName: item.name,
        itemUrl: item.url || '',
        status: item.status,
        ageDays: item.ageDays,
        population,
        owner,
        startedAt,
        received,
        actioned: false,
        handedOff: false,
        actionEvents: 0,
        actionEventIds: new Set(),
        lastActionAt: null,
        current: false,
        waiting: false,
        waitingHours: 0,
        waitingLowerBound: false,
        pastDue: false
    };
}

function actionEpisode(episode, event) {
    episode.actioned = true;
    episode.actionEventIds.add(event.id);
    episode.actionEvents = episode.actionEventIds.size;
    if (!episode.lastActionAt || event.at > episode.lastActionAt) episode.lastActionAt = event.at;
}

function mergePair(pairs, episode) {
    const existing = pairs.get(episode.key);
    if (!existing) {
        pairs.set(episode.key, { ...episode });
        return;
    }
    existing.received ||= episode.received;
    existing.actioned ||= episode.actioned;
    existing.handedOff ||= episode.handedOff;
    for (const eventId of episode.actionEventIds) existing.actionEventIds.add(eventId);
    existing.actionEvents = existing.actionEventIds.size;
    if (episode.lastActionAt && (!existing.lastActionAt || episode.lastActionAt > existing.lastActionAt)) {
        existing.lastActionAt = episode.lastActionAt;
    }
    if (episode.current) {
        existing.current = true;
        existing.status = episode.status;
        existing.currentSince = episode.currentSince;
        existing.waitingSince = episode.waitingSince;
        existing.waiting = episode.waiting;
        existing.waitingHours = episode.waitingHours;
        existing.waitingLowerBound = episode.waitingLowerBound;
        existing.pastDue = episode.pastDue;
    }
}

function countActor(actors, event) {
    const userId = event.actorUserId || 'unknown';
    if (!actors.has(userId)) actors.set(userId, {
        userId,
        events: 0,
        itemIds: new Set(),
        statusChanges: 0,
        operationalEdits: 0,
        groupMoves: 0
    });
    const actor = actors.get(userId);
    actor.events += 1;
    actor.itemIds.add(event.itemId);
    if (event.type === 'status') actor.statusChanges += 1;
    else if (event.type === 'operational') actor.operationalEdits += 1;
    else if (event.type === 'group_move') actor.groupMoves += 1;
}

function countBreakdown(breakdown, event) {
    const label = event.type === 'group_move' ? 'Moved between groups' : event.columnTitle;
    if (!breakdown.has(label)) breakdown.set(label, { label, events: 0, itemIds: new Set() });
    const row = breakdown.get(label);
    row.events += 1;
    row.itemIds.add(event.itemId);
    row.distinctItems = row.itemIds.size;
}

function recordHandoff(handoffs, population, source, destination, itemId) {
    const key = `${population}\u0000${source}\u0000${destination}`;
    if (!handoffs.has(key)) handoffs.set(key, { population, source, destination, events: 0, itemIds: new Set() });
    const row = handoffs.get(key);
    row.events += 1;
    row.itemIds.add(String(itemId));
}

function aggregatePopulation(population, pairs, items, modelledItemIds, handoffs, waitingHours) {
    const populationPairs = [...pairs.values()].filter(pair => pair.population === population);
    const rows = {};
    const rowFor = owner => rows[owner] || (rows[owner] = {
        received: 0,
        actioned: 0,
        handedOff: 0,
        waiting: 0,
        current: 0,
        past6w: 0,
        eligible: 0,
        actionRate: null,
        activityEvents: 0,
        oldestWaitingHours: null,
        oldestWaitingName: '',
        oldestWaitingLowerBound: false
    });
    const attention = [];

    for (const pair of populationPairs) {
        const row = rowFor(pair.owner);
        if (pair.received) row.received += 1;
        if (pair.actioned) row.actioned += 1;
        if (pair.handedOff) row.handedOff += 1;
        if (pair.current) row.current += 1;
        if (pair.pastDue) row.past6w += 1;
        if (pair.actioned || pair.waiting) row.eligible += 1;
        row.activityEvents += pair.actionEvents;
        if (pair.waiting) {
            row.waiting += 1;
            if (row.oldestWaitingHours === null || pair.waitingHours > row.oldestWaitingHours) {
                row.oldestWaitingHours = pair.waitingHours;
                row.oldestWaitingName = pair.itemName;
                row.oldestWaitingLowerBound = pair.waitingLowerBound;
            }
            attention.push({
                itemId: pair.itemId,
                name: pair.itemName,
                url: pair.itemUrl,
                owner: pair.owner,
                status: pair.status,
                waitingHours: pair.waitingHours,
                waitingLowerBound: pair.waitingLowerBound,
                ageDays: pair.ageDays
            });
        }
    }
    for (const row of Object.values(rows)) {
        row.actionRate = row.eligible ? Math.round(row.actioned / row.eligible * 100) : null;
    }

    const totals = Object.values(rows).reduce((total, row) => {
        for (const key of ['received', 'actioned', 'handedOff', 'waiting', 'current', 'past6w', 'eligible', 'activityEvents']) {
            total[key] += row[key];
        }
        return total;
    }, { received: 0, actioned: 0, handedOff: 0, waiting: 0, current: 0, past6w: 0, eligible: 0, activityEvents: 0, actionRate: null });
    totals.actionRate = totals.eligible ? Math.round(totals.actioned / totals.eligible * 100) : null;

    const populationHandoffs = [...handoffs.values()].filter(row => row.population === population)
        .map(row => ({ source: row.source, destination: row.destination, events: row.events, distinctItems: row.itemIds.size }))
        .sort((a, b) => b.distinctItems - a.distinctItems || b.events - a.events);
    attention.sort((a, b) => b.waitingHours - a.waitingHours || a.name.localeCompare(b.name));
    const currentItems = items.filter(item => item.population === population && item.isOpen);
    const currentOpen = currentItems.length;
    const informationalOpen = currentItems.filter(item => movementCore.normalizeText(item.status).toLowerCase()
        === movementCore.INFORMATIONAL_LABEL.toLowerCase()).length;

    return { rows, totals, attention, handoffs: populationHandoffs, currentOpen, informationalOpen, waitingHours };
}

function toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = {
    parseActivityTimestamp,
    comparableValue,
    normalizeBoardActivityLogs,
    computeDynamicOwnerActivity
};
