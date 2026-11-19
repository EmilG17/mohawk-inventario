import type { CountEntry } from '../../db/db';
import { L } from '../../i18n/i18n';
import type { ReportRow } from '../../report';
import { clear, fmtNum, h } from '../dom';
import type { MatrixFilter } from './teamTypes';

export interface MatrixTabRenderer {
  render(opts: {
    container: HTMLElement;
    lines: ReportRow[];
    counts: CountEntry[];
    matrixFilter: MatrixFilter;
    matrixSearch: string;
    onSearchChange: (q: string) => void;
    onFilterChange: (next: MatrixFilter) => void;
  }): void;
}

/**
 * Mantiene persistente el nodo del buscador y la tabla entre refrescos en vivo
 * para no destruir el foco/teclado (iOS Safari) al llegar eventos en tiempo real.
 */
export function createMatrixTabRenderer(): MatrixTabRenderer {
  let sectionEl: HTMLElement | null = null;
  let searchInput: HTMLInputElement | null = null;
  let chipsWrap: HTMLElement | null = null;
  let tbody: HTMLElement | null = null;

  let currentLines: ReportRow[] = [];
  let currentCounts: CountEntry[] = [];
  let currentFilter: MatrixFilter = 'all';
  let currentSearch = '';
  let onSearchCb: (q: string) => void = () => {};
  let onFilterCb: (next: MatrixFilter) => void = () => {};

  const updateRows = () => {
    if (!tbody) return;
    const countersByBarcode = new Map<string, Set<string>>();
    for (const c of currentCounts) {
      const set = countersByBarcode.get(c.barcode) ?? new Set<string>();
      set.add(c.counter || L('Técnico', 'Technician'));
      countersByBarcode.set(c.barcode, set);
    }

    const q = currentSearch.trim().toLowerCase();
    const filtered = currentLines.filter((l) => {
      if (q) {
        const match =
          l.sku.toLowerCase().includes(q) ||
          l.description.toLowerCase().includes(q) ||
          l.barcode.toLowerCase().includes(q);
        if (!match) return false;
      }
      if (currentFilter === 'alerts') {
        return l.idealStatus === 'critical' || l.idealStatus === 'deficit' || Boolean(l.needsReorder);
      }
      if (currentFilter === 'diff') {
        return (l.dynamicDiff ?? l.diff ?? 0) !== 0;
      }
      if (currentFilter === 'counted') {
        return l.scans > 0;
      }
      if (currentFilter === 'pending') {
        return l.scans === 0;
      }
      return true;
    });

    clear(
      tbody,
      filtered.slice(0, 200).map((l) => {
        const who = [...(countersByBarcode.get(l.barcode) ?? [])].join(', ') || '—';
        const diff = l.dynamicDiff ?? l.diff;
        let statusBadge = h('span', { class: 'badge ok' }, L('Óptimo', 'Optimal'));
        if (l.idealStatus === 'critical') {
          statusBadge = h('span', { class: 'badge error' }, L('Crítico', 'Critical'));
        } else if (l.idealStatus === 'deficit') {
          statusBadge = h('span', { class: 'badge warn' }, L('Por pedir', 'Reorder'));
        } else if (l.idealStatus === 'excess') {
          statusBadge = h('span', { class: 'badge info' }, L('Exceso', 'Excess'));
        }

        return h(
          'tr',
          null,
          h('td', null, h('b', null, l.sku || l.barcode)),
          h('td', { style: 'max-width: 220px; white-space: normal;' }, l.description),
          h('td', { style: 'text-align: right;' }, l.dynamicExpected !== undefined ? fmtNum(l.dynamicExpected) : '—'),
          h(
            'td',
            { style: 'text-align: right; font-weight: 800;' },
            l.scans > 0 ? fmtNum(l.counted) : h('span', { class: 'muted' }, L('Sin contar', 'Not counted')),
          ),
          h(
            'td',
            {
              style: `text-align: right; font-weight: 700; color: ${
                diff === undefined ? 'inherit' : diff < 0 ? 'var(--danger)' : diff > 0 ? 'var(--info)' : 'var(--success)'
              };`,
            },
            diff === undefined ? '—' : `${diff > 0 ? '+' : ''}${fmtNum(diff)}`,
          ),
          h('td', { style: 'text-align: right;' }, l.idealQty !== undefined ? fmtNum(l.idealQty) : '—'),
          h('td', { class: 'small muted' }, who),
          h('td', { style: 'text-align: center;' }, statusBadge),
        );
      }),
    );
  };

  const renderChips = () => {
    if (!chipsWrap) return;
    const chipDef: { id: MatrixFilter; label: string }[] = [
      { id: 'all', label: `${L('Todos', 'All')} (${currentLines.length})` },
      { id: 'alerts', label: L('Críticos / Por Pedir', 'Critical / Reorder') },
      { id: 'diff', label: L('Con Diferencia', 'With Variance') },
      { id: 'counted', label: L('Ya Contados', 'Counted') },
      { id: 'pending', label: L('Pendientes de Contar', 'Pending') },
    ];
    clear(
      chipsWrap,
      chipDef.map((c) =>
        h(
          'button',
          {
            class: `chip ${currentFilter === c.id ? 'active' : ''}`,
            type: 'button',
            onclick: () => onFilterCb(c.id),
          },
          c.label,
        ),
      ),
    );
  };

  const ensureDom = () => {
    if (sectionEl) return;
    searchInput = h('input', {
      class: 'input',
      type: 'search',
      placeholder: L('Buscar SKU, código de barras o descripción...', 'Search SKU, barcode or description...'),
      oninput: (e: Event) => {
        currentSearch = (e.target as HTMLInputElement).value;
        onSearchCb(currentSearch);
        updateRows();
      },
    }) as HTMLInputElement;
    chipsWrap = h('div', { class: 'chips' });
    tbody = h('tbody');

    sectionEl = h(
      'section',
      { class: 'card' },
      h(
        'div',
        { style: 'display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;' },
        searchInput,
        chipsWrap,
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'comp-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, 'SKU'),
              h('th', null, L('Descripción', 'Description')),
              h('th', { style: 'text-align: right;' }, L('Esperado Dinámico', 'Dynamic Expected')),
              h('th', { style: 'text-align: right;' }, L('Contado Físico', 'Physical Count')),
              h('th', { style: 'text-align: right;' }, L('Diferencia', 'Variance')),
              h('th', { style: 'text-align: right;' }, 'Ideal'),
              h('th', null, L('Contado por', 'Counted by')),
              h('th', { style: 'text-align: center;' }, L('Estado', 'Status')),
            ),
          ),
          tbody,
        ),
      ),
    );
  };

  return {
    render(opts) {
      currentLines = opts.lines;
      currentCounts = opts.counts;
      currentFilter = opts.matrixFilter;
      currentSearch = opts.matrixSearch;
      onSearchCb = opts.onSearchChange;
      onFilterCb = opts.onFilterChange;

      ensureDom();
      if (searchInput && searchInput.value !== currentSearch) {
        searchInput.value = currentSearch;
      }
      renderChips();
      updateRows();

      if (sectionEl && !opts.container.contains(sectionEl)) {
        clear(opts.container, sectionEl);
      }
    },
  };
}
