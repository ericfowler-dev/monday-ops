import { useCallback, useEffect, useRef, useState } from 'react';
import { CONFIG } from './config';
import { getBoardContext, isMockMode, listenToMonday, loadDashboard } from './mondayData';

export default function App() {
  const [boardId, setBoardId] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const refreshTimer = useRef(null);

  const refresh = useCallback(async (targetBoardId, initial = false) => {
    if (!targetBoardId) return;
    initial ? setLoading(true) : setRefreshing(true);
    setError('');
    try {
      setDashboard(await loadDashboard(targetBoardId));
    } catch (requestError) {
      setError(requestError.message || 'Unable to load the Order Tracker dashboard.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    getBoardContext().then(context => {
      if (!active) return;
      const nextBoardId = String(context.boardId || CONFIG.boardId);
      setBoardId(nextBoardId);
      document.documentElement.dataset.theme = context.theme || 'light';
      refresh(nextBoardId, true);
    }).catch(contextError => {
      if (!active) return;
      setError(contextError.message || 'Monday did not provide board context.');
      setLoading(false);
    });

    const stopContext = listenToMonday('context', response => {
      const context = response.data || {};
      if (context.theme) document.documentElement.dataset.theme = context.theme;
      if (context.boardId) setBoardId(String(context.boardId));
    });
    const stopEvents = listenToMonday('events', () => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        setBoardId(currentBoardId => {
          refresh(currentBoardId);
          return currentBoardId;
        });
      }, 1200);
    });

    return () => {
      active = false;
      clearTimeout(refreshTimer.current);
      stopContext?.();
      stopEvents?.();
    };
  }, [refresh]);

  if (loading) return <LoadingView />;
  if (error && !dashboard) return <ErrorView message={error} onRetry={() => refresh(boardId, true)} />;

  const activeTotal = dashboard.factory.total
    + dashboard.fieldMissingParts.total
    + dashboard.fieldWarranty.total
    + dashboard.other.total;
  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <span className="eyebrow">Order Tracker Operations</span>
          <h1>Open Parts Orders</h1>
          <p>Live operational view of Factory SNAPs, Field Missing Parts, and Field Warranty orders.</p>
        </div>
        <div className="hero-actions">
          <span className="live-pill"><span className="live-dot" />{isMockMode ? 'Mock preview' : 'Live from Monday'}</span>
          <button className="refresh-button" onClick={() => refresh(boardId)} disabled={refreshing}>
            <RefreshIcon spinning={refreshing} /> {refreshing ? 'Refreshing' : 'Refresh data'}
          </button>
          <span className="refresh-time">Updated {formatTime(dashboard.refreshedAt)}</span>
        </div>
      </header>

      {error && <div className="notice notice-error">Refresh failed: {error}</div>}
      {dashboard.warnings.map(warning => <div className="notice" key={warning}>{warning}</div>)}

      <section aria-labelledby="overview-title">
        <SectionHeading id="overview-title" title="At a glance" subtitle="Open workload classified by the Order Type column" />
        <div className="metric-grid">
          <Metric label="Active board lines" value={activeTotal} note={`${dashboard.other.total} service / draft / other`} tone="navy" />
          <Metric label="Factory SNAPs" value={dashboard.factory.total} note={`${dashboard.factory.newLast30Days} new in 30 days`} tone="blue" />
          <Metric label="Field missing parts" value={dashboard.fieldMissingParts.total} note={`${dashboard.fieldMissingParts.newLast30Days} new in 30 days`} tone="teal" />
          <Metric label="Field warranty" value={dashboard.fieldWarranty.total} note={`${dashboard.fieldWarranty.newLast30Days} new in 30 days`} tone="violet" />
        </div>
      </section>

      <section aria-labelledby="throughput-title">
        <SectionHeading id="throughput-title" title="Closed throughput" subtitle="Unique lines with a Shipped status, reported by Date Shipped" />
        <ClosedThroughput counts={dashboard.closedCounts} />
      </section>

      <PopulationPanel title="Factory SNAP orders" subtitle="SNAP order type in the Factory group" report={dashboard.factory} tone="blue" />
      <PopulationPanel title="Field missing-parts orders" subtitle="Missing Parts order type in the Field Service group" report={dashboard.fieldMissingParts} tone="teal" />
      <PopulationPanel title="Field warranty orders" subtitle="Warranty order type in the Field Service group" report={dashboard.fieldWarranty} tone="violet" />

      <section aria-labelledby="recent-title">
        <SectionHeading id="recent-title" title={`Shipped in the last ${CONFIG.recentShippedDays} days`} subtitle={`${dashboard.recentShipped.length} recently completed line${dashboard.recentShipped.length === 1 ? '' : 's'}`} />
        <RecentShipments items={dashboard.recentShipped} />
      </section>

      <footer>
        Data is read directly from Monday and recalculated whenever this view refreshes. Only “Shipped” is treated as complete.
      </footer>
    </main>
  );
}

function PopulationPanel({ title, subtitle, report, tone }) {
  return (
    <section className={`population population-${tone}`}>
      <SectionHeading title={title} subtitle={subtitle} />
      <div className="metric-grid population-metrics">
        <Metric label="Open orders" value={report.total} note="Current workload" tone={tone} />
        <Metric label="Average age" value={report.averageAge === null ? '—' : `${report.averageAge}d`} note={`${report.over30Days} over 30 days`} tone={tone} />
        <Metric label="New in 7 days" value={report.newLast7Days} note="By order date" tone="violet" />
        <Metric label="New in 30 days" value={report.newLast30Days} note="By order date" tone="teal" />
        <Metric label="High / critical" value={report.priorityAttention} note={`${report.dataGaps} data gaps`} tone="amber" />
      </div>
      <div className="analysis-grid">
        <ChartCard title="Current Dept / Status">
          <BarList values={report.byCurrentStatus} tone={tone} />
        </ChartCard>
        <ChartCard title="Aging profile">
          <BarList values={report.agingBuckets} tone={tone} />
        </ChartCard>
        <ChartCard title="Priority">
          <BarList values={report.byPriority} tone="amber" />
        </ChartCard>
      </div>
      <div className="table-card">
        <div className="card-header">
          <div><h3>Attention queue</h3><p>High priority first, then oldest orders</p></div>
          <span className="count-pill">Top {report.attentionItems.length}</span>
        </div>
        <AttentionTable items={report.attentionItems} />
      </div>
    </section>
  );
}

function ClosedThroughput({ counts }) {
  const periods = [
    { days: 7, tone: 'green' },
    { days: 14, tone: 'teal' },
    { days: 30, tone: 'blue' }
  ];
  const maximum = Math.max(1, ...periods.map(period => counts[period.days] || 0));
  return (
    <div className="throughput-card">
      <div className="throughput-plot">
        {periods.map(period => {
          const count = counts[period.days] || 0;
          return (
            <div className="throughput-row" key={period.days}>
              <span className="throughput-label">Last {period.days} days</span>
              <div className="bar-track" aria-label={`${count} closed in the last ${period.days} days`}>
                <span className={`bar-fill fill-${period.tone}`} style={{ width: `${count ? Math.max(3, count / maximum * 100) : 0}%` }} />
              </div>
              <strong className={`throughput-value text-${period.tone}`}>{count}</strong>
            </div>
          );
        })}
      </div>
      <p className="chart-note">Bars share the same scale. Totals use cumulative calendar-day windows.</p>
    </div>
  );
}

function BarList({ values, tone }) {
  const sorted = Object.entries(values).sort((a, b) => b[1] - a[1]);
  const maximum = Math.max(1, ...sorted.map(([, count]) => count));
  if (!sorted.length) return <EmptyState text="No data" />;
  return <div className="bar-list">{sorted.map(([label, count]) => (
    <div className="bar-list-row" key={label}>
      <span title={label}>{label}</span>
      <div className="mini-track"><i className={`mini-fill fill-${tone}`} style={{ width: `${count / maximum * 100}%` }} /></div>
      <strong>{count}</strong>
    </div>
  ))}</div>;
}

function RecentShipments({ items }) {
  if (!items.length) return <div className="table-card"><EmptyState text="No shipments recorded in this window." /></div>;
  return (
    <div className="table-card table-scroll">
      <table>
        <thead><tr><th>Order</th><th>Source</th><th>Customer</th><th>Tracking</th><th className="align-right">Date shipped</th></tr></thead>
        <tbody>{items.map(item => (
          <tr key={item.id}>
            <td><OrderLink item={item} /></td>
            <td>{sourceName(item)}</td>
            <td>{item.customer || '—'}</td>
            <td>{item.trackingNumber || item.supplierTracking || '—'}</td>
            <td className="align-right strong text-green">{formatDate(item.completedAt)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function AttentionTable({ items }) {
  if (!items.length) return <EmptyState text="No open orders in this group." />;
  return (
    <div className="table-scroll"><table>
      <thead><tr><th>Order</th><th>Current dept / status</th><th>Priority</th><th>Customer</th><th className="align-right">Age</th></tr></thead>
      <tbody>{items.map(item => (
        <tr key={item.id}>
          <td><OrderLink item={item} /></td>
          <td>{item.currentStatus}</td>
          <td><PriorityBadge priority={item.priority} /></td>
          <td>{item.customer || '—'}</td>
          <td className={`align-right strong ${item.ageDays > 60 ? 'text-red' : item.ageDays > 30 ? 'text-amber' : ''}`}>{item.ageDays ?? '—'}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function OrderLink({ item }) {
  const content = <>{item.name}{item.partNumber && <small>Part {item.partNumber}</small>}</>;
  return item.url === '#' ? <span className="order-link">{content}</span> : <a className="order-link" href={item.url} target="_blank" rel="noreferrer">{content}</a>;
}

function PriorityBadge({ priority }) {
  const value = priority || 'Not set';
  const level = /critical/i.test(value) ? 'critical' : /high/i.test(value) ? 'high' : 'normal';
  return <span className={`priority priority-${level}`}>{value}</span>;
}

function Metric({ label, value, note, tone }) {
  return <article className={`metric metric-${tone}`}><span>{label}</span><strong>{value}</strong><p>{note}</p></article>;
}

function ChartCard({ title, children }) {
  return <article className="chart-card"><h3>{title}</h3>{children}</article>;
}

function SectionHeading({ id, title, subtitle }) {
  return <div className="section-heading"><div><h2 id={id}>{title}</h2><p>{subtitle}</p></div></div>;
}

function EmptyState({ text }) {
  return <div className="empty-state">{text}</div>;
}

function LoadingView() {
  return <main className="state-view"><div className="spinner" /><h1>Loading Order Tracker</h1><p>Reading current Monday data and calculating the report…</p></main>;
}

function ErrorView({ message, onRetry }) {
  return <main className="state-view"><div className="error-icon">!</div><h1>Dashboard unavailable</h1><p>{message}</p><button className="refresh-button" onClick={onRetry}>Try again</button></main>;
}

function RefreshIcon({ spinning }) {
  return <svg className={spinning ? 'spin' : ''} width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function sourceName(item) {
  if (item.groupId === CONFIG.groups.field && /missing parts/i.test(item.orderType)) return 'Field · Missing Parts';
  if (item.groupId === CONFIG.groups.field && /warranty/i.test(item.orderType)) return 'Field · Warranty';
  if (item.groupId === CONFIG.groups.field) return `Field · ${item.orderType || 'Other'}`;
  if (item.groupId === CONFIG.groups.factory) return 'Factory · SNAP';
  if (item.groupId === CONFIG.groups.missingFactory) return 'Missing Part Factory';
  if (item.groupId === CONFIG.groups.drafts) return 'Order Draft';
  return 'Other';
}

function formatDate(date) {
  return date ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(date) : '—';
}

function formatTime(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.timeZone, hour: 'numeric', minute: '2-digit' }).format(date);
}
