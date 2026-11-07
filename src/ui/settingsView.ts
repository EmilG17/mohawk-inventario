import { clearProducts, getDB } from '../db/db';
import { loadSampleCatalog } from '../sampleData';
import { loadSettings, saveSettings, type Settings } from '../settings';
import {
  clear, confirmDialog, h, icon, toast,
} from './dom';
import { navigate, type View } from './router';

export const settingsView: View = {
  title: 'Ajustes',
  async render(root) {
    const s = await loadSettings();

    const nameInput = h('input', { class: 'input', value: s.counterName, placeholder: 'Tu nombre' }) as HTMLInputElement;
    const lookupCheck = h('input', { type: 'checkbox', checked: s.onlineLookup }) as HTMLInputElement;
    const proxyInput = h('input', { class: 'input', value: s.proxyUrl, placeholder: 'api/upc' }) as HTMLInputElement;
    const beepCheck = h('input', { type: 'checkbox', checked: s.beep }) as HTMLInputElement;
    const vibCheck = h('input', { type: 'checkbox', checked: s.vibrate }) as HTMLInputElement;
    const quickCheck = h('input', { type: 'checkbox', checked: s.quickMode }) as HTMLInputElement;
    const showExpCheck = h('input', { type: 'checkbox', checked: s.showExpected }) as HTMLInputElement;
    const currInput = h('input', { class: 'input', value: s.currency, maxlength: 5, placeholder: 'MXN' }) as HTMLInputElement;
    const syncEnabledCheck = h('input', { type: 'checkbox', checked: s.syncEnabled }) as HTMLInputElement;
    const syncAutoCheck = h('input', { type: 'checkbox', checked: s.syncAuto }) as HTMLInputElement;
    const syncRoomInput = h('input', { class: 'input', value: s.syncRoomCode, placeholder: 'Ej. MHK-PLANTA-1' }) as HTMLInputElement;
    const syncEndpointInput = h('input', { class: 'input', value: s.syncEndpointUrl, placeholder: 'Opcional: https://tu-proyecto.firebaseio.com o URL REST' }) as HTMLInputElement;

    const save = async () => {
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
        syncRoomCode: syncRoomInput.value.trim().toUpperCase(),
        syncEndpointUrl: syncEndpointInput.value.trim(),
      });
      toast('Ajustes guardados', 'ok');
    };

    clear(root,
      h('section', { class: 'card' },
        h('h3', null, 'Perfil'),
        h('label', { class: 'field' },
          h('span', null, 'Nombre del contador'),
          nameInput,
          h('span', { class: 'muted small' }, 'Se guarda con cada escaneo para auditoría.'),
        ),
      ),

      h('section', { class: 'card' },
        h('h3', null, '☁️ Sincronización en línea (Equipo en tiempo real)'),
        h('label', { class: 'switch-row' },
          h('div', null,
            h('b', null, 'Activar sincronización en línea'),
            h('div', { class: 'muted small' }, 'Comparte conteos en tiempo real entre técnicos y supervisor usando un mismo Código de Sala.'),
          ),
          syncEnabledCheck,
        ),
        h('label', { class: 'switch-row' },
          h('div', null,
            h('b', null, 'Sincronización automática al escanear'),
            h('div', { class: 'muted small' }, 'Envía cada lectura en segundo plano (y reintenta al recuperar Wi-Fi/datos).'),
          ),
          syncAutoCheck,
        ),
        h('div', { class: 'grid2' },
          h('label', { class: 'field' },
            h('span', null, 'Código de Sala compartida'),
            syncRoomInput,
            h('span', { class: 'muted small' }, 'Todos los técnicos de la sesión deben usar el mismo código.'),
          ),
          h('label', { class: 'field' },
            h('span', null, 'URL de servidor nube (Opcional)'),
            syncEndpointInput,
            h('span', { class: 'muted small' }, 'Compatible con Firebase Realtime DB, Supabase o endpoint REST JSON.'),
          ),
        ),
      ),

      h('section', { class: 'card' },
        h('h3', null, 'Escaneo y conteo'),
        h('label', { class: 'switch-row' },
          h('div', null, h('b', null, 'Pitido de confirmación'), h('div', { class: 'muted small' }, 'Suena al leer un código')),
          beepCheck,
        ),
        h('label', { class: 'switch-row' },
          h('div', null, h('b', null, 'Vibración'), h('div', { class: 'muted small' }, 'Vibra al detectar el código (Android)')),
          vibCheck,
        ),
        h('label', { class: 'switch-row' },
          h('div', null, h('b', null, 'Modo rápido (+1)'), h('div', { class: 'muted small' }, 'Cada escaneo suma 1 inmediatamente sin abrir la tarjeta de cantidad')),
          quickCheck,
        ),
        h('label', { class: 'switch-row' },
          h('div', null, h('b', null, 'Mostrar existencia teórica al contar'), h('div', { class: 'muted small' }, 'Por defecto apagado para hacer un "conteo ciego" no sesgado')),
          showExpCheck,
        ),
      ),

      h('section', { class: 'card' },
        h('h3', null, 'Obtención de descripciones'),
        h('label', { class: 'switch-row' },
          h('div', null,
            h('b', null, 'Buscar en internet si no está en catálogo'),
            h('div', { class: 'muted small' }, 'Consulta bases públicas (Open Facts y UPCitemdb). Requiere internet al momento del escaneo; si no hay, se reintenta al reconectar.'),
          ),
          lookupCheck,
        ),
        h('label', { class: 'field' },
          h('span', null, 'Ruta del proxy UPCitemdb'),
          proxyInput,
          h('span', { class: 'muted small' }, 'Por defecto "api/upc". Deja en blanco para usar solo Open Facts directo.'),
        ),
      ),

      h('section', { class: 'card' },
        h('h3', null, 'Formato'),
        h('label', { class: 'field' },
          h('span', null, 'Código de moneda'),
          currInput,
          h('span', { class: 'muted small' }, 'Para valorizar diferencias (ej. MXN, USD).'),
        ),
      ),

      h('div', { class: 'row' },
        h('button', { class: 'btn primary grow', onclick: save }, 'Guardar ajustes'),
      ),

      h('section', { class: 'card' },
        h('h3', null, 'Datos de prueba'),
        h('p', { class: 'muted small' }, 'Carga un catálogo de consumibles Mohawk (guantes, cinta, lubricantes, cutters, etc.) para probar el sistema sin tu archivo real.'),
        h('button', {
          class: 'btn',
          onclick: async () => {
            const count = await loadSampleCatalog();
            toast(`${count} consumibles de ejemplo cargados`, 'ok');
            navigate('/catalogo');
          },
        }, 'Cargar catálogo de ejemplo'),
      ),

      h('section', { class: 'card danger-zone' },
        h('h3', null, 'Zona de peligro'),
        h('button', {
          class: 'btn danger ghost',
          onclick: async () => {
            if (await confirmDialog('Reiniciar todo', 'Se borrarán el catálogo, todas las sesiones y todos los conteos guardados en este teléfono. ¿Estás seguro?', 'Borrar todo', true)) {
              const db = await getDB();
              await db.clear('products');
              await db.clear('counts');
              await db.clear('sessions');
              await db.clear('meta');
              toast('Datos borrados');
              location.reload();
            }
          },
        }, icon('trash'), 'Borrar todos los datos de la app'),
      ),
    );
  },
};
