import { L } from '../../i18n/i18n';
import { loadSettings, saveSettings, type Settings } from '../../settings';
import {
  checkRoomExistsInDb,
  generateRoomCode,
  generateUniqueRoomCode,
  getCloudConnectionStatus,
  listAvailableRoomsInDb,
  normalizeEndpointBaseUrl,
  normalizeRoomCode,
  startLiveCloudSync,
  syncNow,
  testFirebaseConnection,
  type CloudConnectionStatus,
} from '../../sync/cloudSync';
import { isMobileViewport, isSupervisorModeEnabled } from '../catalogMode';
import { clear, h, icon, toast } from '../dom';
import { promptSupervisorPin, switchToSupervisorSession, switchToTechnicianSession } from '../supervisorAuth';
import { openRoomInviteQrDialog } from './teamQrDialogs';
import { fmtRelativeAgo } from './teamTypes';

export interface TeamConfigController {
  isConfigExpanded(): boolean;
  renderStatusHeader(status: CloudConnectionStatus): void;
  renderConfigDrawer(): void;
  updateSettings(next: Settings): void;
  destroy(): void;
}

export function createTeamConfigController(opts: {
  initialSettings: Settings;
  statusHeaderWrap: HTMLElement;
  errorBannerWrap: HTMLElement;
  configDrawerWrap: HTMLElement;
  initialExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onAfterSyncOrRoleChange: (nextSettings: Settings) => Promise<void>;
}): TeamConfigController {
  let s = opts.initialSettings;
  let configExpanded = opts.initialExpanded;
  let destroyed = false;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;

  const roomDatalist = h('datalist', { id: 'team-rooms-datalist' });
  const roomStatusBadge = h('div', { class: 'small muted', style: 'margin-top: 4px; min-height: 18px;' });
  const roomsDiscoveryBox = h('div', { class: 'row wrap', style: 'gap: 4px; margin-top: 6px;', hidden: true });

  const verifyRoomStatus = () => {
    if (checkTimer) clearTimeout(checkTimer);
    if (destroyed || !isSupervisorModeEnabled()) return;
    checkTimer = setTimeout(async () => {
      checkTimer = null;
      if (destroyed || !isSupervisorModeEnabled()) return;
      const cleanRoom = normalizeRoomCode(roomInput.value);
      const cleanEndpoint = normalizeEndpointBaseUrl(endpointInput.value);
      if (!cleanRoom || !cleanEndpoint) {
        roomStatusBadge.textContent = '';
        return;
      }
      const res = await checkRoomExistsInDb(cleanEndpoint, cleanRoom);
      if (destroyed) return;
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
    if (destroyed || !isSupervisorModeEnabled()) return;
    const cleanEndpoint = normalizeEndpointBaseUrl(endpointInput.value);
    if (!cleanEndpoint) return;
    try {
      const rooms = await listAvailableRoomsInDb(cleanEndpoint);
      if (destroyed || !isSupervisorModeEnabled()) return;
      clear(roomDatalist);
      for (const r of rooms) {
        roomDatalist.appendChild(h('option', { value: r.roomCode }, r.sessionName || r.roomCode));
      }
      if (rooms.length > 0) {
        roomsDiscoveryBox.hidden = false;
        clear(
          roomsDiscoveryBox,
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

  if (isSupervisorModeEnabled()) {
    void loadAvailableRooms();
    verifyRoomStatus();
  }

  const autoCheck = h('input', {
    type: 'checkbox',
    checked: s.syncAuto,
    onchange: async (e: Event) => {
      await saveSettings({ syncAuto: (e.target as HTMLInputElement).checked, syncEnabled: true });
    },
  }) as HTMLInputElement;

  const diagBox = h('div', { class: 'sup-diag-box', hidden: true });

  const connectAndSync = async () => {
    if (!isSupervisorModeEnabled()) {
      const code = normalizeRoomCode(s.syncRoomCode);
      if (!code) {
        toast(L('Solicita al supervisor el código de sala o QR para conectarte.', 'Ask the supervisor for the room code or QR to connect.'), 'info');
        return;
      }
      try {
        const res = await syncNow({ roomCode: code, endpointUrl: normalizeEndpointBaseUrl(s.syncEndpointUrl) });
        toast(
          L(`Sala ${res.roomCode} sincronizada (${res.totalRoomCounts} lecturas)`, `Room ${res.roomCode} synced (${res.totalRoomCounts} scans)`),
          'ok',
          3000,
        );
      } catch (err) {
        toast((err as Error).message || L('Error al sincronizar sala', 'Error syncing room'), 'error');
      }
      await opts.onAfterSyncOrRoleChange(s);
      return;
    }

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
        opts.onExpandedChange(false);
        toast(
          L(
            `Conectado en vivo a Firebase · Sala ${res.roomCode} (${res.totalRoomCounts} lecturas, ${res.participants.length} técnico(s))`,
            `Connected live to Firebase · Room ${res.roomCode} (${res.totalRoomCounts} scans, ${res.participants.length} tech(s))`,
          ),
          'ok',
          4000,
        );
      } else {
        toast(L(`Sala ${res.roomCode} sincronizada en modo local`, `Room ${res.roomCode} synced locally`), 'info', 3500);
      }
    } catch (err) {
      toast((err as Error).message || L('Error al sincronizar sala', 'Error syncing room'), 'error');
    }
    await opts.onAfterSyncOrRoleChange(s);
  };

  const runFirebaseTest = async () => {
    const code = normalizeRoomCode(roomInput.value) || 'MHK-TEST';
    const cleanEndpoint = normalizeEndpointBaseUrl(endpointInput.value);
    endpointInput.value = cleanEndpoint;
    diagBox.hidden = false;
    diagBox.className = 'sup-diag-box info';
    diagBox.textContent = L('Probando conexión con Firebase Realtime Database...', 'Testing Firebase Realtime Database connection...');
    const res = await testFirebaseConnection(cleanEndpoint, code);
    if (destroyed) return;
    diagBox.className = `sup-diag-box ${res.ok ? 'ok' : 'error'}`;
    diagBox.textContent = res.message;
  };

  const renderConfigDrawer = () => {
    if (!isSupervisorModeEnabled() || !configExpanded) {
      clear(opts.configDrawerWrap);
      return;
    }

    clear(
      opts.configDrawerWrap,
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

  const renderStatusHeader = (status: CloudConnectionStatus) => {
    const supervisorUI = isSupervisorModeEnabled();
    const hasFirebase = Boolean(s.syncEndpointUrl || status.endpointUrl);
    const roomCode = status.roomCode || s.syncRoomCode || L('SIN-SALA', 'NO-ROOM');

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
      opts.statusHeaderWrap,
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
            supervisorUI
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
                  class: `btn sm ${supervisorUI ? 'primary' : 'ghost'}`,
                  type: 'button',
                  'data-testid': 'team-supervisor-toggle',
                  onclick: async () => {
                    if (!isSupervisorModeEnabled()) {
                      const ok = await promptSupervisorPin();
                      if (!ok) return;
                      await switchToSupervisorSession();
                      s = await loadSettings();
                      if (!s.syncRoomCode || !s.syncEndpointUrl) {
                        configExpanded = true;
                        opts.onExpandedChange(true);
                      }
                      void loadAvailableRooms();
                      verifyRoomStatus();
                    } else {
                      await switchToTechnicianSession();
                      s = await loadSettings();
                    }
                    renderStatusHeader(getCloudConnectionStatus());
                    renderConfigDrawer();
                    await opts.onAfterSyncOrRoleChange(s);
                  },
                },
                icon('lock'),
                supervisorUI ? L('Bloquear (Modo Técnico)', 'Lock (Technician Mode)') : L('Acceso Supervisor (PIN)', 'Supervisor Access (PIN)'),
              )
            : null,
          supervisorUI && s.syncRoomCode
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
          supervisorUI || s.syncRoomCode
            ? h(
                'button',
                {
                  class: 'btn sm primary',
                  type: 'button',
                  onclick: connectAndSync,
                },
                icon('globe'),
                L('Sincronizar ahora', 'Sync now'),
              )
            : null,
          supervisorUI
            ? h(
                'button',
                {
                  class: `btn sm ${configExpanded ? 'active' : 'ghost'}`,
                  type: 'button',
                  'data-testid': 'team-config-toggle-btn',
                  onclick: () => {
                    configExpanded = !configExpanded;
                    opts.onExpandedChange(configExpanded);
                    renderConfigDrawer();
                    renderStatusHeader(getCloudConnectionStatus());
                  },
                },
                icon('gear'),
                configExpanded ? L('Ocultar configuración', 'Hide settings') : L('Configurar Firebase', 'Configure Firebase'),
              )
            : null,
        ),
      ),
    );

    if (status.lastError && supervisorUI) {
      clear(
        opts.errorBannerWrap,
        h(
          'div',
          { class: 'card sup-error-banner' },
          h('div', { style: 'font-weight: 700; margin-bottom: 4px;' }, L('Atención con el enlace de Firebase:', 'Firebase link notice:')),
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
                        toast(
                          L(
                            'Reglas JSON copiadas. Pégalas en Firebase → Realtime Database → Reglas',
                            'JSON rules copied. Paste them into Firebase → Realtime Database → Rules',
                          ),
                          'ok',
                          4500,
                        );
                      } catch {}
                    },
                  },
                  icon('copy'), L('Copiar Reglas para Firebase (.read / .write)', 'Copy Firebase Rules (.read / .write)'),
                ),
              )
            : null,
        ),
      );
    } else if (status.lastError && !supervisorUI) {
      clear(
        opts.errorBannerWrap,
        h(
          'div',
          { class: 'card sup-error-banner' },
          h('div', { style: 'font-weight: 700;' }, L('Sin conexión temporal con la sala', 'Temporary connection issue with the room')),
          h('div', { class: 'small muted' }, L('Tus escaneos se siguen guardando en este teléfono y se enviarán al restablecer la red.', 'Your scans stay saved on this device and will sync when network recovers.')),
        ),
      );
    } else {
      clear(opts.errorBannerWrap);
    }
  };

  return {
    isConfigExpanded: () => configExpanded,
    renderStatusHeader,
    renderConfigDrawer,
    updateSettings: (next: Settings) => {
      s = next;
    },
    destroy: () => {
      destroyed = true;
      if (checkTimer) {
        clearTimeout(checkTimer);
        checkTimer = null;
      }
    },
  };
}
