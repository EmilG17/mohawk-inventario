import type { CountEntry, Product } from '../../db/db';
import type { Movement } from '../../db/movements';
import { L } from '../../i18n/i18n';
import type { LiveScannerState } from '../../sync/cloudSync';
import { clear, fmtNum, fmtTime, h } from '../dom';
import { renderLiveScannersStrip } from './teamTechsTab';
import { fmtRelativeAgo, type FeedFilter } from './teamTypes';

interface FeedEvent {
  id: string;
  timestamp: number;
  kind: 'count' | 'in' | 'out';
  actor: string;
  sku: string;
  description: string;
  qty: number;
  unit: string;
  extra: string;
}

export function renderLiveFeedTab(opts: {
  container: HTMLElement;
  roomCode: string;
  counts: CountEntry[];
  movements: Movement[];
  prodByBarcode: Map<string, Product>;
  prodBySku: Map<string, Product>;
  activeLiveScanners: LiveScannerState[];
  feedFilter: FeedFilter;
  selectedTechFilter: string;
  onChangeFeedFilter: (next: FeedFilter) => void;
  onClearTechFilter: () => void;
}): void {
  const {
    container,
    roomCode,
    counts,
    movements,
    prodByBarcode,
    prodBySku,
    activeLiveScanners,
    feedFilter,
    selectedTechFilter,
    onChangeFeedFilter,
    onClearTechFilter,
  } = opts;

  const events: FeedEvent[] = [];
  if (feedFilter === 'all' || feedFilter === 'counts') {
    for (const c of counts) {
      const prod = prodByBarcode.get(c.barcode);
      events.push({
        id: `c_${c.id}`,
        timestamp: c.timestamp,
        kind: 'count',
        actor: c.counter || L('Técnico', 'Technician'),
        sku: prod?.sku || c.barcode,
        description: prod?.description || L('Producto escaneado', 'Scanned item'),
        qty: c.qty,
        unit: prod?.unit || 'PZA',
        extra: L('Conteo físico en piso', 'Floor physical count'),
      });
    }
  }

  if (feedFilter === 'all' || feedFilter === 'movements') {
    for (const m of movements) {
      const prod = prodBySku.get(m.sku.toUpperCase());
      events.push({
        id: `m_${m.id}`,
        timestamp: m.timestamp,
        kind: m.type === 'IN' ? 'in' : 'out',
        actor: m.technicianOrSupplier || L('Almacén', 'Warehouse'),
        sku: m.sku,
        description: prod?.description || L('Movimiento de almacén', 'Warehouse movement'),
        qty: m.quantity,
        unit: prod?.unit || 'PZA',
        extra: [m.machineOrArea, m.folio ? `Folio ${m.folio}` : '', m.notes].filter(Boolean).join(' · '),
      });
    }
  }

  const filteredEvents = events
    .filter((ev) => !selectedTechFilter || ev.actor.toLowerCase() === selectedTechFilter.toLowerCase())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 120);

  const liveStrip = renderLiveScannersStrip(roomCode, activeLiveScanners, prodByBarcode, prodBySku);

  clear(
    container,
    liveStrip,
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'row wrap', style: 'justify-content: space-between; gap: 8px; margin-bottom: 12px;' },
        h(
          'div',
          { class: 'chips' },
          h(
            'button',
            {
              class: `chip ${feedFilter === 'all' ? 'active' : ''}`,
              type: 'button',
              onclick: () => onChangeFeedFilter('all'),
            },
            L('Todo el flujo en vivo', 'All live activity'),
          ),
          h(
            'button',
            {
              class: `chip ${feedFilter === 'counts' ? 'active' : ''}`,
              type: 'button',
              onclick: () => onChangeFeedFilter('counts'),
            },
            L('Solo Conteos', 'Counts only'),
          ),
          h(
            'button',
            {
              class: `chip ${feedFilter === 'movements' ? 'active' : ''}`,
              type: 'button',
              onclick: () => onChangeFeedFilter('movements'),
            },
            L('Solo Entradas / Salidas', 'Stock In / Out only'),
          ),
        ),
        selectedTechFilter
          ? h(
              'button',
              {
                class: 'chip active',
                type: 'button',
                onclick: onClearTechFilter,
              },
              `${L('Filtrando:', 'Filter:')} ${selectedTechFilter} ✕`,
            )
          : null,
      ),
      filteredEvents.length === 0
        ? h('div', { class: 'empty' }, L('No hay eventos registrados todavía para este filtro.', 'No events recorded yet for this filter.'))
        : h(
            'div',
            { class: 'sup-feed-list' },
            filteredEvents.map((ev) => {
              const badgeCls =
                ev.kind === 'count' ? 'badge info' : ev.kind === 'in' ? 'badge ok' : 'badge warn';
              const badgeText =
                ev.kind === 'count' ? L('CONTEO', 'COUNT') : ev.kind === 'in' ? L('ENTRADA', 'IN') : L('SALIDA', 'OUT');
              const sign = ev.kind === 'out' ? '−' : '+';
              const qtyColor =
                ev.kind === 'out' ? 'var(--danger)' : ev.kind === 'in' ? 'var(--success)' : 'var(--primary)';

              return h(
                'div',
                { class: 'sup-feed-item' },
                h(
                  'div',
                  { class: 'sup-feed-left' },
                  h('span', { class: badgeCls }, badgeText),
                  h(
                    'div',
                    null,
                    h(
                      'div',
                      { style: 'font-weight: 700;' },
                      h('span', { style: 'color: var(--primary); margin-right: 6px;' }, ev.sku),
                      ev.description,
                    ),
                    h(
                      'div',
                      { class: 'muted small' },
                      h('b', null, ev.actor),
                      ev.extra ? ` · ${ev.extra}` : '',
                    ),
                  ),
                ),
                h(
                  'div',
                  { class: 'sup-feed-right' },
                  h(
                    'div',
                    { style: `font-weight: 800; font-size: 15px; color: ${qtyColor};` },
                    `${sign}${fmtNum(ev.qty)} ${ev.unit}`,
                  ),
                  h('div', { class: 'muted small' }, `${fmtTime(ev.timestamp)} (${fmtRelativeAgo(ev.timestamp)})`),
                ),
              );
            }),
          ),
    ),
  );
}
