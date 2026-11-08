import {
  allProducts,
  allSessions,
  closeSession,
  countsForSession,
  deleteSession,
  getActiveSession,
  getDeviceId,
  reopenSession,
  setActiveSession,
  type CountEntry,
  type Product,
  type Session,
} from '../db/db';
import {
  getIdealLevels,
  getMovementSummariesBySku,
  listMovements,
  type Movement,
} from '../db/movements';
import { renderQrCodeSvg } from '../barcode/code128';
import { buildCountFile, safeFileName, type CountFile } from '../io/exportResults';
import { mergeCountFiles, parseTechnicianReportFile } from '../io/mergeCounts';
import { buildReport, type ReportRow } from '../report';
import { loadSettings, saveSettings } from '../settings';
import {
  buildRoomInviteUrl,
  decodeCompactCountQr,
  encodeCompactCountQrChunks,
  generateRoomCode,
  getCloudConnectionStatus,
  normalizeEndpointBaseUrl,
  normalizeRoomCode,
  onCloudRoomUpdate,
  onCloudStatusChange,
  startLiveCloudSync,
  syncNow,
  testFirebaseConnection,
  type CloudConnectionStatus,
} from '../sync/cloudSync';
import {
  clear,
  confirmDialog,
  fmtDateTime,
  fmtNum,
  fmtTime,
  h,
  icon,
  MIME,
  openDialog,
  pickFiles,
  shareOrDownload,
  toast,
} from './dom';
import { newSessionFlow } from './home';
import { navigate, type View } from './router';
import { openUnifyReportsDialog } from './unifyReportsDialog';

type SupervisorTab = 'techs' | 'feed' | 'matrix' | 'sessions';
type FeedFilter = 'all' | 'counts' | 'movements';
type MatrixFilter = 'all' | 'alerts' | 'diff' | 'counted' | 'pending';

let activeTab: SupervisorTab = 'techs';
let feedFilter: FeedFilter = 'all';
let selectedTechFilter = '';
let matrixFilter: MatrixFilter = 'all';
let matrixSearch = '';
let configExpanded: boolean | null = null;

let unsubscribeRoom: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;
let relativeTimeTimer: ReturnType<typeof setInterval> | null = null;

function fmtRelativeAgo(ts: number | null | undefined): string {
  if (!ts) return 'Sin actividad';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 5) return 'Justo ahora';
  if (diffSec < 60) return `Hace ${diffSec} s`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `Hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Hace ${hrs} h`;
  return fmtDateTime(ts);
}

function openRoomInviteQrDialog(roomCode: string, endpointUrl: string): void {
  const inviteUrl = buildRoomInviteUrl(roomCode, endpointUrl);
  const svg = renderQrCodeSvg(inviteUrl, 240, 2);

  const qrBox = h('div', {
    style:
      'display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 16px; background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; margin: 8px auto;',
  });
  qrBox.innerHTML = svg;

  const urlInput = h('input', {
    class: 'input sm',
    readonly: true,
    value: inviteUrl,
    onclick: (e: Event) => (e.target as HTMLInputElement).select(),
  }) as HTMLInputElement;

  const copyBtn = h(
    'button',
    {
      class: 'btn primary sm',
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(inviteUrl);
          toast('Enlace de invitación copiado al portapapeles', 'ok');
        } catch {
          urlInput.select();
          toast('Selecciona y copia el enlace', 'info');
        }
      },
    },
    '📋 Copiar enlace para WhatsApp',
  );

  const body = h(
    'div',
    { class: 'form', style: 'text-align: center;' },
    h(
      'div',
      { class: 'badge ok', style: 'align-self: center;' },
      `Sala en Vivo: ${roomCode}`,
    ),
    h(
      'p',
      { class: 'muted small', style: 'margin: 0;' },
      'Pide a los técnicos que escaneen este código QR con la cámara de su teléfono o envíales el enlace directo. Su aplicación configurará Firebase y el Código de Sala automáticamente.',
    ),
    qrBox,
    h('div', { class: 'row', style: 'gap: 6px;' }, urlInput, copyBtn),
  );

  openDialog(`Invitar Técnicos · Sala ${roomCode}`, body, [{ label: 'Cerrar' }]);
}

function openShowMyQrDialog(session: Session, counts: CountEntry[]): void {
  const chunks = encodeCompactCountQrChunks(session, counts, 25);
  let idx = 0;

  const qrBox = h('div', {
    style: 'display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px; background: #fff; border-radius: 12px; border: 1px solid #e2e8f0;',
  });
  const pageLabel = h('div', { class: 'badge info' });

  const renderSlide = () => {
    const svg = renderQrCodeSvg(chunks[idx], 240, 2);
    qrBox.innerHTML = svg;
    pageLabel.textContent =
      chunks.length > 1
        ? `Código QR ${idx + 1} de ${chunks.length} (${counts.length} lecturas totales)`
        : `Código QR listo (${counts.length} lectura${counts.length === 1 ? '' : 's'})`;
  };
  renderSlide();

  const body = h(
    'div',
    { class: 'form', style: 'text-align: center;' },
    h(
      'p',
      { class: 'muted small', style: 'margin: 0;' },
      `Pide al supervisor que escanee este código QR desde la pestaña Contar o desde Supervisor → "Recibir por QR" para consolidar los conteos de ${session.counter}.`,
    ),
    pageLabel,
    qrBox,
    chunks.length > 1
      ? h(
          'div',
          { class: 'row', style: 'justify-content: center; gap: 8px;' },
          h(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              onclick: () => {
                idx = (idx - 1 + chunks.length) % chunks.length;
                renderSlide();
              },
            },
            '◀ Anterior',
          ),
          h(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              onclick: () => {
                idx = (idx + 1) % chunks.length;
                renderSlide();
              },
            },
            'Siguiente ▶',
          ),
        )
      : null,
  );

  openDialog(`QR de conteo · ${session.counter}`, body, [{ label: 'Cerrar' }]);
}

function openReceiveQrDialog(activeSession: Session, onMerged: () => void): void {
  const input = h('textarea', {
    class: 'input',
    rows: 3,
    placeholder: 'Escanea el QR con lector o pega aquí el código MHKSYNC1|...',
  }) as HTMLTextAreaElement;

  const body = h(
    'div',
    { class: 'form' },
    h(
      'p',
      { class: 'muted small', style: 'margin: 0;' },
      'Puedes escanear directamente el QR del técnico desde la cámara en la pestaña "Contar", con pistola lectora 2D aquí, o pegar el texto del QR:',
    ),
    input,
  );

  openDialog('Recibir conteo por QR', body, [
    { label: 'Cancelar' },
    {
      label: 'Consolidar QR',
      kind: 'primary',
      onClick: async () => {
        const val = input.value.trim();
        if (!val) {
          toast('Escanea o pega primero el contenido del QR', 'warn');
          return true;
        }
        try {
          const cf = decodeCompactCountQr(val);
          const res = await mergeCountFiles(activeSession.id, [cf]);
          toast(
            `QR de ${cf.session.counter} integrado: +${res.added} lectura(s) (${res.duplicates} duplicadas omitidas)`,
            'ok',
            4500,
          );
          onMerged();
        } catch (err) {
          toast((err as Error).message || 'QR inválido', 'error');
          return true;
        }
      },
    },
  ]);
}

export const teamView: View = {
  title: 'Monitor de Supervisor en Vivo',
  async render(root) {
    let s = await loadSettings();

    // Si tiene sala configurada, asegurar que la escucha en tiempo real esté corriendo
    if (s.syncRoomCode) {
      startLiveCloudSync({
        roomCode: s.syncRoomCode,
        endpointUrl: s.syncEndpointUrl,
      });
    }

    // Si aún no ha configurado Firebase o Sala, mostrar el panel de configuración abierto por defecto;
    // una vez conectado a Firebase, colapsarlo para que la vista del supervisor sea 100% limpia.
    if (configExpanded === null) {
      configExpanded = !s.syncRoomCode || !s.syncEndpointUrl;
    }

    // Contenedores de actualización sin parpadeo
    const statusHeaderWrap = h('div');
    const configDrawerWrap = h('div');
    const errorBannerWrap = h('div');
    const kpiGridWrap = h('div', { class: 'sup-kpi-grid' });
    const tabsBarWrap = h('div', { class: 'sup-tabs-bar' });
    const tabContentWrap = h('div', { class: 'sup-tab-body' });

    clear(
      root,
      statusHeaderWrap,
      errorBannerWrap,
      configDrawerWrap,
      kpiGridWrap,
      tabsBarWrap,
      tabContentWrap,
    );

    // Controles persistentes del cajón de configuración
    const roomInput = h('input', {
      class: 'input',
      value: s.syncRoomCode || 'MHK-2026',
      placeholder: 'Ej. MHK-2026',
      style: 'text-transform: uppercase; font-weight: 700;',
    }) as HTMLInputElement;

    const endpointInput = h('input', {
      class: 'input',
      value: s.syncEndpointUrl,
      placeholder: 'https://tu-proyecto-default-rtdb.firebaseio.com',
      onblur: () => {
        const clean = normalizeEndpointBaseUrl(endpointInput.value);
        if (clean) endpointInput.value = clean;
      },
    }) as HTMLInputElement;

    const autoCheck = h('input', {
      type: 'checkbox',
      checked: s.syncAuto,
      onchange: async (e: Event) => {
        await saveSettings({ syncAuto: (e.target as HTMLInputElement).checked, syncEnabled: true });
      },
    }) as HTMLInputElement;

    const diagBox = h('div', { class: 'sup-diag-box', hidden: true });

    const connectAndSync = async () => {
      const code = normalizeRoomCode(roomInput.value) || generateRoomCode('MHK');
      const cleanEndpoint = normalizeEndpointBaseUrl(endpointInput.value);
      roomInput.value = code;
      endpointInput.value = cleanEndpoint;

      await saveSettings({
        syncEnabled: true,
        syncRoomCode: code,
        syncEndpointUrl: cleanEndpoint,
        syncAuto: autoCheck.checked,
      });
      s = await loadSettings();

      startLiveCloudSync({ roomCode: code, endpointUrl: cleanEndpoint });
      try {
        const res = await syncNow({
          roomCode: code,
          endpointUrl: cleanEndpoint,
        });
        if (cleanEndpoint && res.transport === 'remote') {
          configExpanded = false;
          toast(
            `Conectado en vivo a Firebase · Sala ${res.roomCode} (${res.totalRoomCounts} lecturas, ${res.participants.length} técnico(s))`,
            'ok',
            4000,
          );
        } else {
          toast(`Sala ${res.roomCode} sincronizada en modo local`, 'info', 3500);
        }
        await refreshDashboard();
      } catch (err) {
        toast((err as Error).message || 'Error al sincronizar sala', 'error');
        await refreshDashboard();
      }
    };

    const runFirebaseTest = async () => {
      const code = normalizeRoomCode(roomInput.value) || 'MHK-TEST';
      const cleanEndpoint = normalizeEndpointBaseUrl(endpointInput.value);
      endpointInput.value = cleanEndpoint;
      diagBox.hidden = false;
      diagBox.className = 'sup-diag-box info';
      diagBox.textContent = 'Probando conexión con Firebase Realtime Database...';
      const res = await testFirebaseConnection(cleanEndpoint, code);
      diagBox.className = `sup-diag-box ${res.ok ? 'ok' : 'error'}`;
      diagBox.textContent = res.message;
    };

    const renderStatusHeader = (status: CloudConnectionStatus) => {
      const hasFirebase = Boolean(s.syncEndpointUrl || status.endpointUrl);
      const roomCode = status.roomCode || s.syncRoomCode || 'SIN-SALA';

      let pillClass = 'sup-live-pill off';
      let pillLabel = '⚪ Sin sala activa';
      if (status.state === 'connected' && hasFirebase) {
        pillClass = 'sup-live-pill live';
        pillLabel = `🟢 EN VIVO · Firebase (${status.lastLatencyMs ?? 80} ms)`;
      } else if (status.state === 'connecting') {
        pillClass = 'sup-live-pill connecting';
        pillLabel = '🟡 Conectando con Firebase...';
      } else if (status.state === 'error') {
        pillClass = 'sup-live-pill error';
        pillLabel = '🔴 Error de conexión Firebase';
      } else if (s.syncRoomCode) {
        pillClass = 'sup-live-pill local';
        pillLabel = '🔵 Sala Local (Mismo dispositivo / sin URL Firebase)';
      }

      clear(
        statusHeaderWrap,
        h(
          'section',
          { class: 'card sup-hero-bar' },
          h(
            'div',
            { class: 'sup-hero-left' },
            h(
              'div',
              { class: 'row wrap', style: 'gap: 8px; align-items: center;' },
              h('span', { class: pillClass }, pillLabel),
              s.syncRoomCode
                ? h('span', { class: 'badge info', style: 'font-weight: 800;' }, `SALA: ${roomCode}`)
                : null,
              status.lastSyncedAt
                ? h(
                    'span',
                    { class: 'muted small', id: 'sup-last-sync-ago', 'data-ts': String(status.lastSyncedAt) },
                    `Actualizado: ${fmtRelativeAgo(status.lastSyncedAt)}`,
                  )
                : null,
            ),
            h(
              'h2',
              { style: 'margin: 4px 0 0 0; font-size: 18px;' },
              'Centro de Monitoreo del Supervisor',
            ),
          ),
          h(
            'div',
            { class: 'sup-hero-actions' },
            s.syncRoomCode
              ? h(
                  'button',
                  {
                    class: 'btn sm',
                    type: 'button',
                    onclick: () => openRoomInviteQrDialog(s.syncRoomCode, s.syncEndpointUrl),
                  },
                  icon('scan'),
                  'Invitar Técnicos (QR / Link)',
                )
              : null,
            h(
              'button',
              {
                class: 'btn sm primary',
                type: 'button',
                onclick: connectAndSync,
              },
              icon('globe'),
              'Sincronizar ahora',
            ),
            h(
              'button',
              {
                class: `btn sm ${configExpanded ? 'active' : 'ghost'}`,
                type: 'button',
                onclick: () => {
                  configExpanded = !configExpanded;
                  renderConfigDrawer();
                  renderStatusHeader(getCloudConnectionStatus());
                },
              },
              icon('gear'),
              configExpanded ? 'Ocultar configuración' : 'Configurar Firebase',
            ),
          ),
        ),
      );

      // Banner de error diagnóstico si Firebase rechazó permisos o URL
      if (status.lastError) {
        clear(
          errorBannerWrap,
          h(
            'div',
            { class: 'card sup-error-banner' },
            h('div', { style: 'font-weight: 700; margin-bottom: 4px;' }, '⚠️ Atención con el enlace de Firebase:'),
            h('div', { class: 'small' }, status.lastError),
            status.lastError.includes('401') || status.lastError.includes('403')
              ? h(
                  'div',
                  { class: 'row wrap', style: 'margin-top: 8px; gap: 8px;' },
                  h(
                    'button',
                    {
                      class: 'btn sm',
                      type: 'button',
                      onclick: async () => {
                        const rules = '{\n  "rules": {\n    ".read": true,\n    ".write": true\n  }\n}';
                        try {
                          await navigator.clipboard.writeText(rules);
                          toast('Reglas JSON copiadas. Pégalas en Firebase → Realtime Database → Reglas', 'ok', 4500);
                        } catch {}
                      },
                    },
                    '📋 Copiar Reglas para Firebase (.read / .write)',
                  ),
                )
              : null,
          ),
        );
      } else {
        clear(errorBannerWrap);
      }
    };

    const renderConfigDrawer = () => {
      if (!configExpanded) {
        clear(configDrawerWrap);
        return;
      }

      clear(
        configDrawerWrap,
        h(
          'section',
          { class: 'card sup-config-card' },
          h(
            'div',
            { class: 'card-head wrap', style: 'gap: 8px;' },
            h(
              'div',
              null,
              h('h3', { style: 'margin: 0;' }, '☁️ Configuración de Sala y Enlace Firebase'),
              h(
                'p',
                { class: 'muted small', style: 'margin: 2px 0 0 0;' },
                'Pega el enlace de tu Firebase Realtime Database (incluso si es el link de la consola web, se limpiará automáticamente).',
              ),
            ),
          ),
          h(
            'div',
            { class: 'grid2', style: 'margin-top: 10px;' },
            h(
              'label',
              { class: 'field' },
              h('span', null, '1. Código de Sala compartida'),
              h(
                'div',
                { class: 'row', style: 'gap: 6px;' },
                roomInput,
                h(
                  'button',
                  {
                    class: 'btn sm',
                    type: 'button',
                    onclick: () => {
                      roomInput.value = generateRoomCode('MHK');
                    },
                  },
                  'Generar',
                ),
              ),
            ),
            h(
              'label',
              { class: 'field' },
              h('span', null, '2. Enlace de Firebase Realtime Database'),
              h(
                'div',
                { class: 'row', style: 'gap: 6px;' },
                endpointInput,
                h(
                  'button',
                  {
                    class: 'btn sm',
                    type: 'button',
                    onclick: runFirebaseTest,
                  },
                  '🔌 Probar',
                ),
              ),
            ),
          ),
          diagBox,
          h(
            'div',
            {
              class: 'row wrap',
              style: 'justify-content: space-between; align-items: center; margin-top: 10px; gap: 10px;',
            },
            h(
              'label',
              { class: 'check-inline small' },
              autoCheck,
              h('span', null, 'Transmitir y recibir cada escaneo y movimiento automáticamente en tiempo real'),
            ),
            h(
              'div',
              { class: 'row wrap', style: 'gap: 8px;' },
              h(
                'button',
                { class: 'btn primary', type: 'button', onclick: connectAndSync },
                icon('globe'),
                'Guardar y Conectar en Vivo',
              ),
            ),
          ),
        ),
      );
    };

    const refreshDashboard = async () => {
      if (!root.isConnected) return;
      const [sessions, current, deviceId, products, movements, movSummaries, idealLevels] = await Promise.all([
        allSessions(),
        getActiveSession(),
        getDeviceId(),
        allProducts(),
        listMovements(),
        getMovementSummariesBySku(),
        getIdealLevels(),
      ]);
      if (!root.isConnected) return;

      const curCounts = current ? await countsForSession(current.id) : [];
      const reportLines = buildReport(products, curCounts, {
        includeNotCounted: true,
        movementsBySku: movSummaries,
        idealLevels,
      });

      // Mapear productos por código de barras y por SKU
      const prodByBarcode = new Map<string, Product>();
      const prodBySku = new Map<string, Product>();
      for (const p of products) {
        prodByBarcode.set(p.barcode, p);
        if (p.sku) prodBySku.set(p.sku.toUpperCase(), p);
      }

      // Agrupar actividad por técnico (conteos + movimientos de Kardex)
      interface TechSummary {
        name: string;
        scans: number;
        units: number;
        movementsCount: number;
        lastSeen: number;
        lastActionLabel: string;
        skusTouched: Set<string>;
      }
      const techMap = new Map<string, TechSummary>();

      const sortedCounts = [...curCounts].sort((a, b) => a.timestamp - b.timestamp);
      for (const c of sortedCounts) {
        const name = (c.counter || 'Técnico').trim();
        const prod = prodByBarcode.get(c.barcode);
        const skuLabel = prod?.sku || c.barcode;
        const descLabel = prod?.description || c.barcode;
        const cur = techMap.get(name) ?? {
          name,
          scans: 0,
          units: 0,
          movementsCount: 0,
          lastSeen: 0,
          lastActionLabel: 'Sin lecturas',
          skusTouched: new Set<string>(),
        };
        cur.scans += 1;
        cur.units += c.qty;
        cur.skusTouched.add(skuLabel);
        if (c.timestamp >= cur.lastSeen) {
          cur.lastSeen = c.timestamp;
          cur.lastActionLabel = `Contó ${c.qty >= 0 ? '+' : ''}${fmtNum(c.qty)} · ${skuLabel} (${descLabel})`;
        }
        techMap.set(name, cur);
      }

      const sortedMovs = [...movements].sort((a, b) => a.timestamp - b.timestamp);
      for (const m of sortedMovs) {
        const name = (m.technicianOrSupplier || 'Almacén').trim();
        const prod = prodBySku.get(m.sku.toUpperCase());
        const descLabel = prod?.description || m.sku;
        const cur = techMap.get(name) ?? {
          name,
          scans: 0,
          units: 0,
          movementsCount: 0,
          lastSeen: 0,
          lastActionLabel: 'Sin actividad',
          skusTouched: new Set<string>(),
        };
        cur.movementsCount += 1;
        cur.skusTouched.add(m.sku.toUpperCase());
        if (m.timestamp >= cur.lastSeen) {
          cur.lastSeen = m.timestamp;
          cur.lastActionLabel = `${m.type === 'IN' ? 'Entrada +' : 'Salida −'}${fmtNum(m.quantity)} · ${m.sku} (${descLabel})`;
        }
        techMap.set(name, cur);
      }

      const techList = [...techMap.values()].sort((a, b) => b.lastSeen - a.lastSeen);
      const now = Date.now();
      const activeNowCount = techList.filter((t) => now - t.lastSeen <= 5 * 60 * 1000).length;

      // Métricas globales
      const totalCatalogSkus = products.length;
      const countedSkusCount = reportLines.filter((r) => r.scans > 0).length;
      const progressPct =
        totalCatalogSkus > 0 ? Math.min(100, Math.round((countedSkusCount / totalCatalogSkus) * 100)) : 0;
      const totalUnitsCounted = reportLines.reduce((acc, r) => acc + r.counted, 0);
      const totalInUnits = movements.filter((m) => m.type === 'IN').reduce((acc, m) => acc + m.quantity, 0);
      const totalOutUnits = movements.filter((m) => m.type === 'OUT').reduce((acc, m) => acc + m.quantity, 0);
      const criticalCount = reportLines.filter((r) => r.idealStatus === 'critical').length;
      const deficitCount = reportLines.filter((r) => r.idealStatus === 'deficit').length;
      const alertSkusCount = criticalCount + deficitCount;

      // 1. Renderizar 4 KPIs limpios del Supervisor
      clear(
        kpiGridWrap,
        h(
          'div',
          {
            class: 'sup-kpi-card clickable',
            onclick: () => {
              activeTab = 'techs';
              void refreshDashboard();
            },
          },
          h('div', { class: 'sup-kpi-label' }, '👨‍🔧 Técnicos Participantes'),
          h('div', { class: 'sup-kpi-value' }, `${techList.length}`),
          h(
            'div',
            { class: 'sup-kpi-sub' },
            activeNowCount > 0
              ? `🟢 ${activeNowCount} activo(s) en los últimos 5 min`
              : `${curCounts.length} lecturas acumuladas`,
          ),
        ),
        h(
          'div',
          {
            class: 'sup-kpi-card clickable',
            onclick: () => {
              activeTab = 'matrix';
              matrixFilter = 'all';
              void refreshDashboard();
            },
          },
          h('div', { class: 'sup-kpi-label' }, '📦 Avance de Conteo Físico'),
          h('div', { class: 'sup-kpi-value' }, `${fmtNum(totalUnitsCounted)} u.`),
          h(
            'div',
            { class: 'sup-kpi-sub' },
            `${countedSkusCount} de ${totalCatalogSkus} SKUs contados (${progressPct}%)`,
          ),
          h(
            'div',
            { class: 'sup-progress-track' },
            h('div', { class: 'sup-progress-fill', style: `width: ${progressPct}%;` }),
          ),
        ),
        h(
          'div',
          {
            class: 'sup-kpi-card clickable',
            onclick: () => {
              activeTab = 'feed';
              feedFilter = 'movements';
              void refreshDashboard();
            },
          },
          h('div', { class: 'sup-kpi-label' }, '🔄 Flujo Kardex (Entradas / Salidas)'),
          h(
            'div',
            { class: 'sup-kpi-value', style: 'display: flex; gap: 10px; align-items: baseline;' },
            h('span', { style: 'color: var(--success);' }, `+${fmtNum(totalInUnits)}`),
            h('span', { style: 'color: var(--danger);' }, `−${fmtNum(totalOutUnits)}`),
          ),
          h('div', { class: 'sup-kpi-sub' }, `${movements.length} movimiento(s) en bitácora`),
        ),
        h(
          'div',
          {
            class: 'sup-kpi-card clickable',
            onclick: () => {
              activeTab = 'matrix';
              matrixFilter = 'alerts';
              void refreshDashboard();
            },
          },
          h('div', { class: 'sup-kpi-label' }, '🚨 Alertas vs. Inventario Ideal'),
          h(
            'div',
            {
              class: 'sup-kpi-value',
              style: alertSkusCount > 0 ? 'color: var(--danger);' : 'color: var(--success);',
            },
            `${alertSkusCount} SKUs`,
          ),
          h(
            'div',
            { class: 'sup-kpi-sub' },
            `${criticalCount} críticos · ${deficitCount} en déficit`,
          ),
        ),
      );

      // 2. Renderizar barra de pestañas limpias del Supervisor
      const tabs: { id: SupervisorTab; label: string }[] = [
        { id: 'techs', label: `👨‍🔧 Técnicos en Vivo (${techList.length})` },
        { id: 'feed', label: `📡 Feed en Tiempo Real (${curCounts.length + movements.length})` },
        { id: 'matrix', label: `📊 Matriz de Avance por SKU (${reportLines.length})` },
        { id: 'sessions', label: `🗂️ Sesiones y Archivos (${sessions.length})` },
      ];

      clear(
        tabsBarWrap,
        tabs.map((t) =>
          h(
            'button',
            {
              class: `sup-tab-btn ${activeTab === t.id ? 'active' : ''}`,
              type: 'button',
              onclick: () => {
                activeTab = t.id;
                void refreshDashboard();
              },
            },
            t.label,
          ),
        ),
      );

      // 3. Renderizar contenido de la pestaña activa
      if (activeTab === 'techs') {
        renderTechsTab(techList, totalUnitsCounted, current);
      } else if (activeTab === 'feed') {
        renderLiveFeedTab(curCounts, movements, prodByBarcode, prodBySku);
      } else if (activeTab === 'matrix') {
        renderMatrixTab(reportLines, curCounts);
      } else {
        renderSessionsTab(sessions, current, curCounts, products, deviceId);
      }
    };

    const renderTechsTab = (
      techList: {
        name: string;
        scans: number;
        units: number;
        movementsCount: number;
        lastSeen: number;
        lastActionLabel: string;
        skusTouched: Set<string>;
      }[],
      totalUnits: number,
      current: Session | undefined,
    ) => {
      if (techList.length === 0) {
        clear(
          tabContentWrap,
          h(
            'section',
            { class: 'card', style: 'text-align: center; padding: 28px 16px;' },
            h('h3', { style: 'margin: 0 0 6px 0;' }, 'Aún no hay lecturas de técnicos en esta sala'),
            h(
              'p',
              { class: 'muted small', style: 'max-width: 480px; margin: 0 auto 14px auto;' },
              'Comparte el código QR de la sala con tu equipo o inicia el conteo. En cuanto el primer técnico escanee un producto o registre una entrada/salida, aparecerá su tarjeta aquí en tiempo real.',
            ),
            h(
              'div',
              { class: 'row wrap', style: 'justify-content: center; gap: 8px;' },
              s.syncRoomCode
                ? h(
                    'button',
                    {
                      class: 'btn primary',
                      type: 'button',
                      onclick: () => openRoomInviteQrDialog(s.syncRoomCode, s.syncEndpointUrl),
                    },
                    icon('scan'),
                    'Mostrar QR para conectar técnicos',
                  )
                : null,
              h(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  onclick: () => navigate('/contar'),
                },
                'Ir a Contar',
              ),
            ),
          ),
        );
        return;
      }

      const now = Date.now();
      clear(
        tabContentWrap,
        h(
          'div',
          { class: 'sup-tech-grid' },
          techList.map((t) => {
            const isOnline = now - t.lastSeen <= 3 * 60 * 1000;
            const sharePct = totalUnits > 0 ? Math.min(100, Math.round((Math.max(0, t.units) / totalUnits) * 100)) : 0;
            const initials = t.name
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
                    h('div', { class: 'muted small' }, `${t.skusTouched.size} SKU(s) distintos atendidos`),
                  ),
                ),
                h(
                  'span',
                  { class: `badge ${isOnline ? 'ok' : 'info'}` },
                  isOnline ? `🟢 Activo (${fmtRelativeAgo(t.lastSeen)})` : fmtRelativeAgo(t.lastSeen),
                ),
              ),
              h(
                'div',
                { class: 'sup-tech-metrics' },
                h(
                  'div',
                  { class: 'sup-tech-metric' },
                  h('span', { class: 'muted small' }, 'Escaneos'),
                  h('b', null, fmtNum(t.scans)),
                ),
                h(
                  'div',
                  { class: 'sup-tech-metric' },
                  h('span', { class: 'muted small' }, 'Unidades contadas'),
                  h('b', null, fmtNum(t.units)),
                ),
                h(
                  'div',
                  { class: 'sup-tech-metric' },
                  h('span', { class: 'muted small' }, 'Movs. Kardex'),
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
                h('span', { class: 'muted small' }, 'Última acción: '),
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
                    onclick: () => {
                      selectedTechFilter = t.name;
                      activeTab = 'feed';
                      void refreshDashboard();
                    },
                  },
                  'Ver su historial en vivo →',
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
                'Abrir Reporte Consolidado Completo',
              ),
            )
          : null,
      );
    };

    const renderLiveFeedTab = (
      counts: CountEntry[],
      movements: Movement[],
      prodByBarcode: Map<string, Product>,
      prodBySku: Map<string, Product>,
    ) => {
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

      const events: FeedEvent[] = [];
      if (feedFilter === 'all' || feedFilter === 'counts') {
        for (const c of counts) {
          const prod = prodByBarcode.get(c.barcode);
          events.push({
            id: `c_${c.id}`,
            timestamp: c.timestamp,
            kind: 'count',
            actor: c.counter || 'Técnico',
            sku: prod?.sku || c.barcode,
            description: prod?.description || 'Producto escaneado',
            qty: c.qty,
            unit: prod?.unit || 'PZA',
            extra: 'Conteo físico en piso',
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
            actor: m.technicianOrSupplier || 'Almacén',
            sku: m.sku,
            description: prod?.description || 'Movimiento de almacén',
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

      clear(
        tabContentWrap,
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
                  onclick: () => {
                    feedFilter = 'all';
                    void refreshDashboard();
                  },
                },
                'Todo el flujo en vivo',
              ),
              h(
                'button',
                {
                  class: `chip ${feedFilter === 'counts' ? 'active' : ''}`,
                  type: 'button',
                  onclick: () => {
                    feedFilter = 'counts';
                    void refreshDashboard();
                  },
                },
                '📦 Solo Conteos',
              ),
              h(
                'button',
                {
                  class: `chip ${feedFilter === 'movements' ? 'active' : ''}`,
                  type: 'button',
                  onclick: () => {
                    feedFilter = 'movements';
                    void refreshDashboard();
                  },
                },
                '🔄 Solo Entradas / Salidas',
              ),
            ),
            selectedTechFilter
              ? h(
                  'button',
                  {
                    class: 'chip active',
                    type: 'button',
                    onclick: () => {
                      selectedTechFilter = '';
                      void refreshDashboard();
                    },
                  },
                  `Filtrando: ${selectedTechFilter} ✕`,
                )
              : null,
          ),
          filteredEvents.length === 0
            ? h('div', { class: 'empty' }, 'No hay eventos registrados todavía para este filtro.')
            : h(
                'div',
                { class: 'sup-feed-list' },
                filteredEvents.map((ev) => {
                  const badgeCls =
                    ev.kind === 'count' ? 'badge info' : ev.kind === 'in' ? 'badge ok' : 'badge warn';
                  const badgeText =
                    ev.kind === 'count' ? '📦 CONTEO' : ev.kind === 'in' ? '⬇️ ENTRADA' : '⬆️ SALIDA';
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
    };

    const renderMatrixTab = (
      lines: ReportRow[],
      counts: CountEntry[],
    ) => {
      // Quién contó cada SKU
      const countersByBarcode = new Map<string, Set<string>>();
      for (const c of counts) {
        const set = countersByBarcode.get(c.barcode) ?? new Set<string>();
        set.add(c.counter || 'Técnico');
        countersByBarcode.set(c.barcode, set);
      }

      const searchInput = h('input', {
        class: 'input',
        type: 'search',
        placeholder: 'Buscar SKU, código de barras o descripción...',
        value: matrixSearch,
        oninput: (e: Event) => {
          matrixSearch = (e.target as HTMLInputElement).value;
          updateMatrixRows();
        },
      }) as HTMLInputElement;

      const tbody = h('tbody');

      const updateMatrixRows = () => {
        const q = matrixSearch.trim().toLowerCase();
        const filtered = lines.filter((l) => {
          if (q) {
            const match =
              l.sku.toLowerCase().includes(q) ||
              l.description.toLowerCase().includes(q) ||
              l.barcode.toLowerCase().includes(q);
            if (!match) return false;
          }
          if (matrixFilter === 'alerts') {
            return l.idealStatus === 'critical' || l.idealStatus === 'deficit' || Boolean(l.needsReorder);
          }
          if (matrixFilter === 'diff') {
            return (l.dynamicDiff ?? l.diff ?? 0) !== 0;
          }
          if (matrixFilter === 'counted') {
            return l.scans > 0;
          }
          if (matrixFilter === 'pending') {
            return l.scans === 0;
          }
          return true;
        });

        clear(
          tbody,
          filtered.slice(0, 200).map((l) => {
            const who = [...(countersByBarcode.get(l.barcode) ?? [])].join(', ') || '—';
            const diff = l.dynamicDiff ?? l.diff;
            let statusBadge = h('span', { class: 'badge ok' }, 'Óptimo');
            if (l.idealStatus === 'critical') {
              statusBadge = h('span', { class: 'badge error' }, 'Crítico');
            } else if (l.idealStatus === 'deficit') {
              statusBadge = h('span', { class: 'badge warn' }, 'Por pedir');
            } else if (l.idealStatus === 'excess') {
              statusBadge = h('span', { class: 'badge info' }, 'Exceso');
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
                l.scans > 0 ? fmtNum(l.counted) : h('span', { class: 'muted' }, 'Sin contar'),
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

      updateMatrixRows();

      clear(
        tabContentWrap,
        h(
          'section',
          { class: 'card' },
          h(
            'div',
            { style: 'display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;' },
            searchInput,
            h(
              'div',
              { class: 'chips' },
              h(
                'button',
                {
                  class: `chip ${matrixFilter === 'all' ? 'active' : ''}`,
                  type: 'button',
                  onclick: () => {
                    matrixFilter = 'all';
                    void refreshDashboard();
                  },
                },
                `Todos (${lines.length})`,
              ),
              h(
                'button',
                {
                  class: `chip ${matrixFilter === 'alerts' ? 'active' : ''}`,
                  type: 'button',
                  onclick: () => {
                    matrixFilter = 'alerts';
                    void refreshDashboard();
                  },
                },
                '🚨 Críticos / Por Pedir',
              ),
              h(
                'button',
                {
                  class: `chip ${matrixFilter === 'diff' ? 'active' : ''}`,
                  type: 'button',
                  onclick: () => {
                    matrixFilter = 'diff';
                    void refreshDashboard();
                  },
                },
                '⚖️ Con Diferencia',
              ),
              h(
                'button',
                {
                  class: `chip ${matrixFilter === 'counted' ? 'active' : ''}`,
                  type: 'button',
                  onclick: () => {
                    matrixFilter = 'counted';
                    void refreshDashboard();
                  },
                },
                '✅ Ya Contados',
              ),
              h(
                'button',
                {
                  class: `chip ${matrixFilter === 'pending' ? 'active' : ''}`,
                  type: 'button',
                  onclick: () => {
                    matrixFilter = 'pending';
                    void refreshDashboard();
                  },
                },
                '⏳ Pendientes de Contar',
              ),
            ),
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
                  h('th', null, 'Descripción'),
                  h('th', { style: 'text-align: right;' }, 'Esperado Dinámico'),
                  h('th', { style: 'text-align: right;' }, 'Contado Físico'),
                  h('th', { style: 'text-align: right;' }, 'Diferencia'),
                  h('th', { style: 'text-align: right;' }, 'Ideal'),
                  h('th', null, 'Contado por'),
                  h('th', { style: 'text-align: center;' }, 'Estado'),
                ),
              ),
              tbody,
            ),
          ),
        ),
      );
    };

    const renderSessionsTab = (
      sessions: Session[],
      current: Session | undefined,
      curCounts: CountEntry[],
      products: Product[],
      deviceId: string,
    ) => {
      const shareMyCount = async () => {
        if (!current) return;
        const file = buildCountFile(current, curCounts, products, deviceId);
        const name = `conteo_${safeFileName(current.name)}_${safeFileName(current.counter)}.json`;
        await shareOrDownload(JSON.stringify(file, null, 2), name, MIME.json, `Conteo de ${current.counter}`);
      };

      const importOthers = async () => {
        if (!current) {
          toast('Selecciona una sesión activa primero', 'warn');
          return;
        }
        const picked = await pickFiles(
          '.json,.xlsx,.xls,.csv,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          true,
        );
        if (!picked.length) return;
        const countFiles: CountFile[] = [];
        const errors: string[] = [];
        for (const f of picked) {
          try {
            const parsed = await parseTechnicianReportFile(f);
            countFiles.push(parsed);
          } catch (e) {
            errors.push((e as Error).message);
          }
        }
        if (errors.length) toast(errors.join('\n'), 'warn', 5000);
        if (!countFiles.length) return;

        const totalScans = countFiles.reduce((a, f) => a + f.counts.length, 0);
        const who = [...new Set(countFiles.map((f) => f.session.counter))].join(', ');
        const ok = await confirmDialog(
          'Consolidar conteos',
          `Se importarán ${totalScans} registros de ${countFiles.length} archivo(s) (${who}) en la sesión "${current.name}". Los registros ya existentes no se duplicarán.`,
          'Consolidar',
        );
        if (!ok) return;

        const res = await mergeCountFiles(current.id, countFiles);
        toast(
          `Listo: ${res.added} registros agregados (${res.duplicates} duplicados ignorados, ${res.productsAdded} productos nuevos)`,
          'ok',
          5000,
        );
        void refreshDashboard();
      };

      clear(
        tabContentWrap,
        current
          ? h(
              'section',
              { class: 'card' },
              h('div', { class: 'muted small' }, 'Herramientas de consolidación offline / por archivo'),
              h('h3', { style: 'margin: 2px 0 6px 0;' }, `Sesión Activa: ${current.name}`),
              h('div', { class: 'row wrap', style: 'gap: 8px;' },
                h(
                  'button',
                  {
                    class: 'btn primary',
                    onclick: () => void openUnifyReportsDialog((sid) => navigate(`/reporte?session=${sid}`)),
                  },
                  icon('users'),
                  'Unificar reportes de técnicos (Excel / CSV / JSON)',
                ),
                h('button', { class: 'btn', onclick: importOthers }, icon('upload'), 'Importar archivos a esta sesión'),
                h('button', { class: 'btn', onclick: shareMyCount, disabled: !curCounts.length }, icon('share'), 'Compartir mi conteo'),
                h(
                  'button',
                  {
                    class: 'btn',
                    disabled: !curCounts.length,
                    onclick: () => openShowMyQrDialog(current, curCounts),
                  },
                  icon('scan'),
                  '📱 Mostrar QR de mi conteo',
                ),
                h(
                  'button',
                  {
                    class: 'btn',
                    onclick: () => openReceiveQrDialog(current, () => void refreshDashboard()),
                  },
                  icon('scan'),
                  '📷 Recibir por QR',
                ),
              ),
            )
          : null,
        h(
          'section',
          { class: 'card' },
          h(
            'div',
            { class: 'card-head' },
            h('h3', null, 'Sesiones de inventario guardadas'),
            h(
              'button',
              {
                class: 'btn primary sm',
                onclick: async () => {
                  if (await newSessionFlow()) navigate('/contar');
                },
              },
              'Nueva sesión',
            ),
          ),
          h(
            'ul',
            { class: 'session-list' },
            sessions.length === 0 ? h('li', { class: 'empty' }, 'No hay sesiones registradas.') : null,
            sessions.map((sess) => {
              const isCur = current?.id === sess.id;
              const statusBadge = isCur
                ? h('span', { class: 'badge ok' }, 'Activa')
                : sess.closed
                  ? h('span', { class: 'badge info' }, 'Cerrada')
                  : h('span', { class: 'badge warn' }, 'Abierta');

              return h(
                'li',
                { class: `s-item ${isCur ? 'active' : ''}` },
                h(
                  'div',
                  {
                    class: 'grow',
                    onclick: async () => {
                      if (sess.closed) {
                        await reopenSession(sess.id);
                      } else {
                        await setActiveSession(sess.id);
                      }
                      toast(`Sesión activa: ${sess.name}`, 'ok');
                      void refreshDashboard();
                    },
                  },
                  h('div', { class: 's-name' }, sess.name, ' ', statusBadge),
                  h(
                    'div',
                    { class: 'muted small' },
                    `${sess.counter} · ${fmtDateTime(sess.createdAt)}`,
                    sess.closed && sess.closedAt ? ` · Cerrada ${fmtDateTime(sess.closedAt)}` : '',
                  ),
                ),
                h(
                  'div',
                  { class: 'row', style: 'gap: 6px; flex-shrink: 0;' },
                  h(
                    'button',
                    {
                      class: 'btn sm ghost',
                      title: 'Ver reporte',
                      onclick: (e: Event) => {
                        e.stopPropagation();
                        navigate(`/reporte?session=${sess.id}`);
                      },
                    },
                    icon('chart'),
                  ),
                  isCur
                    ? h(
                        'button',
                        {
                          class: 'btn sm danger ghost',
                          onclick: async (e: Event) => {
                            e.stopPropagation();
                            if (
                              await confirmDialog(
                                'Finalizar sesión',
                                `¿Deseas finalizar la sesión "${sess.name}"?`,
                                'Finalizar sesión',
                                true,
                              )
                            ) {
                              await closeSession(sess.id);
                              toast('Sesión finalizada con éxito', 'ok');
                              void refreshDashboard();
                            }
                          },
                        },
                        'Finalizar',
                      )
                    : sess.closed
                      ? h(
                          'button',
                          {
                            class: 'btn sm',
                            onclick: async (e: Event) => {
                              e.stopPropagation();
                              await reopenSession(sess.id);
                              toast(`Sesión reabierta: ${sess.name}`, 'ok');
                              void refreshDashboard();
                            },
                          },
                          'Reabrir',
                        )
                      : h(
                          'button',
                          {
                            class: 'btn sm',
                            onclick: async (e: Event) => {
                              e.stopPropagation();
                              await setActiveSession(sess.id);
                              toast(`Sesión activa: ${sess.name}`, 'ok');
                              void refreshDashboard();
                            },
                          },
                          'Activar',
                        ),
                  h(
                    'button',
                    {
                      class: 'btn ghost sm danger',
                      'aria-label': 'Eliminar sesión',
                      onclick: async (e: Event) => {
                        e.stopPropagation();
                        if (
                          await confirmDialog(
                            'Eliminar sesión',
                            `¿Eliminar "${sess.name}" y todos sus conteos?`,
                            'Eliminar',
                            true,
                          )
                        ) {
                          await deleteSession(sess.id);
                          if (isCur) await setActiveSession(null);
                          toast('Sesión eliminada');
                          void refreshDashboard();
                        }
                      },
                    },
                    icon('trash'),
                  ),
                ),
              );
            }),
          ),
        ),
      );
    };

    renderStatusHeader(getCloudConnectionStatus());
    renderConfigDrawer();
    await refreshDashboard();

    if (unsubscribeStatus) unsubscribeStatus();
    unsubscribeStatus = onCloudStatusChange((st) => {
      renderStatusHeader(st);
    });

    if (unsubscribeRoom) unsubscribeRoom();
    unsubscribeRoom = onCloudRoomUpdate(() => {
      void refreshDashboard();
    });

    if (relativeTimeTimer) clearInterval(relativeTimeTimer);
    relativeTimeTimer = setInterval(() => {
      const el = document.getElementById('sup-last-sync-ago');
      if (el) {
        const ts = Number(el.getAttribute('data-ts'));
        if (ts) el.textContent = `Actualizado: ${fmtRelativeAgo(ts)}`;
      }
    }, 5000);
  },

  destroy() {
    if (unsubscribeRoom) {
      unsubscribeRoom();
      unsubscribeRoom = null;
    }
    if (unsubscribeStatus) {
      unsubscribeStatus();
      unsubscribeStatus = null;
    }
    if (relativeTimeTimer) {
      clearInterval(relativeTimeTimer);
      relativeTimeTimer = null;
    }
  },
};
