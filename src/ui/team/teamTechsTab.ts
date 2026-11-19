import type { Product, Session } from '../../db/db';
import { L } from '../../i18n/i18n';
import { normalizeBarcode } from '../../io/normalize';
import type { LiveScannerState } from '../../sync/cloudSync';
import { clear, fmtNum, h, icon } from '../dom';
import { navigate } from '../router';
import { fmtRelativeAgo, type TechSummary } from './teamTypes';

export function renderLiveScannersStrip(
  roomCode: string,
  scanners: LiveScannerState[],
  prodByBarcode: Map<string, Product>,
  prodBySku: Map<string, Product>,
): HTMLElement | null {
  if (scanners.length === 0 && !roomCode) return null;

  const statusMeta = (st: LiveScannerState['status']) => {
    if (st === 'pending_confirm') return { label: L('Confirmando cantidad', 'Confirming quantity'), cls: 'badge warn' };
    if (st === 'scanning') return { label: L('Cámara buscando código', 'Camera scanning barcode'), cls: 'badge info' };
    if (st === 'registered') return { label: L('Recién registrado', 'Just recorded'), cls: 'badge ok' };
    return { label: L('Escáner en pausa', 'Scanner paused'), cls: 'badge' };
  };

  return h(
    'section',
    {
      class: 'card sup-live-scanners-card',
      'data-testid': 'team-live-scanners',
      style: 'margin-bottom: 14px; border: 1px solid var(--border);',
    },
    h(
      'div',
      { class: 'row wrap', style: 'justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px;' },
      h(
        'div',
        null,
        h('h3', { style: 'margin: 0; font-size: 15px;' }, L('Escáneres en Vivo', 'Live Scanners')),
        h(
          'div',
          { class: 'muted small' },
          scanners.length > 0
            ? L(
                `${scanners.length} terminal(es) reportando actividad de escáner en tiempo real`,
                `${scanners.length} terminal(s) streaming live scanner activity`,
              )
            : L(
                `Sala ${roomCode} lista · cuando un técnico encienda cámara o escanee aparecerá aquí al instante`,
                `Room ${roomCode} ready · when a technician turns on the camera or scans, it appears here live`,
              ),
        ),
      ),
    ),
    scanners.length > 0
      ? h(
          'div',
          { class: 'col', style: 'gap: 8px;' },
          scanners.map((sc) => {
            const meta = statusMeta(sc.status);
            const prod =
              (sc.barcode ? prodByBarcode.get(sc.barcode) || prodByBarcode.get(normalizeBarcode(sc.barcode)) : undefined) ||
              (sc.sku ? prodBySku.get(sc.sku.toUpperCase()) : undefined);
            const skuDisplay = sc.sku || prod?.sku || sc.barcode || '—';
            const descDisplay = sc.description || prod?.description || '';
            const originIcon =
              sc.origin === 'camara'
                ? L('Cámara', 'Camera')
                : sc.origin === 'teclado'
                  ? 'USB/BT'
                  : sc.origin === 'manual'
                    ? L('Manual', 'Manual')
                    : '';

            return h(
              'div',
              {
                class: 'sup-live-scanner-row',
                'data-testid': `live-scanner-${sc.counter}`,
                style:
                  'display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg-subtle); border: 1px solid var(--border);',
              },
              h(
                'div',
                { class: 'row wrap', style: 'gap: 8px; align-items: center;' },
                h('strong', null, sc.counter),
                h('span', { class: meta.cls }, meta.label),
                sc.cameraOn ? h('span', { class: 'badge info' }, 'Cam ON') : null,
                originIcon ? h('span', { class: 'muted small' }, originIcon) : null,
              ),
              h(
                'div',
                { class: 'row wrap', style: 'gap: 10px; align-items: center;' },
                sc.barcode || sc.sku
                  ? h(
                      'span',
                      { class: 'small' },
                      h('code', { class: 'mono' }, skuDisplay),
                      descDisplay ? ` · ${descDisplay}` : '',
                    )
                  : h('span', { class: 'muted small' }, L('Esperando lectura de código...', 'Waiting for barcode scan...')),
                typeof sc.qty === 'number'
                  ? h('span', { class: 'badge ok', style: 'font-weight: 800;' }, `${L('Cant:', 'Qty:')} ${fmtNum(sc.qty)}`)
                  : null,
                h('span', { class: 'muted small' }, fmtRelativeAgo(sc.updatedAt)),
              ),
            );
          }),
        )
      : null,
  );
}

export function renderTechsTab(opts: {
  container: HTMLElement;
  roomCode: string;
  techList: TechSummary[];
  totalUnits: number;
  current: Session | undefined;
  activeLiveScanners: LiveScannerState[];
  prodByBarcode: Map<string, Product>;
  prodBySku: Map<string, Product>;
  onOpenInvite: () => void;
  onSelectTech: (techName: string) => void;
}): void {
  const {
    container,
    roomCode,
    techList,
    totalUnits,
    current,
    activeLiveScanners,
    prodByBarcode,
    prodBySku,
    onOpenInvite,
    onSelectTech,
  } = opts;

  const liveStrip = renderLiveScannersStrip(roomCode, activeLiveScanners, prodByBarcode, prodBySku);

  if (techList.length === 0) {
    clear(
      container,
      liveStrip,
      h(
        'section',
        { class: 'card', style: 'text-align: center; padding: 28px 16px;' },
        h('h3', { style: 'margin: 0 0 6px 0;' }, L('Aún no hay lecturas de técnicos en esta sala', 'No technician scans in this room yet')),
        h(
          'p',
          { class: 'muted small', style: 'max-width: 480px; margin: 0 auto 14px auto;' },
          L(
            'Comparte el código QR de la sala con tu equipo o inicia el conteo. En cuanto el primer técnico escanee un producto o registre una entrada/salida, aparecerá su tarjeta aquí en tiempo real.',
            'Share the room QR code with your team or start counting. As soon as the first technician scans an item or logs a movement, their card appears here live.',
          ),
        ),
        h(
          'div',
          { class: 'row wrap', style: 'justify-content: center; gap: 8px;' },
          roomCode
            ? h(
                'button',
                {
                  class: 'btn primary',
                  type: 'button',
                  onclick: onOpenInvite,
                },
                icon('scan'),
                L('Mostrar QR para conectar técnicos', 'Show QR to connect technicians'),
              )
            : null,
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => navigate('/contar'),
            },
            L('Ir a Contar', 'Go to Count'),
          ),
        ),
      ),
    );
    return;
  }

  const nowMs = Date.now();
  clear(
    container,
    liveStrip,
    h(
      'div',
      { class: 'sup-tech-grid' },
      techList.map((t) => {
        const isOnline = nowMs - t.lastSeen <= 3 * 60 * 1000;
        const sharePct = totalUnits > 0 ? Math.min(100, Math.round((Math.max(0, t.units) / totalUnits) * 100)) : 0;
        const initials =
          t.name
            .split(/\s+/)
            .map((w) => w[0] || '')
            .join('')
            .toUpperCase()
            .slice(0, 2) || 'T';

        return h(
          'article',
          { class: `card sup-tech-card ${isOnline ? 'online' : ''}` },
          h(
            'div',
            { class: 'sup-tech-head' },
            h(
              'div',
              { class: 'row', style: 'gap: 10px; align-items: center;' },
              h('div', { class: 'sup-tech-avatar' }, initials),
              h(
                'div',
                null,
                h('div', { style: 'font-weight: 800; font-size: 15px;' }, t.name),
                h('div', { class: 'muted small' }, `${t.skusTouched.size} ${L('SKU(s) distintos atendidos', 'distinct SKU(s) handled')}`),
              ),
            ),
            h(
              'span',
              { class: `badge ${isOnline ? 'ok' : 'info'}` },
              isOnline ? `● ${L('Activo', 'Active')} (${fmtRelativeAgo(t.lastSeen)})` : fmtRelativeAgo(t.lastSeen),
            ),
          ),
          t.liveScanner && (t.liveScanner.status === 'pending_confirm' || t.liveScanner.status === 'scanning')
            ? h(
                'div',
                {
                  class: 'small',
                  style:
                    'margin: 6px 0; padding: 6px 8px; border-radius: var(--radius-sm); background: var(--warning-bg); border: 1px solid rgba(217, 119, 6, 0.35);',
                },
                t.liveScanner.status === 'pending_confirm'
                  ? `${L('En pantalla:', 'On screen:')} ${t.liveScanner.sku || t.liveScanner.barcode || ''} · ${L('Cant:', 'Qty:')} ${fmtNum(t.liveScanner.qty ?? 1)}`
                  : L('Cámara encendida buscando código...', 'Camera active scanning barcode...'),
              )
            : null,
          h(
            'div',
            { class: 'sup-tech-metrics' },
            h(
              'div',
              { class: 'sup-tech-metric' },
              h('span', { class: 'muted small' }, L('Escaneos', 'Scans')),
              h('b', null, fmtNum(t.scans)),
            ),
            h(
              'div',
              { class: 'sup-tech-metric' },
              h('span', { class: 'muted small' }, L('Unidades contadas', 'Units counted')),
              h('b', null, fmtNum(t.units)),
            ),
            h(
              'div',
              { class: 'sup-tech-metric' },
              h('span', { class: 'muted small' }, L('Movs. Kardex', 'Kardex Txns')),
              h('b', null, fmtNum(t.movementsCount)),
            ),
          ),
          h(
            'div',
            { class: 'sup-progress-track', style: 'margin: 6px 0;' },
            h('div', { class: 'sup-progress-fill', style: `width: ${sharePct}%;` }),
          ),
          h(
            'div',
            { class: 'sup-tech-last' },
            h('span', { class: 'muted small' }, L('Última acción: ', 'Last action: ')),
            h('span', { style: 'font-weight: 600;' }, t.lastActionLabel),
          ),
          h(
            'div',
            { class: 'row', style: 'justify-content: flex-end; margin-top: 8px; gap: 6px;' },
            h(
              'button',
              {
                class: 'btn sm ghost',
                type: 'button',
                onclick: () => onSelectTech(t.name),
              },
              L('Ver su historial en vivo →', 'View live history →'),
            ),
          ),
        );
      }),
    ),
    current
      ? h(
          'div',
          { class: 'row wrap', style: 'justify-content: flex-end; gap: 8px; margin-top: 12px;' },
          h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              onclick: () => navigate(`/reporte?session=${current.id}`),
            },
            icon('chart'),
            L('Abrir Reporte Consolidado Completo', 'Open Full Consolidated Report'),
          ),
        )
      : null,
  );
}
