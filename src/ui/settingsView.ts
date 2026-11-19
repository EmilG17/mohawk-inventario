import { allProducts, clearProducts, getDB } from '../db/db';
import { L, detectDeviceLang, type LangPref } from '../i18n/i18n';
import { buildCatalogFile, buildCatalogWorkbook } from '../io/exportResults';
import { reconcileCatalogProducts } from '../io/mergeCounts';
import { loadSampleCatalog } from '../sampleData';
import { _resetSettingsCache, loadSettings, saveSettings } from '../settings';
import {
  checkRoomExistsInDb,
  getCloudConnectionStatus,
  listAvailableRoomsInDb,
  normalizeEndpointBaseUrl,
  normalizeRoomCode,
  onCloudStatusChange,
  startLiveCloudSync,
  stopLiveCloudSync,
  syncCatalogWithDb,
  syncNow,
  testFirebaseConnection,
  triggerBackgroundSync,
} from '../sync/cloudSync';
import { clearLocalStorageRoomMirrors } from '../sync/roomMirror';
import { notifyLanguageChanged } from './app';
import { importCatalogFlow } from './catalog';
import {
  isMobileCatalogReadOnly,
  isMobileViewport,
  isStrictTechnicianClient,
  isSupervisorModeEnabled,
} from './catalogMode';
import {
  clearMobilePinSession,
  getSupervisorPin,
  isValidSupervisorPin,
  promptSupervisorPin,
  switchToSupervisorSession,
  switchToTechnicianSession,
} from './supervisorAuth';
import {
  clear, confirmDialog, downloadFile, fmtNum, h, icon, MIME, shareOrDownload, toast,
} from './dom';
import { navigate, type View } from './router';

let settingsMounted = false;
let settingsRenderSeq = 0;
let settingsCheckTimer: ReturnType<typeof setTimeout> | null = null;
let unsubSettingsCloud: (() => void) | null = null;

function cleanupSettingsResources(): void {
  if (settingsCheckTimer) {
    clearTimeout(settingsCheckTimer);
    settingsCheckTimer = null;
  }
  if (unsubSettingsCloud) {
    unsubSettingsCloud();
    unsubSettingsCloud = null;
  }
}

export const settingsView: View = {
  title: () => L('Ajustes', 'Settings'),
  async render(root, params) {
    cleanupSettingsResources();
    settingsMounted = true;
    const seq = ++settingsRenderSeq;
    const readOnlyMobile = isMobileCatalogReadOnly();
    const mobileViewport = isMobileViewport();
    const supervisorUI = isSupervisorModeEnabled();
    const strictTech = isStrictTechnicianClient();
    const [s, products] = await Promise.all([loadSettings(), allProducts()]);
    if (!settingsMounted || seq !== settingsRenderSeq) return;
    const totalProds = products.length;
    const uncatalogedCount = products.filter((p) => p.uncataloged).length;
    const officialCount = totalProds - uncatalogedCount;

    const nameInput = h('input', {
      class: 'input input-sm',
      value: s.counterName,
      placeholder: L('Ej. Juan Pérez', 'e.g. Jane Doe'),
    }) as HTMLInputElement;
    const currInput = h('input', {
      class: 'input input-sm',
      value: s.currency,
      maxlength: 5,
      placeholder: 'MXN',
    }) as HTMLInputElement;
    const deviceLangName = detectDeviceLang() === 'en' ? 'English' : 'Español';
    const langSelect = h('select', {
      class: 'input input-sm',
      'data-testid': 'settings-language-select',
    },
    h('option', { value: 'auto', selected: (s.language ?? 'auto') === 'auto' }, L(`Automático (${deviceLangName})`, `Automatic (${deviceLangName})`)),
    h('option', { value: 'es', selected: s.language === 'es' }, 'Español'),
    h('option', { value: 'en', selected: s.language === 'en' }, 'English'),
    ) as HTMLSelectElement;

    const beepCheck = h('input', { type: 'checkbox', checked: s.beep }) as HTMLInputElement;
    const vibCheck = h('input', { type: 'checkbox', checked: s.vibrate }) as HTMLInputElement;
    const quickCheck = h('input', { type: 'checkbox', checked: s.quickMode }) as HTMLInputElement;
    const showExpCheck = h('input', { type: 'checkbox', checked: s.showExpected }) as HTMLInputElement;
    const lookupCheck = h('input', { type: 'checkbox', checked: s.onlineLookup }) as HTMLInputElement;
    const proxyInput = h('input', {
      class: 'input input-sm',
      value: s.proxyUrl,
      placeholder: 'api/upc',
    }) as HTMLInputElement;

    const syncEnabledCheck = h('input', { type: 'checkbox', checked: s.syncEnabled, disabled: strictTech }) as HTMLInputElement;
    const syncAutoCheck = h('input', { type: 'checkbox', checked: s.syncAuto, disabled: strictTech }) as HTMLInputElement;
    const supervisorCheck = h('input', {
      type: 'checkbox',
      checked: supervisorUI,
      'data-testid': 'settings-supervisor-mode-toggle',
    }) as HTMLInputElement;

    const roleSelect = h('select', {
      class: 'input input-sm',
      'data-testid': 'settings-role-select',
    },
      h('option', { value: 'supervisor', selected: supervisorUI }, L('Supervisor (Centro de Gestión)', 'Supervisor (Control Hub)')),
      h('option', { value: 'technician', selected: !supervisorUI }, L('Cliente-Técnico (Terminal)', 'Technician (Terminal)')),
    ) as HTMLSelectElement;

    const pinInput = h('input', {
      class: 'input input-sm',
      type: 'password',
      maxlength: 4,
      pattern: '[0-9]*',
      inputmode: 'numeric',
      value: s.supervisorPin || '1234',
      placeholder: '****',
    }) as HTMLInputElement;

    const roomDatalist = h('datalist', { id: 'settings-rooms-datalist' });
    const roomStatusBadge = h('div', { class: 'small muted', style: 'margin-top: 4px; min-height: 18px;' });

    const verifyRoomStatus = () => {
      if (settingsCheckTimer) clearTimeout(settingsCheckTimer);
      if (strictTech) return;
      settingsCheckTimer = setTimeout(async () => {
        settingsCheckTimer = null;
        if (!settingsMounted || seq !== settingsRenderSeq) return;
        const cleanRoom = normalizeRoomCode(syncRoomInput.value);
        const cleanEndpoint = normalizeEndpointBaseUrl(syncEndpointInput.value);
        if (!cleanRoom || !cleanEndpoint) {
          roomStatusBadge.textContent = '';
          return;
        }
        const res = await checkRoomExistsInDb(cleanEndpoint, cleanRoom);
        if (!settingsMounted || seq !== settingsRenderSeq) return;
        if (res.exists) {
          roomStatusBadge.className = 'small pos';
          roomStatusBadge.textContent = `✓ ${L('Sala existente en Firebase', 'Existing room in Firebase')}`;
        } else {
          roomStatusBadge.className = 'small muted';
          roomStatusBadge.textContent = `• ${L('Nueva sala (se creará al sincronizar)', 'New room (will be created upon sync)')}`;
        }
      }, 350);
    };

    const loadAvailableRooms = async () => {
      if (strictTech) return;
      const cleanEndpoint = normalizeEndpointBaseUrl(syncEndpointInput.value);
      if (!cleanEndpoint) return;
      try {
        const rooms = await listAvailableRoomsInDb(cleanEndpoint);
        if (!settingsMounted || seq !== settingsRenderSeq) return;
        clear(roomDatalist);
        for (const r of rooms) {
          roomDatalist.appendChild(h('option', { value: r.roomCode }, r.sessionName || r.roomCode));
        }
      } catch {}
    };

    const syncRoomInput = h('input', {
      class: 'input input-sm',
      value: s.syncRoomCode,
      placeholder: L('Ej. MHK-PLANTA-1', 'e.g. MHK-PLANT-1'),
      list: 'settings-rooms-datalist',
      style: 'text-transform: uppercase;',
      disabled: strictTech,
      oninput: verifyRoomStatus,
      onblur: () => {
        const clean = normalizeRoomCode(syncRoomInput.value);
        if (clean) syncRoomInput.value = clean;
        verifyRoomStatus();
      },
    }) as HTMLInputElement;

    const syncEndpointInput = h('input', {
      class: 'input input-sm',
      value: s.syncEndpointUrl,
      placeholder: 'https://tu-proyecto-default-rtdb.firebaseio.com',
      disabled: strictTech,
      onblur: () => {
        const clean = normalizeEndpointBaseUrl(syncEndpointInput.value);
        if (clean) syncEndpointInput.value = clean;
        void loadAvailableRooms();
        verifyRoomStatus();
      },
    }) as HTMLInputElement;

    if (!strictTech) {
      void loadAvailableRooms();
      verifyRoomStatus();
    }

    const diagBox = h('div', { class: 'sup-diag-box', style: 'display:none' });

    const persistSettings = async (silent = false) => {
      const cleanRoom = strictTech ? s.syncRoomCode : normalizeRoomCode(syncRoomInput.value);
      const cleanEndpoint = strictTech ? s.syncEndpointUrl : normalizeEndpointBaseUrl(syncEndpointInput.value);
      if (!strictTech) {
        syncRoomInput.value = cleanRoom;
        syncEndpointInput.value = cleanEndpoint;
      }

      const prevLang = s.language ?? 'auto';
      const nextLang = (langSelect.value as LangPref) || 'auto';

      let nextPin: string | undefined;
      if (supervisorUI) {
        const rawPin = pinInput.value.trim();
        if (!isValidSupervisorPin(rawPin)) {
          toast(L('El PIN de supervisor debe tener exactamente 4 dígitos numéricos.', 'Supervisor PIN must be exactly 4 numeric digits.'), 'error');
          return;
        }
        nextPin = rawPin;
      }

      const nextSyncEnabled = strictTech ? s.syncEnabled : syncEnabledCheck.checked;
      const nextSyncAuto = strictTech ? s.syncAuto : syncAutoCheck.checked;

      await saveSettings({
        counterName: nameInput.value.trim(),
        onlineLookup: lookupCheck.checked,
        proxyUrl: proxyInput.value.trim(),
        beep: beepCheck.checked,
        vibrate: vibCheck.checked,
        quickMode: quickCheck.checked,
        showExpected: showExpCheck.checked,
        currency: (currInput.value.trim() || 'MXN').toUpperCase(),
        syncEnabled: nextSyncEnabled,
        syncAuto: nextSyncAuto,
        syncRoomCode: cleanRoom,
        syncEndpointUrl: cleanEndpoint,
        ...(nextPin ? { supervisorPin: nextPin } : {}),
        language: nextLang,
      });

      if (!strictTech) {
        if (nextSyncEnabled && cleanRoom) {
          startLiveCloudSync({ roomCode: cleanRoom, endpointUrl: cleanEndpoint });
          void syncNow({ roomCode: cleanRoom, endpointUrl: cleanEndpoint }).catch(() => {});
        } else {
          stopLiveCloudSync();
        }
      }
      if (prevLang !== nextLang) notifyLanguageChanged();
      if (!silent) toast(L('Ajustes guardados', 'Settings saved'), 'ok');
    };

    // Auto-save toggles immediately so the user doesn't forget to hit save
    [beepCheck, vibCheck, quickCheck, showExpCheck, lookupCheck, syncEnabledCheck, syncAutoCheck].forEach((chk) => {
      chk.addEventListener('change', () => {
        if (!strictTech || (chk !== syncEnabledCheck && chk !== syncAutoCheck)) {
          void persistSettings(true);
        }
      });
    });

    langSelect.addEventListener('change', () => {
      void (async () => {
        const nextLang = (langSelect.value as LangPref) || 'auto';
        await saveSettings({ language: nextLang });
        notifyLanguageChanged();
        toast(L('Idioma actualizado', 'Language updated'), 'ok');
      })();
    });

    pinInput.addEventListener('change', () => {
      void (async () => {
        if (!isSupervisorModeEnabled()) return;
        const rawPin = pinInput.value.trim();
        if (!isValidSupervisorPin(rawPin)) {
          toast(
            L(
              'El PIN de supervisor debe tener exactamente 4 dígitos numéricos.',
              'Supervisor PIN must be exactly 4 numeric digits.',
            ),
            'error',
          );
          pinInput.value = getSupervisorPin();
          return;
        }
        await saveSettings({ supervisorPin: rawPin });
        toast(L('PIN de supervisor actualizado', 'Supervisor PIN updated'), 'ok');
      })();
    });

    roleSelect.addEventListener('change', () => {
      void (async () => {
        const nextRole = (roleSelect.value as 'supervisor' | 'technician') || 'technician';
        const isSup = nextRole === 'supervisor';
        if (isSup && !isSupervisorModeEnabled()) {
          const ok = await promptSupervisorPin();
          if (!ok) {
            roleSelect.value = 'technician';
            supervisorCheck.checked = false;
            return;
          }
          await switchToSupervisorSession();
        } else if (!isSup) {
          if (supervisorUI && isValidSupervisorPin(pinInput.value.trim())) {
            await saveSettings({ supervisorPin: pinInput.value.trim() });
          }
          await switchToTechnicianSession();
        }
        supervisorCheck.checked = isSupervisorModeEnabled();
        document.getElementById('app')?.setAttribute('data-supervisor', String(isSupervisorModeEnabled()));
        rerender();
      })();
    });

    supervisorCheck.addEventListener('change', () => {
      void (async () => {
        const isSup = supervisorCheck.checked;
        if (isSup && !isSupervisorModeEnabled()) {
          const ok = await promptSupervisorPin();
          if (!ok) {
            supervisorCheck.checked = false;
            roleSelect.value = 'technician';
            return;
          }
          await switchToSupervisorSession();
        } else if (!isSup) {
          if (supervisorUI && isValidSupervisorPin(pinInput.value.trim())) {
            await saveSettings({ supervisorPin: pinInput.value.trim() });
          }
          await switchToTechnicianSession();
        }
        roleSelect.value = isSupervisorModeEnabled() ? 'supervisor' : 'technician';
        document.getElementById('app')?.setAttribute('data-supervisor', String(isSupervisorModeEnabled()));
        rerender();
      })();
    });

    const compactToggle = (title: string, subtitle: string, checkbox: HTMLInputElement) =>
      h('label', { class: 'settings-switch-tile' },
        h('div', { class: 'settings-switch-text' },
          h('span', { class: 'settings-switch-title' }, title),
          h('span', { class: 'settings-switch-sub' }, subtitle),
        ),
        checkbox,
      );

    const cloudState = getCloudConnectionStatus();
    const card3StatusPill = h('span', {
      class: `sup-live-pill ${cloudState.state === 'connected' ? 'live' : cloudState.state === 'error' ? 'error' : 'local'}`,
    }, cloudState.state === 'connected' ? L('● En vivo', '● Live') : cloudState.state === 'error' ? L('● Error', '● Error') : L('● Local', '● Local'));

    unsubSettingsCloud = onCloudStatusChange((st) => {
      if (!settingsMounted || seq !== settingsRenderSeq) return;
      card3StatusPill.className = `sup-live-pill ${st.state === 'connected' ? 'live' : st.state === 'error' ? 'error' : 'local'}`;
      card3StatusPill.textContent = st.state === 'connected'
        ? L('● En vivo', '● Live')
        : st.state === 'error'
          ? L('● Error', '● Error')
          : L('● Local', '● Local');
    });

    const rerender = () => void settingsView.render(root, params);

    clear(root,
      h('div', { class: 'settings-header-bar' },
        h('div', null,
          h('h2', { style: 'margin:0; font-size:18px; font-weight:700' }, L('Ajustes y Catálogo', 'Settings & Catalog')),
        ),
        h('button', {
          class: 'btn primary small',
          onclick: () => persistSettings(false),
        }, icon('check'), L('Guardar cambios', 'Save changes')),
      ),

      h('div', { class: 'settings-compact-grid' },
        /* TARJETA 1: GESTIÓN Y CONCILIACIÓN DE CATÁLOGO */
        h('section', { class: 'card settings-card' },
          h('div', { class: 'settings-card-head' },
            h('h3', { class: 'settings-card-title' }, L('Catálogo y Conciliación', 'Catalog & Reconciliation')),
            h('span', { class: 'badge info' }, `${fmtNum(totalProds)} ${L('ítems', 'items')}`),
          ),

          h('div', { class: 'settings-stat-strip' },
            h('div', { class: 'settings-stat-pill' },
              h('span', { class: 'muted small' }, L('Catalogados', 'Cataloged')),
              h('b', null, fmtNum(officialCount)),
            ),
            h('div', { class: 'settings-stat-pill' },
              h('span', { class: 'muted small' }, L('Sin catalogar', 'Uncataloged')),
              h('b', { class: uncatalogedCount > 0 ? 'warn-text' : '' }, fmtNum(uncatalogedCount)),
            ),
            h('button', {
              class: 'btn ghost small',
              style: 'margin-left:auto',
              onclick: () => navigate('/catalogo'),
            }, L('Ver lista →', 'View list →')),
          ),

          h('div', { class: 'settings-action-grid' },
            readOnlyMobile
              ? null
              : h('button', {
                  class: 'btn primary small',
                  'data-testid': 'settings-import-catalog-btn',
                  onclick: () => importCatalogFlow(rerender),
                }, icon('upload'), L('Importar Excel / CSV / JSON', 'Import Excel / CSV / JSON')),

            h('button', {
              class: readOnlyMobile ? 'btn primary small' : 'btn small',
              'data-testid': 'settings-sync-catalog-btn',
              onclick: async () => {
                try {
                  toast(L('Conciliando catálogo y lecturas…', 'Reconciling catalog and scans…'), 'info', 1800);
                  const currentProds = await allProducts();
                  const officialProds = currentProds.filter((p) => !p.uncataloged);
                  const localRec = await reconcileCatalogProducts(officialProds);
                  let cloudSynced = false;
                  const cleanRoom = normalizeRoomCode(syncRoomInput.value);
                  const cleanEndpoint = normalizeEndpointBaseUrl(syncEndpointInput.value);
                  if (readOnlyMobile && cleanRoom) {
                    await syncCatalogWithDb({ roomCode: cleanRoom, endpointUrl: cleanEndpoint });
                    cloudSynced = true;
                  } else if (syncEnabledCheck.checked && cleanRoom) {
                    await syncNow({ roomCode: cleanRoom, endpointUrl: cleanEndpoint });
                    cloudSynced = true;
                  }
                  const afterProds = await allProducts();
                  toast(
                    L(
                      `Catálogo conciliado (${afterProds.length} productos, ${localRec.updated} actualizados${cloudSynced ? ' · sincronizado con BD' : ''})`,
                      `Catalog reconciled (${afterProds.length} products, ${localRec.updated} updated${cloudSynced ? ' · synced with DB' : ''})`,
                    ),
                    'ok',
                    3500,
                  );
                  rerender();
                } catch (e) {
                  toast(L('Error al conciliar: ', 'Reconciliation error: ') + (e as Error).message, 'error', 4000);
                }
              },
            }, icon('refresh'), readOnlyMobile ? L('Sincronizar / Conciliar con BD', 'Sync / Reconcile with DB') : L('Conciliar catálogo ahora', 'Reconcile catalog now')),

            supervisorUI
              ? h('button', {
                  class: 'btn small',
                  disabled: totalProds === 0,
                  onclick: async () => {
                    const currentProds = await allProducts();
                    const file = buildCatalogFile(currentProds);
                    await shareOrDownload(
                      JSON.stringify(file, null, 2),
                      'catalogo_consumibles.json',
                      MIME.json,
                      L('Catálogo de consumibles', 'Consumables catalog'),
                    );
                  },
                }, icon('share'), L('Compartir (.json)', 'Share (.json)'))
              : null,

            supervisorUI
              ? h('button', {
                  class: 'btn small',
                  disabled: totalProds === 0,
                  onclick: async () => {
                    const currentProds = await allProducts();
                    const bytes = buildCatalogWorkbook(currentProds);
                    downloadFile(bytes, 'catalogo_consumibles.xlsx', MIME.xlsx);
                    toast(L('Catálogo exportado a Excel', 'Catalog exported to Excel'), 'ok');
                  },
                }, icon('download'), L('Exportar (.xlsx)', 'Export (.xlsx)'))
              : null,
          ),

          readOnlyMobile
            ? h(
                'div',
                { class: 'catalog-readonly-banner', 'data-testid': 'settings-catalog-readonly-note' },
                L(
                  'En móvil el catálogo es de solo lectura: puedes sincronizar y conciliar con la BD o exportar archivos; importar o vaciar el catálogo solo está disponible en PC.',
                  'On mobile the catalog is read-only: you can sync and reconcile with the DB or export files; importing or clearing the catalog is only available on desktop.',
                ),
              )
            : h(
                'div',
                { class: 'settings-catalog-summary' },
                h('div', { class: 'settings-catalog-summary-row' },
                  h('span', { class: 'muted small' }, L('Estado de sincronización', 'Sync status')),
                  h('b', { class: 'small' }, s.syncEnabled && s.syncRoomCode ? `${L('Sala', 'Room')} ${s.syncRoomCode}` : L('Catálogo local', 'Local catalog')),
                ),
                h('div', { class: 'settings-catalog-summary-row' },
                  h('span', { class: 'muted small' }, L('Modo de edición', 'Edit mode')),
                  h('b', { class: 'small' }, supervisorUI ? L('Supervisor · Edición completa', 'Supervisor · Full edit') : L('Solo lectura', 'Read-only')),
                ),
              ),

          strictTech
            ? null
            : h('div', { class: 'settings-subactions' },
                h('button', {
                  class: 'btn ghost small',
                  onclick: async () => {
                    const count = await loadSampleCatalog();
                    if (!readOnlyMobile) triggerBackgroundSync();
                    toast(L(`${count} consumibles de ejemplo cargados`, `${count} sample items loaded`), 'ok');
                    navigate('/catalogo');
                  },
                }, L('Cargar catálogo de ejemplo', 'Load sample catalog')),
                !readOnlyMobile && totalProds > 0
                  ? h('button', {
                    class: 'btn ghost danger small',
                    'data-testid': 'settings-clear-catalog-btn',
                    onclick: async () => {
                      if (await confirmDialog(
                        L('Vaciar catálogo', 'Clear catalog'),
                        L(
                          `Se eliminarán los ${totalProds} productos del catálogo local (tus conteos se conservan). ¿Continuar?`,
                          `All ${totalProds} products will be removed from the local catalog (your counts are kept). Continue?`,
                        ),
                        L('Vaciar', 'Clear'),
                        true,
                      )) {
                        await clearProducts();
                        triggerBackgroundSync();
                        toast(L('Catálogo vaciado', 'Catalog cleared'), 'info');
                        rerender();
                      }
                    },
                  }, icon('trash'), L('Vaciar catálogo', 'Clear catalog'))
                  : null,
              ),
        ),

        /* TARJETA 2: PERFIL Y COMPORTAMIENTO DE ESCANEO */
        h('section', { class: 'card settings-card' },
          h('div', { class: 'settings-card-head' },
            h('h3', { class: 'settings-card-title' }, L('Perfil y Escaneo', 'Profile & Scanning')),
          ),

          h('div', { class: 'settings-row-2col' },
            h('label', { class: 'field compact-field' },
              h('span', null, L('Nombre del técnico / contador', 'Technician / Counter name')),
              nameInput,
            ),
            h('label', { class: 'field compact-field' },
              h('span', null, L('Rol en este dispositivo', 'Role on this device')),
              roleSelect,
            ),
          ),

          supervisorUI
            ? h('div', { class: 'settings-row-3col' },
                h('label', { class: 'field compact-field' },
                  h('span', null, L('Idioma de la aplicación', 'Application language')),
                  langSelect,
                ),
                h('label', { class: 'field compact-field' },
                  h('span', null, L('Moneda (Reporte)', 'Currency (Report)')),
                  currInput,
                ),
                h('label', { class: 'field compact-field' },
                  h('span', null, L('PIN Supervisor', 'Supervisor PIN')),
                  pinInput,
                ),
              )
            : h('label', { class: 'field compact-field' },
                h('span', null, L('Idioma de la aplicación', 'Application language')),
                langSelect,
              ),

          h('div', { class: 'settings-switch-grid' },
            mobileViewport
              ? compactToggle(L('Modo Supervisor en móvil', 'Mobile Supervisor Mode'), L('Muestra controles de auditoría y reportes en este teléfono', 'Show audit and report controls on this phone'), supervisorCheck)
              : null,
            compactToggle(L('Pitido', 'Beep'), L('Sonido al escanear', 'Sound on scan'), beepCheck),
            compactToggle(L('Vibración', 'Vibration'), L('Respuesta háptica', 'Haptic feedback'), vibCheck),
            compactToggle(L('Modo rápido (+1)', 'Quick mode (+1)'), L('Suma 1 sin preguntar', 'Add 1 without prompting'), quickCheck),
            supervisorUI ? compactToggle(L('Mostrar teórico / ideal', 'Show ideal stock'), L('Ver inventario ideal al contar', 'Show ideal inventory while counting'), showExpCheck) : null,
            supervisorUI ? compactToggle(L('Buscar en internet', 'Online lookup'), L('Autocompletar descripciones', 'Autocomplete descriptions'), lookupCheck) : null,
          ),
        ),

        /* TARJETA 3: SINCRONIZACIÓN EN LÍNEA (FIREBASE / EQUIPO) */
        h('section', { class: 'card settings-card settings-card-wide' },
          h('div', { class: 'settings-card-head' },
            h('h3', { class: 'settings-card-title' }, L('Sincronización en Línea (Firebase Realtime DB)', 'Live Cloud Sync (Firebase Realtime DB)')),
            card3StatusPill,
          ),

          strictTech
            ? h('div', { class: 'catalog-readonly-banner', 'data-testid': 'settings-sync-readonly-note' },
                L(
                  'La sala compartida y la conexión Firebase están administradas por el Supervisor. Cambia a rol Supervisor con tu PIN para modificarlas.',
                  'The shared room and Firebase connection are managed by the Supervisor. Switch to Supervisor role with your PIN to edit them.',
                ),
              )
            : null,

          h('div', { class: 'settings-switch-grid settings-switch-grid-2' },
            compactToggle(L('Activar sincronización en línea', 'Enable live sync'), L('Habilita sala compartida en vivo', 'Enable live shared room'), syncEnabledCheck),
            compactToggle(L('Auto-sincronizar al escanear', 'Auto-sync on scan'), L('Envía cada lectura automáticamente', 'Send each scan automatically'), syncAutoCheck),
          ),

          h('div', { class: 'settings-row-2col', style: 'margin-top:8px' },
            h('label', { class: 'field compact-field' },
              h('span', null, L('Código de Sala compartida', 'Shared room code')),
              syncRoomInput,
              roomDatalist,
              roomStatusBadge,
            ),
            h('label', { class: 'field compact-field' },
              h('span', null, L('URL de Firebase Realtime DB', 'Firebase Realtime DB URL')),
              syncEndpointInput,
            ),
          ),

          h('div', { class: 'row wrap', style: 'gap:8px; margin-top:10px' },
            strictTech
              ? null
              : h('button', {
                  class: 'btn primary small',
                  onclick: () => persistSettings(false),
                }, icon('check'), L('Guardar y conectar', 'Save & connect')),
            strictTech
              ? null
              : h('button', {
                  class: 'btn small',
                  onclick: async () => {
                    diagBox.style.display = 'block';
                    diagBox.className = 'sup-diag-box info';
                    diagBox.textContent = L('Probando conexión con Firebase…', 'Testing Firebase connection…');
                    const res = await testFirebaseConnection(syncEndpointInput.value, syncRoomInput.value);
                    diagBox.className = `sup-diag-box ${res.ok ? 'ok' : 'error'}`;
                    diagBox.textContent = res.message;
                    syncEndpointInput.value = normalizeEndpointBaseUrl(syncEndpointInput.value);
                  },
                }, icon('refresh'), L('Probar conexión', 'Test connection')),
            h('button', {
              class: 'btn ghost small',
              style: 'margin-left:auto',
              onclick: () => navigate('/equipo'),
            }, L('Ir al Monitor de Supervisor →', 'Go to Supervisor Monitor →')),
          ),
          diagBox,
        ),
      ),

      /* OPCIONES AVANZADAS COLAPSABLES SOLO PARA SUPERVISOR / PC */
      supervisorUI
        ? h('details', { class: 'card settings-advanced' },
            h('summary', { class: 'settings-advanced-summary' },
              h('span', null, L('Opciones avanzadas y restablecimiento de fábrica', 'Advanced options & factory reset')),
              h('span', { class: 'muted small' }, L('Proxy UPC · Borrar datos locales', 'UPC Proxy · Clear local data')),
            ),
            h('div', { class: 'settings-advanced-body' },
              h('label', { class: 'field compact-field', style: 'max-width:420px' },
                h('span', null, L('Ruta del proxy UPCitemdb', 'UPCitemdb proxy path')),
                proxyInput,
                h('span', { class: 'muted small' }, L('Por defecto "api/upc". Deja en blanco para consultar solo Open Facts directo.', 'Default "api/upc". Leave blank to query Open Facts directly.')),
              ),
              h('div', { class: 'settings-danger-bar' },
                h('div', null,
                  h('b', { style: 'color:var(--danger)' }, L('Reiniciar aplicación en este dispositivo', 'Reset app on this device')),
                  h('div', { class: 'muted small' }, L('Elimina el catálogo, las sesiones y todos los conteos guardados en este navegador.', 'Deletes catalog, sessions, and all counts stored in this browser.')),
                ),
                h('button', {
                  class: 'btn danger ghost small',
                  onclick: async () => {
                    if (await confirmDialog(
                      L('Reiniciar todo', 'Reset everything'),
                      L('Se borrarán el catálogo, todas las sesiones y todos los conteos guardados en este dispositivo. ¿Estás seguro?', 'Catalog, all sessions, and all counts stored on this device will be erased. Are you sure?'),
                      L('Borrar todo', 'Erase all'),
                      true,
                    )) {
                      stopLiveCloudSync();
                      const db = await getDB();
                      await db.clear('products');
                      await db.clear('counts');
                      await db.clear('sessions');
                      await db.clear('meta');
                      clearLocalStorageRoomMirrors();
                      clearMobilePinSession();
                      _resetSettingsCache();
                      toast(L('Datos borrados', 'Data cleared'));
                      location.reload();
                    }
                  },
                }, icon('trash'), L('Borrar todos los datos', 'Erase all data')),
              ),
            ),
          )
        : null,
    );
  },
  destroy() {
    settingsMounted = false;
    settingsRenderSeq++;
    cleanupSettingsResources();
  },
};
