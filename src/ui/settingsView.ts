import { allProducts, clearProducts, getDB } from '../db/db';
import { buildCatalogFile, buildCatalogWorkbook } from '../io/exportResults';
import { reconcileCatalogProducts } from '../io/mergeCounts';
import { loadSampleCatalog } from '../sampleData';
import { loadSettings, saveSettings } from '../settings';
import {
  getCloudConnectionStatus,
  normalizeEndpointBaseUrl,
  normalizeRoomCode,
  startLiveCloudSync,
  stopLiveCloudSync,
  syncNow,
  testFirebaseConnection,
  triggerBackgroundSync,
} from '../sync/cloudSync';
import { importCatalogFlow } from './catalog';
import {
  clear, confirmDialog, downloadFile, fmtNum, h, icon, MIME, shareOrDownload, toast,
} from './dom';
import { navigate, type View } from './router';

export const settingsView: View = {
  title: 'Ajustes',
  async render(root, params) {
    const [s, products] = await Promise.all([loadSettings(), allProducts()]);
    const totalProds = products.length;
    const uncatalogedCount = products.filter((p) => p.uncataloged).length;
    const officialCount = totalProds - uncatalogedCount;

    const nameInput = h('input', {
      class: 'input input-sm',
      value: s.counterName,
      placeholder: 'Ej. Juan Pérez',
    }) as HTMLInputElement;
    const currInput = h('input', {
      class: 'input input-sm',
      value: s.currency,
      maxlength: 5,
      placeholder: 'MXN',
    }) as HTMLInputElement;

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

    const syncEnabledCheck = h('input', { type: 'checkbox', checked: s.syncEnabled }) as HTMLInputElement;
    const syncAutoCheck = h('input', { type: 'checkbox', checked: s.syncAuto }) as HTMLInputElement;
    const syncRoomInput = h('input', {
      class: 'input input-sm',
      value: s.syncRoomCode,
      placeholder: 'Ej. MHK-PLANTA-1',
    }) as HTMLInputElement;
    const syncEndpointInput = h('input', {
      class: 'input input-sm',
      value: s.syncEndpointUrl,
      placeholder: 'https://tu-proyecto-default-rtdb.firebaseio.com',
    }) as HTMLInputElement;

    const diagBox = h('div', { class: 'sup-diag-box', style: 'display:none' });

    const persistSettings = async (silent = false) => {
      const cleanRoom = normalizeRoomCode(syncRoomInput.value);
      const cleanEndpoint = normalizeEndpointBaseUrl(syncEndpointInput.value);
      syncRoomInput.value = cleanRoom;
      syncEndpointInput.value = cleanEndpoint;

      await saveSettings({
        counterName: nameInput.value.trim(),
        onlineLookup: lookupCheck.checked,
        proxyUrl: proxyInput.value.trim(),
        beep: beepCheck.checked,
        vibrate: vibCheck.checked,
        quickMode: quickCheck.checked,
        showExpected: showExpCheck.checked,
        currency: (currInput.value.trim() || 'MXN').toUpperCase(),
        syncEnabled: syncEnabledCheck.checked,
        syncAuto: syncAutoCheck.checked,
        syncRoomCode: cleanRoom,
        syncEndpointUrl: cleanEndpoint,
      });

      if (syncEnabledCheck.checked && cleanRoom) {
        startLiveCloudSync({ roomCode: cleanRoom, endpointUrl: cleanEndpoint });
        void syncNow({ roomCode: cleanRoom, endpointUrl: cleanEndpoint }).catch(() => {});
      } else {
        stopLiveCloudSync();
      }
      if (!silent) toast('Ajustes guardados', 'ok');
    };

    // Auto-save toggles immediately so the user doesn't forget to hit save
    [beepCheck, vibCheck, quickCheck, showExpCheck, lookupCheck, syncEnabledCheck, syncAutoCheck].forEach((chk) => {
      chk.addEventListener('change', () => {
        void persistSettings(true);
      });
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
    const rerender = () => void settingsView.render(root, params);

    clear(root,
      h('div', { class: 'settings-header-bar' },
        h('div', null,
          h('h2', { style: 'margin:0; font-size:1.15rem' }, 'Ajustes y Catálogo'),
          h('p', { class: 'muted small', style: 'margin:2px 0 0 0' },
            'Configuración general, importación/conciliación de catálogo y sincronización en línea.'),
        ),
        h('button', {
          class: 'btn primary small',
          onclick: () => persistSettings(false),
        }, icon('check'), 'Guardar cambios'),
      ),

      h('div', { class: 'settings-compact-grid' },
        /* TARJETA 1: GESTIÓN Y CONCILIACIÓN DE CATÁLOGO */
        h('section', { class: 'card settings-card' },
          h('div', { class: 'settings-card-head' },
            h('div', null,
              h('h3', { class: 'settings-card-title' }, '📚 Catálogo y Conciliación'),
              h('p', { class: 'muted small', style: 'margin:2px 0 0 0' },
                'Importa, comparte o concilia el catálogo maestro con los conteos y lecturas por código o SKU.'),
            ),
            h('span', { class: 'badge info' }, `${fmtNum(totalProds)} ítems`),
          ),

          h('div', { class: 'settings-stat-strip' },
            h('div', { class: 'settings-stat-pill' },
              h('span', { class: 'muted small' }, 'Catalogados'),
              h('b', null, fmtNum(officialCount)),
            ),
            h('div', { class: 'settings-stat-pill' },
              h('span', { class: 'muted small' }, 'Sin catalogar'),
              h('b', { class: uncatalogedCount > 0 ? 'warn-text' : '' }, fmtNum(uncatalogedCount)),
            ),
            h('button', {
              class: 'btn ghost small',
              style: 'margin-left:auto',
              onclick: () => navigate('/catalogo'),
            }, 'Ver lista →'),
          ),

          h('div', { class: 'settings-action-grid' },
            h('button', {
              class: 'btn primary small',
              onclick: () => importCatalogFlow(rerender),
            }, icon('upload'), 'Importar Excel / CSV / JSON'),

            h('button', {
              class: 'btn small',
              onclick: async () => {
                try {
                  toast('Conciliando catálogo y lecturas…', 'info', 1800);
                  const currentProds = await allProducts();
                  const officialProds = currentProds.filter((p) => !p.uncataloged);
                  const localRec = await reconcileCatalogProducts(officialProds);
                  let cloudSynced = false;
                  const cleanRoom = normalizeRoomCode(syncRoomInput.value);
                  const cleanEndpoint = normalizeEndpointBaseUrl(syncEndpointInput.value);
                  if (syncEnabledCheck.checked && cleanRoom) {
                    await syncNow({ roomCode: cleanRoom, endpointUrl: cleanEndpoint });
                    cloudSynced = true;
                  }
                  const afterProds = await allProducts();
                  toast(
                    `Catálogo conciliado (${afterProds.length} productos, ${localRec.updated} actualizados${cloudSynced ? ' · sincronizado con Firebase' : ''})`,
                    'ok',
                    3500,
                  );
                  rerender();
                } catch (e) {
                  toast('Error al conciliar: ' + (e as Error).message, 'error', 4000);
                }
              },
            }, icon('refresh'), 'Conciliar catálogo ahora'),

            h('button', {
              class: 'btn small',
              disabled: totalProds === 0,
              onclick: async () => {
                const currentProds = await allProducts();
                const file = buildCatalogFile(currentProds);
                await shareOrDownload(
                  JSON.stringify(file, null, 2),
                  'catalogo_consumibles.json',
                  MIME.json,
                  'Catálogo de consumibles',
                );
              },
            }, icon('share'), 'Compartir (.json)'),

            h('button', {
              class: 'btn small',
              disabled: totalProds === 0,
              onclick: async () => {
                const currentProds = await allProducts();
                const bytes = buildCatalogWorkbook(currentProds);
                downloadFile(bytes, 'catalogo_consumibles.xlsx', MIME.xlsx);
                toast('Catálogo exportado a Excel', 'ok');
              },
            }, icon('download'), 'Exportar (.xlsx)'),
          ),

          h('div', { class: 'settings-subactions' },
            h('button', {
              class: 'btn ghost small',
              onclick: async () => {
                const count = await loadSampleCatalog();
                triggerBackgroundSync();
                toast(`${count} consumibles de ejemplo cargados`, 'ok');
                navigate('/catalogo');
              },
            }, 'Cargar catálogo de ejemplo'),
            totalProds > 0
              ? h('button', {
                class: 'btn ghost danger small',
                onclick: async () => {
                  if (await confirmDialog(
                    'Vaciar catálogo',
                    `Se eliminarán los ${totalProds} productos del catálogo local (tus conteos se conservan). ¿Continuar?`,
                    'Vaciar',
                    true,
                  )) {
                    await clearProducts();
                    toast('Catálogo vaciado', 'info');
                    rerender();
                  }
                },
              }, icon('trash'), 'Vaciar catálogo')
              : null,
          ),
        ),

        /* TARJETA 2: PERFIL Y COMPORTAMIENTO DE ESCANEO */
        h('section', { class: 'card settings-card' },
          h('div', { class: 'settings-card-head' },
            h('div', null,
              h('h3', { class: 'settings-card-title' }, '👤 Perfil y Escaneo'),
              h('p', { class: 'muted small', style: 'margin:2px 0 0 0' },
                'Identificación del técnico y preferencias al leer códigos.'),
            ),
          ),

          h('div', { class: 'settings-row-2col' },
            h('label', { class: 'field compact-field' },
              h('span', null, 'Nombre del técnico / contador'),
              nameInput,
            ),
            h('label', { class: 'field compact-field' },
              h('span', null, 'Moneda (Reporte)'),
              currInput,
            ),
          ),

          h('div', { class: 'settings-switch-grid' },
            compactToggle('🔊 Pitido', 'Sonido al escanear', beepCheck),
            compactToggle('📳 Vibración', 'Respuesta háptica', vibCheck),
            compactToggle('⚡ Modo rápido (+1)', 'Suma 1 sin preguntar', quickCheck),
            compactToggle('👁️ Mostrar teórico', 'Ver stock esperado al contar', showExpCheck),
            compactToggle('🌐 Buscar en internet', 'Autocompletar descripciones', lookupCheck),
          ),
        ),

        /* TARJETA 3: SINCRONIZACIÓN EN LÍNEA (FIREBASE / EQUIPO) */
        h('section', { class: 'card settings-card settings-card-wide' },
          h('div', { class: 'settings-card-head' },
            h('div', null,
              h('h3', { class: 'settings-card-title' }, '☁️ Sincronización en Línea (Firebase Realtime DB)'),
              h('p', { class: 'muted small', style: 'margin:2px 0 0 0' },
                'Conecta a técnicos y supervisor en tiempo real para unificar conteos, movimientos y catálogo.'),
            ),
            h('span', {
              class: `sup-live-pill ${cloudState.state === 'connected' ? 'live' : cloudState.state === 'error' ? 'error' : 'local'}`,
            }, cloudState.state === 'connected' ? '🟢 En vivo' : cloudState.state === 'error' ? '⚠️ Error' : '⚪ Local'),
          ),

          h('div', { class: 'settings-switch-grid settings-switch-grid-2' },
            compactToggle('Activar sincronización en línea', 'Habilita sala compartida en vivo', syncEnabledCheck),
            compactToggle('Auto-sincronizar al escanear', 'Envía cada lectura automáticamente', syncAutoCheck),
          ),

          h('div', { class: 'settings-row-2col', style: 'margin-top:8px' },
            h('label', { class: 'field compact-field' },
              h('span', null, 'Código de Sala compartida'),
              syncRoomInput,
            ),
            h('label', { class: 'field compact-field' },
              h('span', null, 'URL de Firebase Realtime DB'),
              syncEndpointInput,
            ),
          ),

          h('div', { class: 'row wrap', style: 'gap:8px; margin-top:10px' },
            h('button', {
              class: 'btn primary small',
              onclick: () => persistSettings(false),
            }, icon('check'), 'Guardar y conectar'),
            h('button', {
              class: 'btn small',
              onclick: async () => {
                diagBox.style.display = 'block';
                diagBox.className = 'sup-diag-box info';
                diagBox.textContent = 'Probando conexión con Firebase…';
                const res = await testFirebaseConnection(syncEndpointInput.value, syncRoomInput.value);
                diagBox.className = `sup-diag-box ${res.ok ? 'ok' : 'error'}`;
                diagBox.textContent = res.message;
                syncEndpointInput.value = normalizeEndpointBaseUrl(syncEndpointInput.value);
              },
            }, '🔌 Probar conexión'),
            h('button', {
              class: 'btn ghost small',
              onclick: () => navigate('/equipo'),
            }, 'Ir al Monitor de Supervisor →'),
          ),
          diagBox,
        ),
      ),

      /* OPCIONES AVANZADAS COLAPSABLES PARA NO CONTAMINAR LA VISTA */
      h('details', { class: 'card settings-advanced' },
        h('summary', { class: 'settings-advanced-summary' },
          h('span', null, '⚙️ Opciones avanzadas y restablecimiento de fábrica'),
          h('span', { class: 'muted small' }, 'Proxy UPC · Borrar datos locales'),
        ),
        h('div', { class: 'settings-advanced-body' },
          h('label', { class: 'field compact-field', style: 'max-width:420px' },
            h('span', null, 'Ruta del proxy UPCitemdb'),
            proxyInput,
            h('span', { class: 'muted small' }, 'Por defecto "api/upc". Deja en blanco para consultar solo Open Facts directo.'),
          ),
          h('div', { class: 'settings-danger-bar' },
            h('div', null,
              h('b', { style: 'color:var(--danger)' }, 'Reiniciar aplicación en este dispositivo'),
              h('div', { class: 'muted small' }, 'Elimina el catálogo, las sesiones y todos los conteos guardados en este navegador.'),
            ),
            h('button', {
              class: 'btn danger ghost small',
              onclick: async () => {
                if (await confirmDialog(
                  'Reiniciar todo',
                  'Se borrarán el catálogo, todas las sesiones y todos los conteos guardados en este dispositivo. ¿Estás seguro?',
                  'Borrar todo',
                  true,
                )) {
                  const db = await getDB();
                  await db.clear('products');
                  await db.clear('counts');
                  await db.clear('sessions');
                  await db.clear('meta');
                  toast('Datos borrados');
                  location.reload();
                }
              },
            }, icon('trash'), 'Borrar todos los datos'),
          ),
        ),
      ),
    );
  },
};
