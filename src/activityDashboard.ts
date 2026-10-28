/** GitHub-like local task activity dashboard. No third-party chart dependencies. */
import type { TaskActivity } from './types';
import { getString } from './utils/locale';

let mode: 'added' | 'completed' = 'added';

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls = '', text = ''
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function renderActivityDashboard(
  stats: TaskActivity,
  skillNames: ReadonlyMap<string, string>
): HTMLElement {
  const card = node('section', 'card activity-card');
  const head = node('div', 'card-head activity-heading');
  head.append(node('h3', '', getString('panel-activity-title')));
  const modes = node('div', 'activity-modes');
  for (const field of ['added', 'completed'] as const) {
    const button = node('button', 'btn', getString(
      field === 'added' ? 'panel-activity-added' : 'panel-activity-completed'
    ));
    button.type = 'button';
    button.classList.toggle('primary', field === mode);
    button.setAttribute('aria-pressed', String(field === mode));
    button.addEventListener('click', () => {
      if (field === mode) return;
      mode = field;
      card.replaceWith(renderActivityDashboard(stats, skillNames));
    });
    modes.append(button);
  }
  head.append(modes);
  card.append(head, node('p', 'activity-subtitle', getString('panel-activity-subtitle')));

  const today = stats.daily[stats.daily.length - 1];
  const last30 = stats.daily.slice(-30).reduce(
    (a, b) => ({ added: a.added + b.added, completed: a.completed + b.completed }),
    { added: 0, completed: 0 }
  );
  const done = stats.statusCounts.done ?? 0;
  const backlog = Math.max(0, stats.total - done - (stats.statusCounts.cancelled ?? 0));
  const metrics: Array<[string, string]> = [
    [getString('panel-activity-today-added'), String(today?.added ?? 0)],
    [getString('panel-activity-today-completed'), String(today?.completed ?? 0)],
    [getString('panel-activity-30-added'), String(last30.added)],
    [getString('panel-activity-30-completed'), String(last30.completed)],
    [getString('panel-activity-backlog'), String(backlog)],
    [getString('panel-activity-done-rate'), stats.total ? (100 * done / stats.total).toFixed(1) + '%' : '0%'],
  ];
  const metricsWrap = node('div', 'activity-metrics');
  for (const [label, value] of metrics) {
    const metric = node('div', 'activity-metric');
    metric.append(node('span', 'muted', label), node('strong', '', value));
    metricsWrap.append(metric);
  }
  card.append(metricsWrap);
  if (!stats.total) card.append(node('p', 'muted', getString('panel-activity-no-data')));

  // Rows represent local weekdays, columns represent weeks; a blank offset
  // keeps the first available day aligned with its calendar weekday.
  card.append(node('h4', 'activity-section-title', getString('panel-activity-heatmap')));
  const heatOuter = node('div', 'activity-scroll');
  heatOuter.classList.toggle('activity-completed', mode === 'completed');
  const monthLabels = node('div', 'activity-month-labels');
  const heatmap = node('div', 'activity-heatmap');
  const first = stats.daily[0];
  const weekday = first ? new Date(first.key + 'T12:00:00').getDay() : 0;
  const weekCount = Math.ceil((weekday + stats.daily.length) / 7);
  // The heatmap uses 10px cells + 3px gaps. Month labels must be positioned
  // by their actual Sunday-aligned week column, not 12 equal-width months.
  monthLabels.style.width = Math.max(0, weekCount * 13 - 3) + 'px';
  const displayed = new Set<number>();
  for (let i = 0; i < stats.daily.length; i++) {
    const day = stats.daily[i];
    if (i > 0 && !day.key.endsWith('-01')) continue;
    const weekColumn = Math.floor((weekday + i) / 7);
    if (displayed.has(weekColumn)) continue;
    displayed.add(weekColumn);
    const label = node('span', '', day.key.slice(5, 7));
    label.style.left = (weekColumn * 13) + 'px';
    label.title = day.key.slice(0, 7);
    monthLabels.append(label);
  }
  heatOuter.append(monthLabels);
  for (let i = 0; i < weekday; i++) {
    const blank = node('span', 'activity-day activity-blank');
    blank.setAttribute('aria-hidden', 'true');
    heatmap.append(blank);
  }
  const maximum = Math.max(1, ...stats.daily.map(day => day[mode]));
  for (const day of stats.daily) {
    const value = day[mode];
    const level = value === 0 ? 0 : Math.max(1, Math.ceil(value / maximum * 4));
    const square = node('span', 'activity-day activity-level-' + level);
    const tip = getString('panel-activity-day-tip', {
      date: day.key, added: day.added, completed: day.completed,
    });
    square.title = tip;
    square.setAttribute('role', 'img');
    square.setAttribute('aria-label', tip);
    heatmap.append(square);
  }
  heatOuter.append(heatmap);
  const legend = node('div', 'activity-legend');
  legend.append(node('span', '', getString('panel-activity-legend-low')));
  for (let i = 0; i <= 4; i++) legend.append(node('span', 'activity-day activity-level-' + i));
  legend.append(node('span', '', getString('panel-activity-legend-high')));
  heatOuter.append(legend);
  card.append(heatOuter);

  card.append(node('h4', 'activity-section-title', getString('panel-activity-monthly')));
  const chart = node('div', 'activity-month-chart');
  const maxMonth = Math.max(1, ...stats.monthly.flatMap(month => [month.added, month.completed]));
  for (const month of stats.monthly) {
    const item = node('div', 'activity-month');
    const bars = node('div', 'activity-month-pair');
    for (const field of ['added', 'completed'] as const) {
      const bar = node('div', 'activity-bar ' + field);
      bar.style.height = Math.max(month[field] ? 3 : 0, Math.round(month[field] / maxMonth * 76)) + 'px';
      bar.title = getString('panel-activity-month-tip', {
        month: month.key, added: month.added, completed: month.completed,
      });
      bars.append(bar);
    }
    item.append(bars, node('span', 'activity-month-label', month.key.slice(5)));
    chart.append(item);
  }
  card.append(chart);
  const chartLegend = node('div', 'activity-chart-legend');
  for (const field of ['added', 'completed'] as const) {
    const legendItem = node('span', 'activity-legend-item');
    legendItem.append(
      node('span', 'activity-legend-dot ' + field),
      node('span', '', getString(field === 'added' ? 'panel-activity-added' : 'panel-activity-completed'))
    );
    chartLegend.append(legendItem);
  }
  card.append(chartLegend);

  if (stats.bySkill.length) {
    card.append(node('h4', 'activity-section-title', getString('panel-activity-pivot')));
    const scroll = node('div', 'activity-table-wrap');
    const table = node('table', 'activity-table');
    const header = node('tr');
    for (const label of [
      getString('panel-activity-pivot-skill'), getString('panel-activity-total'), getString('panel-activity-done'),
      getString('panel-activity-pivot-added'), getString('panel-activity-pivot-completed'),
    ]) header.append(node('th', '', label));
    const thead = node('thead');
    thead.append(header);
    table.append(thead);
    const tbody = node('tbody');
    for (const skill of stats.bySkill) {
      const row = node('tr');
      row.append(node('td', '', skillNames.get(skill.skillGroupId) ?? getString(
        'panel-activity-unknown-skill', { id: skill.skillGroupId }
      )));
      for (const value of [skill.total, skill.done, skill.added30, skill.completed30]) {
        row.append(node('td', '', String(value)));
      }
      tbody.append(row);
    }
    table.append(tbody);
    scroll.append(table);
    card.append(scroll);
  }
  return card;
}
