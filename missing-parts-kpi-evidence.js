const config = require('./snap-orders-report.config');
const lower = v => String(v || '').trim().toLowerCase();
const day = value => {
  const key = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && !Number.isNaN(Date.parse(key)) && new Date(`${key}T12:00:00Z`).toISOString().slice(0, 10) === key ? key : '';
};
const centralDay = value => {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: config.TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
function valueText(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (v.label) return v.label.text || '';
  if (Array.isArray(v.chosenValues)) return v.chosenValues.map(x => x.name || '').join(', ');
  return String(v.date ?? v.value ?? v.text ?? '');
}
function category(groupId, type) {
  const types = new Set(String(type || '').split(',').map(lower));
  if (groupId === config.SNAP_GROUP_ID && types.has('snap')) return 'factory';
  if (groupId !== config.FIELD_SERVICE_GROUP_ID) return 'outside';
  if (types.has('missing parts') && types.has('warranty')) return 'mixed';
  if (types.has('missing parts')) return 'field';
  if (types.has('warranty')) return 'warranty';
  return 'otherField';
}
function mapRaw(raw) {
  const values = Object.fromEntries(raw.column_values.map(c => [c.id, c]));
  const get = id => {
    let parsed; try { parsed = JSON.parse(values[id]?.value || 'null'); } catch {}
    return valueText(parsed) || values[id]?.text || '';
  };
  return { id: String(raw.id), name: raw.name, state: raw.state, groupId: raw.group?.id || '', groupName: raw.group?.title || '',
    type: get(config.COL_IDS.ORDER_TYPE), status: get(config.COL_IDS.CURRENT_STATUS), orderDate: day(get(config.COL_IDS.ORDER_DATE)),
    createdAt: raw.created_at, createdDate: centralDay(raw.created_at), shippedDate: day(get(config.COL_IDS.DATE_SHIPPED)),
    customer: get(config.COL_IDS.CUSTOMER), part: get(config.COL_IDS.PART_NUMBER), qty: Number(get(config.COL_IDS.QUANTITY)) || 0,
    url: `https://${config.MONDAY_SLUG}.monday.com/boards/${config.BOARD_ID}/pulses/${raw.id}` };
}
function indexEvents(logs, columns=[]) {
  const map = new Map(), seen = new Set(), singleActions = new Set();
  const singleByField = new Map();
  const events = [];
  for (const log of logs) {
    if (seen.has(String(log.id))) continue;
    seen.add(String(log.id));
    let data; try { data = JSON.parse(log.data); } catch { continue; }
    const at = new Date(Math.round(Number(log.created_at) / 10000));
    if (!Number.isFinite(at.getTime())) continue;
    const metadata=columns.find(c=>c.id===data.column_id);
    let settings;try{settings=JSON.parse(metadata?.settings_str||'{}');}catch{settings={};}
    let normalizedValue=valueText(data.value), valueKnown=Object.hasOwn(data,'value')&&(data.value==null||!!normalizedValue);
    if(!normalizedValue&&data.value?.index!=null&&settings.labels?.[data.value.index]!=null){normalizedValue=settings.labels[data.value.index];valueKnown=true;}
    if(!normalizedValue&&Array.isArray(data.value?.ids)&&Array.isArray(settings.labels)){
      const ids=[...new Set([...data.value.ids,...(data.value.added_id!=null?[data.value.added_id]:[])])];
      const labels=ids.map(id=>settings.labels.find(x=>String(x.id)===String(id))?.name);
      if(labels.every(x=>x!=null)){normalizedValue=labels.join(', ');valueKnown=true;}
    }
    events.push({ ...log, data, at: at.toISOString(), normalizedValue, valueKnown });
    if (log.event === 'update_column_value') {
      singleActions.add(`${data.action_record_uuid}:${data.column_id}:${data.pulse_id}`);
      const key=`${data.column_id}:${data.pulse_id}`;
      if(!singleByField.has(key))singleByField.set(key,[]);
      singleByField.get(key).push(events.at(-1));
    }
  }
  for (const event of events) {
    const d = event.data;
    for (const id of [...new Set([d.pulse_id, d.pulse?.id, ...(d.pulse_ids || [])].filter(Boolean).map(String))]) {
      // Bulk markers carry no values; matched per-line changes supply the evidence.
      if (event.event === 'batch_change_pulses_column_value') {
        if (d.action_record_uuid && singleActions.has(`${d.action_record_uuid}:${d.column_id}:${id}`)) continue;
        // Worker bulk updates often have null UUIDs on their per-line evidence.
        // Match only batch-flagged changes on the same item/column, within 60s,
        // and with the same resulting date/status-index/dropdown IDs.
        const signature=v=>{
          if(v?.label?.index!=null||v?.index!=null)return `status:${v.label?.index??v.index}`;
          if(v?.date!=null)return `date:${v.date}`;
          if(Array.isArray(v?.chosenValues))return `types:${v.chosenValues.map(x=>x.id).sort().join(',')}`;
          if(Array.isArray(v?.ids))return `types:${[...new Set([...v.ids,...(v.added_id!=null?[v.added_id]:[])])].sort().join(',')}`;
          return '';
        };
        const wanted=signature(d.value);
        if(wanted&&(singleByField.get(`${d.column_id}:${id}`)||[]).some(e=>
          e.data.is_batch_action&&!e.data.action_record_uuid&&Math.abs(Date.parse(e.at)-Date.parse(event.at))<=60000&&signature(e.data.value)===wanted))continue;
      }
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(event);
    }
  }
  for (const entries of map.values()) entries.sort((a,b) => b.at.localeCompare(a.at) || String(b.id).localeCompare(String(a.id)));
  return map;
}
function rewind(item, entries, cutoff) {
  const state = { ...item, uncertain: [], evidence: [] };
  const fields = { [config.COL_IDS.ORDER_TYPE]: 'type', [config.COL_IDS.CURRENT_STATUS]: 'status', [config.COL_IDS.ORDER_DATE]: 'orderDate' };
  if (new Date(item.createdAt) >= new Date(cutoff)) return {...state, state: 'notCreated'};
  for (const e of entries || []) {
    if (e.at < cutoff) continue;
    const d = e.data, field = fields[d.column_id];
    if (e.event === 'update_column_value' && field) {
      if (!Object.hasOwn(d, 'previous_value')) state.uncertain.push(`${field}: missing prior value`);
      else {
        state[field] = field === 'orderDate' ? day(valueText(d.previous_value)) : valueText(d.previous_value);
        state.uncertain=state.uncertain.filter(reason=>!reason.startsWith(`${field}:`));
        state.evidence.push(String(e.id));
      }
    } else if (e.event === 'batch_change_pulses_column_value' && field) {
      state.uncertain.push(`${field}: unmatched bulk change`);
    } else if (e.event === 'move_pulse_from_group') {
      if (!d.source_group?.id && !d.group_id) state.uncertain.push('group: missing source');
      else {state.groupId = d.source_group?.id || d.group_id; state.groupName = d.source_group?.title || ''; state.evidence.push(String(e.id));}
    } else if (e.event === 'archive_pulse' || e.event === 'delete_pulse' || e.event === 'delete_group_pulse'
      || e.event === 'batch_delete_pulses') { state.state = 'active'; state.evidence.push(String(e.id)); }
    else if (e.event === 'restore_pulse') {
      // Restoration payloads do not identify archived vs deleted prior state.
      state.uncertain.push('state: restoration prior state unavailable');
    }
  }
  // A retained value immediately before cutoff establishes the boundary state
  // when a later bulk event has no prior value. Do not leap across an undecodable
  // earlier bulk edit, and preserve the contributing activity ID.
  for(const field of ['status','type','orderDate']){
    if(!state.uncertain.some(reason=>reason.startsWith(`${field}:`)))continue;
    const prior=(entries||[]).find(e=>e.at<cutoff&&fields[e.data.column_id]===field&&['update_column_value','batch_change_pulses_column_value'].includes(e.event));
    if(prior?.valueKnown){state[field]=field==='orderDate'?day(prior.normalizedValue):prior.normalizedValue;state.evidence.push(String(prior.id));state.uncertain=state.uncertain.filter(reason=>!reason.startsWith(`${field}:`));}
  }
  state.uncertain = [...new Set(state.uncertain)];
  return state;
}
module.exports = { category, day, centralDay, valueText, mapRaw, indexEvents, rewind };
