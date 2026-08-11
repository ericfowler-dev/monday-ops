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
    const closedItemsByPopulation = { snap: new Set(), fieldService: new Set() };

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
                if (population && isClosed(event.nextStatus)) closedItemsByPopulation[population].add(String(item.id));
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
        snap: aggregatePopulation('snap', pairs, items, modelledItemIds, handoffs, waitingHours, pastDueDays, closedItemsByPopulation.snap),
        fieldService: aggregatePopulation('fieldService', pairs, items, modelledItemIds, handoffs, waitingHours, pastDueDays, closedItemsByPopulation.fieldService)
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
    const unavailableEventItems = new Set(windowEvents.filter(event => !itemById.has(event.itemId)).map(event => event.itemId)).size;

    const currentAssignments = [...pairs.values()].filter(pair => pair.current).map(pair => ({
        itemId: pair.itemId,
        name: pair.itemName,
        url: pair.itemUrl,
        population: pair.population,
        owner: pair.owner,
        status: pair.status,
        ageDays: pair.ageDays,
        waitingHours: pair.waitingHours,
        waitingLowerBound: pair.waitingLowerBound,
        lastActionAt: pair.lastActionAt ? pair.lastActionAt.toISOString() : null,
        pastDue: pair.pastDue,
        unmapped: pair.owner === movementCore.UNMAPPED_LABEL
    }));

    return {
        populations,
        actorRows,
        breakdownRows,
        eventAttributions,
        currentAssignments,
        executive: buildExecutiveSummary(populations),
        dataQuality: {
            unmappedCurrentPairs: currentAssignments.filter(pair => pair.unmapped).length,
            unknownActorEvents: windowEvents.filter(event => !event.actorUserId || event.actorUserId === 'unknown').length,
            unavailableEventItems
        },
        qualifyingEvents: windowEvents.filter(event => itemById.has(event.itemId)).length,
        distinctItemsWithActivity: new Set(windowEvents.filter(event => itemById.has(event.itemId)).map(event => event.itemId)).size,
        unavailableEventItems
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

function aggregatePopulation(population, pairs, items, modelledItemIds, handoffs, waitingHours, pastDueDays, closedItems) {
    const populationPairs = [...pairs.values()].filter(pair => pair.population === population);
    const rows = {};
    const rowFor = owner => rows[owner] || (rows[owner] = {
        received: 0,
        actioned: 0,
        handedOff: 0,
        waiting: 0,
        current: 0,
        actionedCurrent: 0,
        past6w: 0,
        eligible: 0,
        actionRate: null,
        netFlow: 0,
        waitingPct: null,
        medianWaitHours: null,
        medianWaitLowerBound: false,
        activityEvents: 0,
        oldestWaitingHours: null,
        oldestWaitingName: '',
        oldestWaitingLowerBound: false
    });
    const attention = [];
    const currentWaitsByOwner = new Map();

    for (const pair of populationPairs) {
        const row = rowFor(pair.owner);
        if (pair.received) row.received += 1;
        if (pair.actioned) row.actioned += 1;
        if (pair.handedOff) row.handedOff += 1;
        if (pair.current) {
            row.current += 1;
            if (pair.actioned) row.actionedCurrent += 1;
            if (!currentWaitsByOwner.has(pair.owner)) currentWaitsByOwner.set(pair.owner, []);
            // A wait measured from an in-window action is exact; only pairs pinned
            // to the window edge with no recorded action are true lower bounds.
            currentWaitsByOwner.get(pair.owner).push({ hours: pair.waitingHours, lowerBound: pair.waitingLowerBound && !pair.lastActionAt });
        }
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
            const reasons = [`No qualifying activity for ${pair.waitingLowerBound ? 'at least ' : ''}${formatWholeHours(pair.waitingHours)}`];
            if (pair.pastDue) reasons.push(`Order age over ${pastDueDays} days`);
            if (pair.owner === movementCore.UNMAPPED_LABEL) reasons.push('Unmapped owner — check config');
            attention.push({
                itemId: pair.itemId,
                name: pair.itemName,
                url: pair.itemUrl,
                owner: pair.owner,
                status: pair.status,
                waitingHours: pair.waitingHours,
                waitingLowerBound: pair.waitingLowerBound,
                ageDays: pair.ageDays,
                reasons
            });
        }
    }
    for (const [owner, row] of Object.entries(rows)) {
        row.actionRate = row.eligible ? Math.round(row.actioned / row.eligible * 100) : null;
        row.netFlow = row.received - row.handedOff;
        row.waitingPct = row.current ? Math.round(row.waiting / row.current * 100) : null;
        const waits = currentWaitsByOwner.get(owner) || [];
        row.medianWaitHours = medianOf(waits.map(wait => wait.hours));
        row.medianWaitLowerBound = waits.some(wait => wait.lowerBound);
    }

    const totals = Object.values(rows).reduce((total, row) => {
        for (const key of ['received', 'actioned', 'handedOff', 'waiting', 'current', 'actionedCurrent', 'past6w', 'eligible', 'activityEvents']) {
            total[key] += row[key];
        }
        return total;
    }, { received: 0, actioned: 0, handedOff: 0, waiting: 0, current: 0, actionedCurrent: 0, past6w: 0, eligible: 0, activityEvents: 0, actionRate: null });
    totals.actionRate = totals.eligible ? Math.round(totals.actioned / totals.eligible * 100) : null;
    totals.netFlow = totals.received - totals.handedOff;
    totals.waitingPct = totals.current ? Math.round(totals.waiting / totals.current * 100) : null;
    totals.activityCoverage = totals.current ? Math.round(totals.actionedCurrent / totals.current * 100) : null;
    const allWaits = [...currentWaitsByOwner.values()].flat();
    totals.medianWaitHours = medianOf(allWaits.map(wait => wait.hours));
    totals.medianWaitLowerBound = allWaits.some(wait => wait.lowerBound);
    totals.unmappedCurrent = rows[movementCore.UNMAPPED_LABEL]?.current || 0;

    const populationHandoffs = [...handoffs.values()].filter(row => row.population === population)
        .map(row => ({ source: row.source, destination: row.destination, events: row.events, distinctItems: row.itemIds.size }))
        .sort((a, b) => b.distinctItems - a.distinctItems || b.events - a.events);
    attention.sort((a, b) => b.waitingHours - a.waitingHours || a.name.localeCompare(b.name));
    const currentItems = items.filter(item => item.population === population && item.isOpen);
    const currentOpen = currentItems.length;
    const informationalOpen = currentItems.filter(item => movementCore.normalizeText(item.status).toLowerCase()
        === movementCore.INFORMATIONAL_LABEL.toLowerCase()).length;
    const currentPairs = populationPairs.filter(pair => pair.current);

    return {
        rows,
        totals,
        attention,
        handoffs: populationHandoffs,
        currentOpen,
        informationalOpen,
        waitingHours,
        closedOrders: closedItems ? closedItems.size : 0,
        agingBuckets: buildAgingBuckets(currentPairs),
        statusBottlenecks: buildStatusBottlenecks(currentItems, currentPairs)
    };
}

const AGING_BUCKET_DEFS = [
    { label: 'Under 7 days', min: 0, max: 6 },
    { label: '7–13 days', min: 7, max: 13 },
    { label: '14–27 days', min: 14, max: 27 },
    { label: '28–41 days', min: 28, max: 41 },
    { label: '42 days or more', min: 42, max: Infinity }
];

// Buckets use order age (Order Date, falling back to created_at) because
// time-since-activity is truncated by the 7-day activity window.
function buildAgingBuckets(currentPairs) {
    const aged = currentPairs.filter(pair => Number.isFinite(pair.ageDays));
    const total = currentPairs.length;
    const buckets = AGING_BUCKET_DEFS.map(def => {
        const count = aged.filter(pair => pair.ageDays >= def.min && pair.ageDays <= def.max).length;
        return { label: def.label, count, pct: total ? Math.round(count / total * 100) : null };
    });
    return { buckets, unknownAge: total - aged.length, total };
}

function buildStatusBottlenecks(currentItems, currentPairs) {
    const byStatus = new Map();
    const rowFor = status => {
        const key = movementCore.normalizeText(status).toLowerCase();
        if (!byStatus.has(key)) byStatus.set(key, {
            status: movementCore.normalizeText(status) || 'Unassigned',
            currentCount: 0,
            waiting: 0,
            waitingPct: null,
            medianSinceActivityHours: null,
            medianLowerBound: false,
            oldestAgeDays: null,
            supplierWaiting: movementCore.normalizeText(status).toLowerCase() === movementCore.INFORMATIONAL_LABEL.toLowerCase(),
            waits: []
        });
        return byStatus.get(key);
    };

    for (const item of currentItems) {
        const row = rowFor(item.status);
        row.currentCount += 1;
        if (Number.isFinite(item.ageDays) && (row.oldestAgeDays === null || item.ageDays > row.oldestAgeDays)) {
            row.oldestAgeDays = item.ageDays;
        }
    }
    for (const pair of currentPairs) {
        const row = rowFor(pair.status);
        if (pair.waiting) row.waiting += 1;
        row.waits.push({ hours: pair.waitingHours, lowerBound: pair.waitingLowerBound && !pair.lastActionAt });
    }
    const rows = [...byStatus.values()].map(row => {
        const assigned = row.waits.length;
        row.waitingPct = assigned ? Math.round(row.waiting / assigned * 100) : null;
        row.medianSinceActivityHours = medianOf(row.waits.map(wait => wait.hours));
        row.medianLowerBound = row.waits.some(wait => wait.lowerBound);
        delete row.waits;
        return row;
    });
    return rows.sort((a, b) => b.waiting - a.waiting || b.currentCount - a.currentCount || a.status.localeCompare(b.status));
}

function buildExecutiveSummary(populations) {
    const pops = [populations.snap, populations.fieldService];
    const sum = key => pops.reduce((total, pop) => total + (pop.totals[key] || 0), 0);
    const received = sum('received');
    const movedOnward = sum('handedOff');
    const waiting = sum('waiting');
    const currentAssigned = sum('current');
    const actionedCurrent = sum('actionedCurrent');
    return {
        currentOpenOrders: pops.reduce((total, pop) => total + pop.currentOpen, 0),
        snapOpen: populations.snap.currentOpen,
        fieldOpen: populations.fieldService.currentOpen,
        supplierWaiting: pops.reduce((total, pop) => total + pop.informationalOpen, 0),
        closedOrders: pops.reduce((total, pop) => total + (pop.closedOrders || 0), 0),
        received,
        movedOnward,
        netFlow: received - movedOnward,
        waiting,
        currentAssigned,
        waitingPct: currentAssigned ? Math.round(waiting / currentAssigned * 100) : null,
        activityCoverage: currentAssigned ? Math.round(actionedCurrent / currentAssigned * 100) : null,
        basis: {
            currentOpenOrders: 'unique orders',
            snapOpen: 'unique orders',
            fieldOpen: 'unique orders',
            supplierWaiting: 'unique orders',
            closedOrders: 'unique orders',
            received: 'owner-item pairs',
            movedOnward: 'owner-item pairs',
            netFlow: 'owner-item pairs',
            waiting: 'owner-item pairs',
            currentAssigned: 'owner-item pairs',
            waitingPct: 'owner-item pairs',
            activityCoverage: 'owner-item pairs'
        }
    };
}

// Weekly snapshot record (spec §15): persisted so trend sections and true
// dwell/return-loop metrics can be added once history accrues.
function buildWeeklySnapshot({ result, items, refDate }) {
    const assignmentByItem = new Map(result.currentAssignments.map(pair => [pair.itemId, pair]));
    const liteRows = rows => Object.fromEntries(Object.entries(rows).map(([owner, row]) => [owner, {
        current: row.current,
        received: row.received,
        actioned: row.actioned,
        handedOff: row.handedOff,
        netFlow: row.netFlow,
        waiting: row.waiting,
        waitingPct: row.waitingPct,
        medianWaitHours: row.medianWaitHours,
        medianWaitLowerBound: row.medianWaitLowerBound,
        past6w: row.past6w
    }]));
    const litePopulation = pop => ({
        totals: pop.totals,
        currentOpen: pop.currentOpen,
        informationalOpen: pop.informationalOpen,
        closedOrders: pop.closedOrders,
        rows: liteRows(pop.rows)
    });
    return {
        version: 1,
        generatedAt: refDate.toISOString(),
        executive: result.executive,
        dataQuality: result.dataQuality,
        populations: {
            snap: litePopulation(result.populations.snap),
            fieldService: litePopulation(result.populations.fieldService)
        },
        items: items.filter(item => item.population && item.isOpen).map(item => {
            const pair = assignmentByItem.get(item.id) || null;
            return {
                id: item.id,
                name: item.name,
                population: item.population,
                owner: pair ? pair.owner : null,
                status: item.status,
                groupId: item.groupId,
                open: true,
                supplierWaiting: movementCore.normalizeText(item.status).toLowerCase()
                    === movementCore.INFORMATIONAL_LABEL.toLowerCase(),
                lastQualifyingActivityAt: pair ? pair.lastActionAt : null,
                waitingHours: pair ? Math.round(pair.waitingHours * 10) / 10 : null,
                waitingLowerBound: pair ? pair.waitingLowerBound : false,
                ageDays: Number.isFinite(item.ageDays) ? item.ageDays : null,
                unmapped: pair ? pair.unmapped : false
            };
        })
    };
}

function medianOf(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatWholeHours(hours) {
    return hours >= 48 ? `${Math.floor(hours / 24)} days` : `${Math.floor(hours)} hours`;
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
    computeDynamicOwnerActivity,
    buildExecutiveSummary,
    buildWeeklySnapshot,
    medianOf
};
