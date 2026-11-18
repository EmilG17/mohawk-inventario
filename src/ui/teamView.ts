import { L } from '../i18n/i18n';
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
import { normalizeBarcode } from '../io/normalize';
import { buildReport, type ReportRow } from '../report';
import { loadSettings, saveSettings } from '../settings';
import {
  archiveSessionToCloud,
  buildRoomInviteUrl,
  canonicalCountId,
  checkRoomExistsInDb,
  decodeCompactCountQr,
  encodeCompactCountQrChunks,
  generateRoomCode,
  generateUniqueRoomCode,
  getCachedRoomState,
  getCloudConnectionStatus,
  listAvailableRoomsInDb,
  normalizeEndpointBaseUrl,
  normalizeRoomCode,
  onCloudRoomUpdate,
  onCloudStatusChange,
  startLiveCloudSync,
  syncNow,
  testFirebaseConnection,
  type CloudConnectionStatus,
  type LiveScannerState,
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
import { isMobileViewport, isSupervisorModeEnabled } from './catalogMode';
import { promptSupervisorPin, switchToSupervisorSession, switchToTechnicianSession } from './supervisorAuth';
import { newSessionFlow } from './home';
import { navigate, type View } from './router';
import { openUnifyReportsDialog } from './unifyReportsDialog';

type SupervisorTab = 'techs' | 'feed' | 'matrix' | 'sessions';
type FeedFilter = 'all' | 'counts' | 'movements';
type MatrixFilter = 'all' | 'alerts' | 'diff' | 'counted' | 'pending';

let activeTab: SupervisorTab = 'techs';
let userSelectedTab = false;
let feedFilter: FeedFilter = 'all';
let selectedTechFilter = '';
let matrixFilter: MatrixFilter = 'all';
let matrixSearch = '';
let configExpanded: boolean | null = null;

let unsubscribeRoom: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;
let relativeTimeTimer: ReturnType<typeof setInterval> | null = null;
let teamMounted = false;
let teamRenderSeq = 0;
let teamRoomTimer: ReturnType<typeof setTimeout> | null = null;

function fmtRelativeAgo(ts: number | null | undefined): string {
  if (!ts) return L('Sin actividad', 'No activity');
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 5) return L('Justo ahora', 'Just now');
  if (diffSec < 60) return L(`Hace ${diffSec} s`, `${diffSec}s ago`);
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return L(`Hace ${mins} min`, `${mins}m ago`);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return L(`Hace ${hrs} h`, `${hrs}h ago`);
  return fmtDateTime(ts);
}

function openRoomInviteQrDialog(roomCode: string, endpointUrl: string): void {
  let selectedRole: 'technician' | 'supervisor' = 'technician';

  const qrBox = h('div', {
    style:
      'display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 16px; background: #fff; border-radius: 12px; border: 1px solid var(--border); margin: 8px auto;',
  });

  const urlInput = h('input', {
    class: 'input sm',
    readonly: true,
    onclick: (e: Event) => (e.target as HTMLInputElement).select(),
  }) as HTMLInputElement;

  const roleDesc = h('p', { class: 'muted small', style: 'margin: 4px 0;' });

  const updateQrAndUrl = () => {
    const inviteUrl = buildRoomInviteUrl(roomCode, endpointUrl, selectedRole);
    const svg = renderQrCodeSvg(inviteUrl, 240, 2);
    qrBox.innerHTML = svg;
    urlInput.value = inviteUrl;
    if (selectedRole === 'technician') {
      roleDesc.textContent = L(
        'Modo Cliente-Técnico: Escaneo y consulta rápida de productos. Catálogo y cierre de sesión protegidos contra borrado accidental.',
        'Technician Client Mode: Fast scanning and item lookup. Master catalog and session closing protected against accidental changes.',
      );
    } else {
      roleDesc.textContent = L(
        'Modo Co-Supervisor: Acceso administrativo completo para gestionar catálogo, auditoría y exportaciones.',
        'Co-Supervisor Mode: Full administrative access to manage catalog, audit, and exports.',
      );
    }
  };

  const roleSelect = h('select', {
    class: 'input sm',
    style: 'font-weight: 600;',
    onchange: (e: Event) => {
      selectedRole = (e.target as HTMLSelectElement).value as 'technician' | 'supervisor';
      updateQrAndUrl();
    },
  },
    h('option', { value: 'technician', selected: true }, L('Cliente-Técnico (Escaneo protegido - Recomendado)', 'Client-Technician (Protected scanning - Recommended)')),
    h('option', { value: 'supervisor' }, L('Co-Supervisor (Acceso administrativo)', 'Co-Supervisor (Administrative access)')),
  );

  updateQrAndUrl();

  const copyBtn = h(
    'button',
    {
      class: 'btn primary sm',
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(urlInput.value);
          toast(L('Enlace de invitación copiado al portapapeles', 'Invite link copied to clipboard'), 'ok');
        } catch {
          urlInput.select();
          toast(L('Selecciona y copia el enlace', 'Select and copy the link'), 'info');
        }
      },
    },
    icon('copy'), L('Copiar enlace para WhatsApp', 'Copy link for WhatsApp'),
  );

  const body = h(
    'div',
    { class: 'form', style: 'text-align: center;' },
    h(
      'div',
      { class: 'badge ok', style: 'align-self: center;' },
      `${L('Sala en Vivo:', 'Live Room:')} ${roomCode}`,
    ),
    h('label', { class: 'field compact-field', style: 'margin: 6px 0; text-align: left;' },
      h('span', null, L('Tipo de acceso / Rol para este enlace:', 'Access type / Role for this link:')),
      roleSelect,
    ),
    roleDesc,
    qrBox,
    h('div', { class: 'row', style: 'gap: 6px;' }, urlInput, copyBtn),
  );

  openDialog(`${L('Invitar a Sala', 'Invite to Room')} ${roomCode}`, body, [{ label: L('Cerrar', 'Close') }]);
}

function openShowMyQrDialog(session: Session, counts: CountEntry[]): void {
  const chunks = encodeCompactCountQrChunks(session, counts, 25);
  let idx = 0;

  const qrBox = h('div', {
    style: 'display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px; background: #fff; border-radius: 12px; border: 1px solid var(--border);',
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
            'Anterior',
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
            'Siguiente',
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
  title: () => L('Monitor de Supervisor en Vivo', 'Live Supervisor Monitor'),
  async render(root) {
    teamMounted = true;
    const mountSeq = ++teamRenderSeq;
    let s = await loadSettings();
    if (!teamMounted || mountSeq !== teamRenderSeq) return;

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
    const noSessionBannerWrap = h('div');
    const tabsBarWrap = h('div', { class: 'sup-tabs-bar' });
    const tabContentWrap = h('div', { class: 'sup-tab-body' });

    clear(
      root,
      statusHeaderWrap,
      errorBannerWrap,
      configDrawerWrap,
      kpiGridWrap,
      noSessionBannerWrap,
      tabsBarWrap,
      tabContentWrap,
    );

    // Controles persistentes del cajón de configuración
    const roomDatalist = h('datalist', { id: 'team-rooms-datalist' });
    const roomStatusBadge = h('div', { class: 'small muted', style: 'margin-top: 4px; min-height: 18px;' });
    const roomsDiscoveryBox = h('div', { class: 'row wrap', style: 'gap: 4px; margin-top: 6px;', hidden: true });

    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    const verifyRoomStatus = () => {
      if (checkTimer) clearTimeout(checkTimer);
      checkTimer = setTimeout(async () => {
        const cleanRoom = normalizeRoomCode(roomInput.value);
        const cleanEndpoint = normalizeEndpointBaseUrl(endpointInput.value);
        if (!cleanRoom || !cleanEndpoint) {
          roomStatusBadge.textContent = '';
          return;
        }
        const res = await checkRoomExistsInDb(cleanEndpoint, cleanRoom);
        if (res.exists) {
          roomStatusBadge.className = 'small pos';
          roomStatusBadge.textContent = `✓ ${L('Sala existente en Firebase (te unirás a los conteos del equipo)', 'Existing room in Firebase (you will join team counts)')}`;
        } else {
          roomStatusBadge.className = 'small muted';
          roomStatusBadge.textContent = `• ${L('Nueva sala (se creará al sincronizar)', 'New room (will be created upon sync)')}`;
        }
      }, 350);
    };

    const loadAvailableRooms = async () => {
      const cleanEndpoint = normalizeEndpointBaseUrl(endpointInput.value);
      if (!cleanEndpoint) return;
      try {
        const rooms = await listAvailableRoomsInDb(cleanEndpoint);
        clear(roomDatalist);
        for (const r of rooms) {
          roomDatalist.appendChild(h('option', { value: r.roomCode }, r.sessionName || r.roomCode));
        }
        if (rooms.length > 0) {
          roomsDiscoveryBox.hidden = false;
          clear(roomsDiscoveryBox,
            h('span', { class: 'muted small', style: 'align-self: center; margin-right: 4px;' }, L('Salas activas en BD:', 'Active rooms in DB:')),
            ...rooms.slice(0, 6).map((r) =>
              h('button', {
                class: 'btn xs ghost',
                type: 'button',
                title: r.sessionName ? `${r.roomCode} - ${r.sessionName}` : r.roomCode,
                onclick: () => {
                  roomInput.value = r.roomCode;
                  verifyRoomStatus();
                },
              }, r.roomCode),
            ),
          );
        } else {
          roomsDiscoveryBox.hidden = true;
        }
      } catch {}
    };

    const roomInput = h('input', {
      class: 'input',
      value: s.syncRoomCode || 'MHK-2026',
      placeholder: 'Ej. MHK-2026',
      style: 'text-transform: uppercase; font-weight: 700;',
      list: 'team-rooms-datalist',
      oninput: verifyRoomStatus,
      onblur: () => {
        const clean = normalizeRoomCode(roomInput.value);
        if (clean) roomInput.value = clean;
        verifyRoomStatus();
      },
    }) as HTMLInputElement;

    const endpointInput = h('input', {
      class: 'input',
      value: s.syncEndpointUrl,
      placeholder: 'https://tu-proyecto-default-rtdb.firebaseio.com',
      onblur: () => {
        const clean = normalizeEndpointBaseUrl(endpointInput.value);
        if (clean) endpointInput.value = clean;
        void loadAvailableRooms();
        verifyRoomStatus();
      },
    }) as HTMLInputElement;

    void loadAvailableRooms();
    verifyRoomStatus();

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
      let pillLabel = L('● Sin sala activa', '● No active room');
      if (status.state === 'connected' && hasFirebase) {
        pillClass = 'sup-live-pill live';
        pillLabel = `● ${L('EN VIVO', 'LIVE')} · Firebase (${status.lastLatencyMs ?? 80} ms)`;
      } else if (status.state === 'connecting') {
        pillClass = 'sup-live-pill connecting';
        pillLabel = L('◌ Conectando con Firebase...', '◌ Connecting to Firebase...');
      } else if (status.state === 'error') {
        pillClass = 'sup-live-pill error';
        pillLabel = L('● Error de conexión Firebase', '● Firebase connection error');
      } else if (s.syncRoomCode) {
        pillClass = 'sup-live-pill local';
        pillLabel = L('● Sala Local (Mismo dispositivo / sin URL Firebase)', '● Local Room (Same device / no Firebase URL)');
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
              status.state === 'connected' ? h('span', { class: 'sup-radar-dot' }) : null,
              h('span', { class: pillClass }, pillLabel),
              s.syncRoomCode
                ? h('span', { class: 'badge info', style: 'font-weight: 800;' }, `${L('SALA:', 'ROOM:')} ${roomCode}`)
                : null,
              status.lastSyncedAt
                ? h(
                    'span',
                    { class: 'muted small', id: 'sup-last-sync-ago', 'data-ts': String(status.lastSyncedAt) },
                    `${L('Actualizado:', 'Updated:')} ${fmtRelativeAgo(status.lastSyncedAt)}`,
                  )
                : null,
            ),
            h(
              'h2',
              { style: 'margin: 4px 0 0 0; font-size: 18px; font-weight: 800; letter-spacing: -0.02em;' },
              isSupervisorModeEnabled()
                ? L('Centro de Gestión del Supervisor', 'Supervisor Management Center')
                : L('Terminal Cliente-Técnico', 'Technician Client Terminal'),
            ),
          ),
          h(
            'div',
            { class: 'sup-hero-actions' },
            isMobileViewport()
              ? h(
                  'button',
                  {
                    class: `btn sm ${isSupervisorModeEnabled() ? 'primary' : 'ghost'}`,
                    type: 'button',
                    'data-testid': 'team-supervisor-toggle',
                    onclick: async () => {
                      const isSup = isSupervisorModeEnabled();
                      if (!isSup) {
                        const ok = await promptSupervisorPin();
                        if (!ok) return;
                        await switchToSupervisorSession();
                      } else {
                        await switchToTechnicianSession();
                      }
                      s = await loadSettings();
                      renderStatusHeader(getCloudConnectionStatus());
                      await refreshDashboard();
                    },
                  },
                  icon('lock'),
                  isSupervisorModeEnabled() ? L('Bloquear (Modo Técnico)', 'Lock (Technician Mode)') : L('Acceso Supervisor (PIN)', 'Supervisor Access (PIN)'),
                )
              : null,
            s.syncRoomCode
              ? h(
                  'button',
                  {
                    class: 'btn sm',
                    type: 'button',
                    onclick: () => openRoomInviteQrDialog(s.syncRoomCode, s.syncEndpointUrl),
                  },
                  icon('scan'),
                  L('Invitar Técnicos (QR / Link)', 'Invite Technicians (QR / Link)'),
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
              L('Sincronizar ahora', 'Sync now'),
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
              configExpanded ? L('Ocultar configuración', 'Hide settings') : L('Configurar Firebase', 'Configure Firebase'),
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
            h('div', { style: 'font-weight: 700; margin-bottom: 4px;' }, 'Atención con el enlace de Firebase:'),
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
                    icon('copy'), 'Copiar Reglas para Firebase (.read / .write)',
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
            h('h3', { style: 'margin: 0;' }, L('Configuración de Sala y Enlace Firebase', 'Room & Firebase Link Configuration')),
          ),
          h(
            'div',
            { class: 'grid2', style: 'margin-top: 10px;' },
            h(
              'label',
              { class: 'field' },
              h('span', null, L('1. Código de Sala compartida', '1. Shared Room Code')),
              h(
                'div',
                { class: 'row', style: 'gap: 6px;' },
                roomInput,
                roomDatalist,
                h(
                  'button',
                  {
                    class: 'btn sm',
                    type: 'button',
                    onclick: async () => {
                      roomInput.value = await generateUniqueRoomCode(endpointInput.value, 'MHK');
                      verifyRoomStatus();
                    },
                  },
                  L('Generar única', 'Generate unique'),
                ),
              ),
              roomStatusBadge,
              roomsDiscoveryBox,
            ),
            h(
              'label',
              { class: 'field' },
              h('span', null, L('2. Enlace de Firebase Realtime Database', '2. Firebase Realtime Database URL')),
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
                  L('Probar', 'Test'),
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
              h('span', null, L('Sincronizar escaneos y movimientos en tiempo real', 'Sync scans and movements in real time')),
            ),
            h(
              'div',
              { class: 'row wrap', style: 'gap: 8px;' },
              normalizeRoomCode(roomInput.value) !== 'HHF-1114' || !endpointInput.value.includes('hhf-inventory')
                ? h(
                    'button',
                    {
                      class: 'btn sm',
                      type: 'button',
                      'data-testid': 'team-preset-hhf-btn',
                      onclick: () => {
                        roomInput.value = 'HHF-1114';
                        endpointInput.value = 'https://hhf-inventory-default-rtdb.firebaseio.com';
                        void connectAndSync();
                      },
                    },
                    L('Conectar HHF-1114', 'Connect HHF-1114'),
                  )
                : null,
              h(
                'button',
                { class: 'btn primary', type: 'button', onclick: connectAndSync },
                icon('globe'),
                L('Guardar y Conectar en Vivo', 'Save & Connect Live'),
              ),
            ),
          ),
        ),
      );
    };

    const refreshDashboard = async () => {
      if (!teamMounted) return;
      const seq = ++teamRenderSeq;
      const [sessions, current, deviceId, localProducts, localMovements, movSummaries, localIdealLevels] =
        await Promise.all([
          allSessions(),
          getActiveSession(),
          getDeviceId(),
          allProducts(),
          listMovements(),
          getMovementSummariesBySku(),
          getIdealLevels(),
        ]);
      if (!teamMounted || seq !== teamRenderSeq) return;

      const roomState = s.syncRoomCode ? getCachedRoomState(s.syncRoomCode) : null;
      const localCounts = current ? await countsForSession(current.id) : [];
      if (!teamMounted || seq !== teamRenderSeq) return;

      // Fusionar productos locales + productos en la nube (incluso si aún no hay sesión local)
      const prodTomb = roomState?.tombstones?.products || {};
      const prodMergedMap = new Map<string, Product>();
      for (const p of localProducts) {
        const tombTs = prodTomb[p.barcode];
        if (tombTs !== undefined && tombTs >= (p.updatedAt || 0)) continue;
        prodMergedMap.set(normalizeBarcode(p.barcode) || p.barcode, p);
      }
      for (const p of roomState?.products || []) {
        if (!p || !p.barcode) continue;
        const tombTs = prodTomb[p.barcode];
        if (tombTs !== undefined && tombTs >= (p.updatedAt || 0)) continue;
        const key = normalizeBarcode(p.barcode) || p.barcode;
        const prev = prodMergedMap.get(key);
        if (!prev || (p.updatedAt || 0) >= (prev.updatedAt || 0) || (prev.uncataloged && !p.uncataloged)) {
          prodMergedMap.set(key, p);
        }
      }
      const products = [...prodMergedMap.values()];

      // Fusionar conteos locales + conteos en vivo de la sala
      const countTomb = roomState?.tombstones?.counts || {};
      const countMergedMap = new Map<string, CountEntry>();
      for (const c of [...localCounts, ...(roomState?.counts || [])]) {
        if (!c || !c.id) continue;
        const cid = canonicalCountId(c.id);
        const tombTs = countTomb[cid];
        if (tombTs !== undefined && tombTs >= c.timestamp) continue;
        const prev = countMergedMap.get(cid);
        if (!prev || c.timestamp >= prev.timestamp) {
          countMergedMap.set(cid, c);
        }
      }
      const curCounts = [...countMergedMap.values()];

      // Fusionar movimientos locales + movimientos de la sala
      const movTomb = roomState?.tombstones?.movements || {};
      const movMergedMap = new Map<string, Movement>();
      for (const m of [...localMovements, ...(roomState?.movements || [])]) {
        if (!m || !m.id) continue;
        const tombTs = movTomb[m.id];
        if (tombTs !== undefined && tombTs >= m.timestamp) continue;
        const prev = movMergedMap.get(m.id);
        if (!prev || m.timestamp >= prev.timestamp) {
          movMergedMap.set(m.id, m);
        }
      }
      const movements = [...movMergedMap.values()];
      const idealLevels = { ...localIdealLevels, ...(roomState?.idealLevels || {}) };

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
        const normKey = normalizeBarcode(p.barcode);
        if (normKey) prodByBarcode.set(normKey, p);
        if (p.sku) prodBySku.set(p.sku.toUpperCase(), p);
      }

      const now = Date.now();
      const activeLiveScanners: LiveScannerState[] = Object.values(roomState?.liveScanners || {})
        .filter((sc) => sc && typeof sc.updatedAt === 'number' && now - sc.updatedAt <= 15 * 60 * 1000)
        .sort((a, b) => {
          const rank = (st: LiveScannerState['status']) =>
            st === 'pending_confirm' ? 0 : st === 'scanning' ? 1 : st === 'registered' ? 2 : 3;
          const dr = rank(a.status) - rank(b.status);
          return dr !== 0 ? dr : b.updatedAt - a.updatedAt;
        });

      // Agrupar actividad por técnico (conteos + movimientos de Kardex + telemetría en vivo)
      interface TechSummary {
        name: string;
        scans: number;
        units: number;
        movementsCount: number;
        lastSeen: number;
        lastActionLabel: string;
        skusTouched: Set<string>;
        liveScanner?: LiveScannerState;
      }
      const techMap = new Map<string, TechSummary>();

      const getOrInitTech = (name: string): TechSummary => {
        const existing = techMap.get(name);
        if (existing) return existing;
        const created: TechSummary = {
          name,
          scans: 0,
          units: 0,
          movementsCount: 0,
          lastSeen: 0,
          lastActionLabel: 'Conectado en sala',
          skusTouched: new Set<string>(),
        };
        techMap.set(name, created);
        return created;
      };

      const sortedCounts = [...curCounts].sort((a, b) => a.timestamp - b.timestamp);
      for (const c of sortedCounts) {
        const name = (c.counter || 'Técnico').trim();
        const prod = prodByBarcode.get(c.barcode) || prodByBarcode.get(normalizeBarcode(c.barcode));
        const skuLabel = prod?.sku || c.barcode;
        const descLabel = prod?.description || c.barcode;
        const cur = getOrInitTech(name);
        cur.scans += 1;
        cur.units += c.qty;
        cur.skusTouched.add(skuLabel);
        if (c.timestamp >= cur.lastSeen) {
          cur.lastSeen = c.timestamp;
          cur.lastActionLabel = `Contó ${c.qty >= 0 ? '+' : ''}${fmtNum(c.qty)} · ${skuLabel} (${descLabel})`;
        }
      }

      const sortedMovs = [...movements].sort((a, b) => a.timestamp - b.timestamp);
      for (const m of sortedMovs) {
        const name = (m.technicianOrSupplier || 'Almacén').trim();
        const prod = prodBySku.get(m.sku.toUpperCase());
        const descLabel = prod?.description || m.sku;
        const cur = getOrInitTech(name);
        cur.movementsCount += 1;
        cur.skusTouched.add(m.sku.toUpperCase());
        if (m.timestamp >= cur.lastSeen) {
          cur.lastSeen = m.timestamp;
          cur.lastActionLabel = `${m.type === 'IN' ? 'Entrada +' : 'Salida −'}${fmtNum(m.quantity)} · ${m.sku} (${descLabel})`;
        }
      }

      for (const p of Object.values(roomState?.participants || {})) {
        if (!p || !p.counter) continue;
        const cur = getOrInitTech(p.counter.trim());
        if (cur.scans === 0 && p.scans > 0) {
          cur.scans = p.scans;
          cur.units = p.units;
        }
        if (p.lastSku) cur.skusTouched.add(p.lastSku);
        if (p.lastSeen >= cur.lastSeen) {
          cur.lastSeen = p.lastSeen;
          if (cur.lastActionLabel === 'Conectado en sala' && p.lastSku) {
            cur.lastActionLabel = `Contó ${p.lastQty ?? 1} · ${p.lastSku}${p.lastDescription ? ` (${p.lastDescription})` : ''}`;
          }
        }
      }

      for (const sc of activeLiveScanners) {
        const cur = getOrInitTech((sc.counter || 'Técnico').trim());
        if (!cur.liveScanner || sc.updatedAt >= cur.liveScanner.updatedAt) {
          cur.liveScanner = sc;
        }
        if (sc.sku || sc.barcode) {
          cur.skusTouched.add(sc.sku || sc.barcode || '');
        }
        if (sc.updatedAt >= cur.lastSeen) {
          cur.lastSeen = sc.updatedAt;
          if (sc.status === 'pending_confirm' && (sc.sku || sc.barcode)) {
            cur.lastActionLabel = `Confirmando ${fmtNum(sc.qty ?? 1)} · ${sc.sku || sc.barcode}`;
          } else if (sc.status === 'scanning') {
            cur.lastActionLabel = 'Cámara encendida escaneando...';
          }
        }
      }

      const techList = [...techMap.values()].sort((a, b) => b.lastSeen - a.lastSeen);
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

      if (!isSupervisorModeEnabled()) {
        clear(kpiGridWrap);
        clear(tabsBarWrap);
        clear(tabContentWrap);
        clear(
          noSessionBannerWrap,
          h(
            'div',
            { class: 'card', style: 'padding: 24px; border-radius: 14px; margin-bottom: 16px; border: 1px solid var(--border); box-shadow: var(--shadow-sm);' },
            h(
              'div',
              { class: 'row wrap', style: 'align-items: center; justify-content: space-between; gap: 16px;' },
              h(
                'div',
                { style: 'max-width: 600px;' },
                h('div', { class: 'badge info', style: 'margin-bottom: 8px; font-weight: 700;' }, L('Modo Cliente-Técnico Activo', 'Client-Technician Mode Active')),
                h('h3', { style: 'margin: 0 0 6px 0; font-size: 20px; font-weight: 800;' }, L('Terminal de Conteo Protegido', 'Protected Counting Terminal')),
                h('p', { class: 'muted small', style: 'margin: 0 0 12px 0; line-height: 1.5;' },
                  L(
                    'Tu dispositivo está configurado como terminal de conteo operativo. Las lecturas se transmiten en tiempo real a la sala del supervisor. La sesión de supervisor y la administración de catálogo están separadas y protegidas con PIN.',
                    'Your device is configured as an operational counting terminal. Barcode scans are streamed in real-time to the supervisor room. The supervisor session and catalog administration are separated and protected with a PIN.',
                  ),
                ),
                h('div', { class: 'row wrap', style: 'gap: 8px;' },
                  h('span', { class: 'chip' }, `${L('Sala:', 'Room:')} ${s.syncRoomCode || 'Local'}`),
                  current ? h('span', { class: 'chip' }, `${L('Tu sesión:', 'Your session:')} ${current.name}`) : null,
                  h('span', { class: 'chip' }, `${curCounts.length} ${L('lecturas enviadas', 'scans sent')}`),
                ),
              ),
              h(
                'div',
                { class: 'col', style: 'gap: 8px; align-items: stretch; min-width: 200px;' },
                h(
                  'button',
                  {
                    class: 'btn primary',
                    style: 'min-height: 46px; font-weight: 700;',
                    onclick: () => navigate('/contar'),
                  },
                  icon('scan'),
                  L('Ir a Escanear / Contar', 'Go to Scan / Count'),
                ),
                isMobileViewport()
                  ? h(
                      'button',
                      {
                        class: 'btn ghost',
                        style: 'min-height: 40px;',
                        onclick: async () => {
                          const ok = await promptSupervisorPin();
                          if (ok) {
                            await switchToSupervisorSession();
                            s = await loadSettings();
                            renderStatusHeader(getCloudConnectionStatus());
                            await refreshDashboard();
                          }
                        },
                      },
                      icon('lock'),
                      L('Acceder como Supervisor (PIN)', 'Access as Supervisor (PIN)'),
                    )
                  : null,
              ),
            ),
          ),
        );
        return;
      }

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
          h('div', { class: 'sup-kpi-label' }, L('Técnicos Participantes', 'Participating Technicians')),
          h('div', { class: 'sup-kpi-value' }, `${techList.length}`),
          h(
            'div',
            { class: 'sup-kpi-sub' },
            activeNowCount > 0
              ? L(`● ${activeNowCount} activo(s) en los últimos 5 min`, `● ${activeNowCount} active in last 5 min`)
              : `${curCounts.length} ${L('lecturas acumuladas', 'total scans')}`,
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
          h('div', { class: 'sup-kpi-label' }, L('Avance de Conteo Físico', 'Physical Count Progress')),
          h('div', { class: 'sup-kpi-value' }, `${fmtNum(totalUnitsCounted)} u.`),
          h(
            'div',
            { class: 'sup-kpi-sub' },
            L(`${countedSkusCount} de ${totalCatalogSkus} SKUs contados (${progressPct}%)`, `${countedSkusCount} of ${totalCatalogSkus} SKUs counted (${progressPct}%)`),
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
          h('div', { class: 'sup-kpi-label' }, L('Flujo Kardex (Entradas / Salidas)', 'Kardex Flow (In / Out)')),
          h(
            'div',
            { class: 'sup-kpi-value', style: 'display: flex; gap: 10px; align-items: baseline;' },
            h('span', { style: 'color: var(--success);' }, `+${fmtNum(totalInUnits)}`),
            h('span', { style: 'color: var(--danger);' }, `−${fmtNum(totalOutUnits)}`),
          ),
          h('div', { class: 'sup-kpi-sub' }, `${movements.length} ${L('movimiento(s) en bitácora', 'movement(s) logged')}`),
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
          h('div', { class: 'sup-kpi-label' }, L('Alertas vs. Inventario Ideal', 'Alerts vs. Ideal Stock')),
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
            L(`${criticalCount} críticos · ${deficitCount} en déficit`, `${criticalCount} critical · ${deficitCount} deficit`),
          ),
        ),
      );

      const hasLiveRoomData =
        curCounts.length > 0 ||
        movements.length > 0 ||
        activeLiveScanners.length > 0 ||
        Object.keys(roomState?.participants || {}).length > 0;

      if (!userSelectedTab && !current && !hasLiveRoomData) {
        activeTab = 'sessions';
      } else if (!userSelectedTab && (current || hasLiveRoomData) && activeTab === 'sessions') {
        activeTab = 'techs';
      }

      // 2. Renderizar barra de pestañas limpias del Supervisor
      const tabs: { id: SupervisorTab; label: string }[] = [
        { id: 'techs', label: `${L('Técnicos en Vivo', 'Live Techs')} (${techList.length})` },
        { id: 'feed', label: `${L('Feed en Tiempo Real', 'Live Feed')} (${curCounts.length + movements.length})` },
        { id: 'matrix', label: `${L('Matriz de Avance por SKU', 'SKU Progress Matrix')} (${reportLines.length})` },
        { id: 'sessions', label: `${L('Sesiones y Archivos', 'Sessions & Files')} (${sessions.length})` },
      ];

      clear(
        noSessionBannerWrap,
        !current
          ? h(
              'div',
              {
                class: 'card',
                'data-testid': 'team-no-session-badge',
                style:
                  'width: 100%; margin: 0 0 14px 0; padding: 14px 18px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px;',
              },
              h(
                'div',
                null,
                h('h2', { style: 'margin: 0 0 2px 0; font-size: 16px;' }, L('Sin sesión activa', 'No active session')),
                h(
                  'div',
                  { class: 'muted small' },
                  roomState && (hasLiveRoomData || products.length > 0)
                    ? L(
                        `Monitoreando en vivo Sala ${roomState.roomCode} (${roomState.sessionName || 'Remota'}) · ${curCounts.length} lectura(s) · ${products.length} SKUs`,
                        `Monitoring live Room ${roomState.roomCode} (${roomState.sessionName || 'Remote'}) · ${curCounts.length} scan(s) · ${products.length} SKUs`,
                      )
                    : L('Inicia o reabre una sesión para activar el conteo de piso.', 'Start or reopen a session to enable floor counting.'),
                ),
              ),
              h(
                'button',
                {
                  class: 'btn primary sm',
                  type: 'button',
                  'data-testid': 'team-start-session-btn',
                  onclick: async () => {
                    if (await newSessionFlow()) navigate('/contar');
                  },
                },
                icon('scan'),
                L('Iniciar nueva sesión', 'Start new session'),
              ),
            )
          : null,
      );

      clear(
        tabsBarWrap,
        tabs.map((t) =>
          h(
            'button',
            {
              class: `sup-tab-btn ${activeTab === t.id ? 'active' : ''}`,
              type: 'button',
              'data-testid': `team-tab-${t.id}`,
              onclick: () => {
                userSelectedTab = true;
                activeTab = t.id;
                void refreshDashboard();
              },
            },
            t.label,
          ),
        ),
      );

      // 3. Renderizar contenido de la pestaña activa sin destruir foco si el usuario escribe (P3 anti-flicker)
      const focused = document.activeElement;
      if (focused && tabContentWrap.contains(focused) && focused.tagName === 'INPUT') {
        return;
      }

      if (activeTab === 'techs') {
        renderTechsTab(techList, totalUnitsCounted, current, activeLiveScanners, prodByBarcode, prodBySku);
      } else if (activeTab === 'feed') {
        renderLiveFeedTab(curCounts, movements, prodByBarcode, prodBySku, activeLiveScanners);
      } else if (activeTab === 'matrix') {
        renderMatrixTab(reportLines, curCounts);
      } else {
        renderSessionsTab(sessions, current, curCounts, products, deviceId);
      }
    };

    const renderLiveScannersStrip = (
      scanners: LiveScannerState[],
      prodByBarcode: Map<string, Product>,
      prodBySku: Map<string, Product>,
    ): HTMLElement | null => {
      if (scanners.length === 0 && !s.syncRoomCode) return null;
      const statusMeta = (st: LiveScannerState['status']) => {
        if (st === 'pending_confirm') return { label: 'Confirmando cantidad', cls: 'badge warn' };
        if (st === 'scanning') return { label: 'Cámara buscando código', cls: 'badge info' };
        if (st === 'registered') return { label: 'Recién registrado', cls: 'badge ok' };
        return { label: 'Escáner en pausa', cls: 'badge' };
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
            h('h3', { style: 'margin: 0; font-size: 15px;' }, 'Escáneres en Vivo'),
            h(
              'div',
              { class: 'muted small' },
              scanners.length > 0
                ? `${scanners.length} terminal(es) reportando actividad de escáner en tiempo real`
                : `Sala ${s.syncRoomCode} lista · cuando un técnico encienda cámara o escanee aparecerá aquí al instante`,
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
                const originIcon = sc.origin === 'camara' ? 'Cámara' : sc.origin === 'teclado' ? 'USB/BT' : sc.origin === 'manual' ? 'Manual' : '';
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
                      : h('span', { class: 'muted small' }, 'Esperando lectura de código...'),
                    typeof sc.qty === 'number'
                      ? h('span', { class: 'badge ok', style: 'font-weight: 800;' }, `Cant: ${fmtNum(sc.qty)}`)
                      : null,
                    h('span', { class: 'muted small' }, fmtRelativeAgo(sc.updatedAt)),
                  ),
                );
              }),
            )
          : null,
      );
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
        liveScanner?: LiveScannerState;
      }[],
      totalUnits: number,
      current: Session | undefined,
      activeLiveScanners: LiveScannerState[],
      prodByBarcode: Map<string, Product>,
      prodBySku: Map<string, Product>,
    ) => {
      const liveStrip = renderLiveScannersStrip(activeLiveScanners, prodByBarcode, prodBySku);
      if (techList.length === 0) {
        clear(
          tabContentWrap,
          liveStrip,
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

      const nowMs = Date.now();
      clear(
        tabContentWrap,
        liveStrip,
        h(
          'div',
          { class: 'sup-tech-grid' },
          techList.map((t) => {
            const isOnline = nowMs - t.lastSeen <= 3 * 60 * 1000;
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
                    onclick: () => {
                      selectedTechFilter = t.name;
                      activeTab = 'feed';
                      void refreshDashboard();
                    },
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
    };

    const renderLiveFeedTab = (
      counts: CountEntry[],
      movements: Movement[],
      prodByBarcode: Map<string, Product>,
      prodBySku: Map<string, Product>,
      activeLiveScanners: LiveScannerState[] = [],
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

      const liveStrip = renderLiveScannersStrip(activeLiveScanners, prodByBarcode, prodBySku);

      clear(
        tabContentWrap,
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
                'Solo Conteos',
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
                'Solo Entradas / Salidas',
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
                    ev.kind === 'count' ? 'CONTEO' : ev.kind === 'in' ? 'ENTRADA' : 'SALIDA';
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
                'Críticos / Por Pedir',
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
                'Con Diferencia',
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
                'Ya Contados',
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
                'Pendientes de Contar',
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
              h('div', { class: 'toolbar-compact-row' },
                h('h3', { style: 'margin: 0;' }, `Sesión Activa: ${current.name}`),
                h(
                  'button',
                  {
                    class: 'btn primary sm',
                    onclick: () => void openUnifyReportsDialog((sid) => navigate(`/reporte?session=${sid}`)),
                  },
                  icon('users'),
                  'Unificar reportes de técnicos (Excel / CSV / JSON)',
                ),
              ),
              h('details', { class: 'ui-disclosure' },
                h('summary', { class: 'ui-disclosure-summary' }, 'Herramientas de archivo y transferencia QR'),
                h('div', { class: 'ui-disclosure-body' },
                  h('div', { class: 'row wrap', style: 'gap: 8px;' },
                    h('button', { class: 'btn sm', onclick: importOthers }, icon('upload'), 'Importar archivos a esta sesión'),
                    h('button', { class: 'btn sm', onclick: shareMyCount, disabled: !curCounts.length }, icon('share'), 'Compartir mi conteo'),
                    h(
                      'button',
                      {
                        class: 'btn sm',
                        disabled: !curCounts.length,
                        onclick: () => openShowMyQrDialog(current, curCounts),
                      },
                      icon('scan'),
                      'Mostrar QR de mi conteo',
                    ),
                    h(
                      'button',
                      {
                        class: 'btn sm',
                        onclick: () => openReceiveQrDialog(current, () => void refreshDashboard()),
                      },
                      icon('scan'),
                      'Recibir por QR',
                    ),
                  ),
                ),
              ),
            )
          : null,
        h(
          'section',
          { class: 'card' },
          h(
                'div',
                {
                  class: 'card-head',
                },
                h('h3', null, L('Sesiones de inventario guardadas', 'Saved Inventory Sessions')),
                h(
                  'button',
                  {
                    class: 'btn primary sm',
                    onclick: async () => {
                      if (await newSessionFlow()) navigate('/contar');
                    },
                  },
                  L('Nueva sesión', 'New session'),
                ),
              ),
              h(
                'ul',
                { class: 'session-list' },
                sessions.length === 0 ? h('li', { class: 'empty' }, L('No hay sesiones registradas.', 'No sessions recorded.')) : null,
                sessions.map((sess) => {
                  const isCur = current?.id === sess.id;
                  const statusBadge = isCur
                    ? h('span', { class: 'badge ok' }, L('Activa', 'Active'))
                    : sess.closed
                      ? h('span', { class: 'badge info' }, L('Cerrada', 'Closed'))
                      : h('span', { class: 'badge warn' }, L('Abierta', 'Open'));

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
                              void archiveSessionToCloud(sess.id).catch(() => {});
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

    if (!teamMounted) return;
    if (unsubscribeStatus) unsubscribeStatus();
    unsubscribeStatus = onCloudStatusChange((st) => {
      if (teamMounted) renderStatusHeader(st);
    });

    if (unsubscribeRoom) unsubscribeRoom();
    if (teamRoomTimer) {
      clearTimeout(teamRoomTimer);
      teamRoomTimer = null;
    }
    unsubscribeRoom = onCloudRoomUpdate(() => {
      if (!teamMounted) return;
      if (teamRoomTimer) clearTimeout(teamRoomTimer);
      teamRoomTimer = setTimeout(() => {
        teamRoomTimer = null;
        if (teamMounted) void refreshDashboard();
      }, 80);
    });

    if (relativeTimeTimer) clearInterval(relativeTimeTimer);
    relativeTimeTimer = setInterval(() => {
      if (!teamMounted) return;
      const el = document.getElementById('sup-last-sync-ago');
      if (el) {
        const ts = Number(el.getAttribute('data-ts'));
        if (ts) el.textContent = `Actualizado: ${fmtRelativeAgo(ts)}`;
      }
    }, 5000);
  },

  destroy() {
    teamMounted = false;
    teamRenderSeq++;
    userSelectedTab = false;
    if (teamRoomTimer) {
      clearTimeout(teamRoomTimer);
      teamRoomTimer = null;
    }
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
