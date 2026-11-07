import {
  allProducts, allSessions, closeSession, countsForSession, deleteSession, getActiveSession, getDeviceId, getMeta,
  reopenSession, setActiveSession, type CountEntry, type Session,
} from '../db/db';
import { renderQrCodeSvg } from '../barcode/code128';
import { buildCountFile, safeFileName, type CountFile } from '../io/exportResults';
import { mergeCountFiles, parseTechnicianReportFile } from '../io/mergeCounts';
import { loadSettings, saveSettings } from '../settings';
import {
  decodeCompactCountQr,
  encodeCompactCountQrChunks,
  generateRoomCode,
  normalizeRoomCode,
  syncNow,
} from '../sync/cloudSync';
import {
  clear, confirmDialog, fmtDateTime, fmtNum, h, icon, MIME, openDialog, pickFiles, shareOrDownload, toast,
} from './dom';
import { askCounterName, newSessionFlow } from './home';
import { navigate, type View } from './router';
import { openUnifyReportsDialog } from './unifyReportsDialog';

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
      `Pide al supervisor que escanee este código QR desde la pestaña Contar o desde Equipo → "Recibir por QR" para consolidar los conteos de ${session.counter}.`,
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

function openReceiveQrDialog(activeSession: Session): void {
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
      'Puedes escanear directamente el QR del técnico desde la cámara en la pestaña "Contar", con pistola lectora2D aquí, o pegar el texto del QR:',
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
          navigate('/equipo');
        } catch (err) {
          toast((err as Error).message || 'QR inválido', 'error');
          return true;
        }
      },
    },
  ]);
}

export const teamView: View = {
  title: 'Equipo',
  async render(root) {
    const [sessions, current, deviceId, s] = await Promise.all([
      allSessions(), getActiveSession(), getDeviceId(), loadSettings(),
    ]);

    const curCounts = current ? await countsForSession(current.id) : [];
    const products = await allProducts();
    const lastSyncTs = s.syncRoomCode
      ? await getMeta<number>(`lastSync_${normalizeRoomCode(s.syncRoomCode)}`)
      : undefined;

    // Contadores que participaron en la sesión activa
    const contributors = new Map<string, { qty: number; scans: number }>();
    for (const c of curCounts) {
      const name = c.counter || 'Sin nombre';
      const a = contributors.get(name) ?? { qty: 0, scans: 0 };
      a.qty += c.qty;
      a.scans++;
      contributors.set(name, a);
    }

    // Compartir mi conteo
    const shareMyCount = async () => {
      if (!current) return;
      const file = buildCountFile(current, curCounts, products, deviceId);
      const name = `conteo_${safeFileName(current.name)}_${safeFileName(current.counter)}.json`;
      await shareOrDownload(JSON.stringify(file, null, 2), name, MIME.json, `Conteo de ${current.counter}`);
    };

    // Importar conteos o reportes de otros (.xlsx, .csv, .json)
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
      const ok = await confirmDialog('Consolidar conteos',
        `Se importarán ${totalScans} registros de ${countFiles.length} archivo(s) (${who}) en la sesión "${current.name}". Los registros ya existentes no se duplicarán.`,
        'Consolidar');
      if (!ok) return;

      const res = await mergeCountFiles(current.id, countFiles);
      toast(`Listo: ${res.added} registros agregados (${res.duplicates} duplicados ignorados, ${res.productsAdded} productos nuevos)`, 'ok', 5000);
      navigate('/equipo');
    };

    // Controles de Sala de Sincronización en Línea
    const roomInput = h('input', {
      class: 'input',
      value: s.syncRoomCode,
      placeholder: 'Ej. MHK-2026',
      style: 'text-transform: uppercase; font-weight: 600;',
    }) as HTMLInputElement;

    const endpointInput = h('input', {
      class: 'input',
      value: s.syncEndpointUrl,
      placeholder: 'Opcional: https://tu-db.firebaseio.com o URL REST',
    }) as HTMLInputElement;

    const autoCheck = h('input', {
      type: 'checkbox',
      checked: s.syncAuto,
      onchange: async (e: Event) => {
        await saveSettings({ syncAuto: (e.target as HTMLInputElement).checked, syncEnabled: true });
      },
    }) as HTMLInputElement;

    const syncStatusEl = h(
      'div',
      { class: 'muted small' },
      lastSyncTs
        ? `Última sincronización en sala ${s.syncRoomCode}: ${fmtDateTime(lastSyncTs)}`
        : 'Ingresa un mismo Código de Sala en los dispositivos de los técnicos y del supervisor para sincronizar en línea.',
    );

    const doSyncRoom = async () => {
      const code = normalizeRoomCode(roomInput.value);
      if (!code) {
        toast('Ingresa o genera un Código de Sala primero', 'warn');
        return;
      }
      roomInput.value = code;
      await saveSettings({
        syncEnabled: true,
        syncRoomCode: code,
        syncEndpointUrl: endpointInput.value.trim(),
        syncAuto: autoCheck.checked,
      });
      try {
        const res = await syncNow({
          sessionId: current?.id,
          roomCode: code,
          endpointUrl: endpointInput.value.trim(),
        });
        toast(
          `Sala ${res.roomCode} sincronizada: +${res.addedCounts} lectura(s) nuevas · ${res.totalRoomCounts} totales (${res.participants.length} participante(s))`,
          'ok',
          4500,
        );
        navigate('/equipo');
      } catch (err) {
        toast((err as Error).message || 'Error al sincronizar sala', 'error');
      }
    };

    const syncCard = h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head wrap', style: 'gap: 8px;' },
        h('div', null,
          h('div', { class: 'muted small' }, 'Sincronización multipuesto'),
          h('h3', { style: 'margin: 0;' }, '☁️ Sincronización en Línea en Tiempo Real'),
        ),
        s.syncEnabled && s.syncRoomCode
          ? h('span', { class: 'badge ok' }, `Sala activa: ${s.syncRoomCode}`)
          : h('span', { class: 'badge info' }, 'Listo para conectar'),
      ),
      syncStatusEl,
      h(
        'div',
        { class: 'grid2', style: 'margin-top: 8px;' },
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Código de Sala compartida'),
          h(
            'div',
            { class: 'row', style: 'gap: 6px;' },
            roomInput,
            h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                title: 'Generar nuevo código de sala',
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
          h('span', null, 'Servidor Nube REST / Firebase (Opcional)'),
          endpointInput,
        ),
      ),
      h(
        'div',
        { class: 'row wrap', style: 'justify-content: space-between; align-items: center; margin-top: 8px; gap: 10px;' },
        h(
          'label',
          { class: 'check-inline small' },
          autoCheck,
          h('span', null, 'Sincronizar automáticamente cada escaneo en vivo'),
        ),
        h(
          'div',
          { class: 'row wrap', style: 'gap: 8px;' },
          h(
            'button',
            { class: 'btn primary', type: 'button', onclick: doSyncRoom },
            icon('globe'),
            'Sincronizar ahora',
          ),
        ),
      ),
    );

    clear(root,
      syncCard,
      // Panel sesión actual y multiusuario
      current
        ? h('section', { class: 'card' },
          h('div', { class: 'muted small' }, 'Sesión activa para consolidar'),
          h('h2', null, current.name),
          h('p', { class: 'muted small' }, `Responsable: ${current.counter} · Iniciada ${fmtDateTime(current.createdAt)}`),
          h('div', { class: 'row wrap' },
            h('button', {
              class: 'btn primary',
              onclick: () => void openUnifyReportsDialog((sid) => navigate(`/reporte?session=${sid}`)),
            }, icon('users'), 'Unificar reportes de técnicos'),
            h('button', { class: 'btn', onclick: importOthers }, icon('upload'), 'Importar archivos de otros'),
            h('button', { class: 'btn', onclick: shareMyCount, disabled: !curCounts.length }, icon('share'), 'Compartir mi conteo'),
            h('button', {
              class: 'btn',
              disabled: !curCounts.length,
              onclick: () => openShowMyQrDialog(current, curCounts),
            }, icon('scan'), '📱 Mostrar QR de mi conteo'),
            h('button', {
              class: 'btn',
              onclick: () => openReceiveQrDialog(current),
            }, icon('scan'), '📷 Recibir por QR'),
            h('button', {
              class: 'btn danger ghost',
              onclick: async () => {
                const ok = await confirmDialog('Finalizar sesión', `¿Deseas finalizar la sesión activa "${current.name}"?`, 'Finalizar sesión', true);
                if (ok) {
                  await closeSession(current.id);
                  toast('Sesión finalizada con éxito', 'ok');
                  navigate('/equipo');
                }
              },
            }, 'Finalizar sesión'),
          ),
          h('details', { class: 'help-box' },
            h('summary', null, '¿Cómo contar en equipo y unificar reportes de técnicos?'),
            h('ol', { class: 'small' },
              h('li', null, 'Cada técnico abre la app en su teléfono y pone su nombre.'),
              h('li', null, 'Todos importan el mismo Excel de catálogo (o se unen al mismo ', h('b', null, 'Código de Sala en Línea'), ' arriba).'),
              h('li', null, 'Cada quien cuenta en su zona (en línea se sincroniza solo; sin señal se guarda localmente y puedes mostrar un ', h('b', null, 'Código QR'), ' en pantalla).'),
              h('li', null, 'Al terminar, cada técnico sincroniza en línea, muestra su QR o envía su reporte (', h('b', null, 'Excel .xlsx'), ', ', h('b', null, 'CSV .csv'), ' o ', h('b', null, 'JSON'), ').'),
              h('li', null, 'El supervisor toca ', h('b', null, 'Sincronizar ahora'), ' o ', h('b', null, 'Unificar reportes de técnicos'), ' y obtiene al instante el ', h('b', null, 'Reporte Maestro Unificado'), ' con alertas de stock mínimo.'),
            ),
          ),
          contributors.size > 0
            ? [
              h('h3', { class: 'section-title' }, 'Participantes en esta sesión'),
              h('ul', { class: 'contributor-list' },
                [...contributors.entries()].map(([name, data]) => h('li', null,
                  h('span', null, h('b', null, name)),
                  h('span', { class: 'muted small' }, `${fmtNum(data.qty)} u. en ${data.scans} escaneo(s)`),
                )),
              ),
            ]
            : null,
        )
        : h('section', { class: 'card' },
          h('div', { class: 'badge warn', style: 'margin-bottom: 8px; display: inline-block;' }, 'Sin sesión activa'),
          h('h2', null, 'Sin sesión activa'),
          h('p', { class: 'muted' }, 'No hay ninguna sesión activa seleccionada. Puedes sincronizar una sala en línea arriba, unificar los reportes enviados por los técnicos, seleccionar una sesión guardada abajo o iniciar una nueva.'),
          h('div', { class: 'row wrap' },
            h('button', {
              class: 'btn primary',
              onclick: () => void openUnifyReportsDialog((sid) => navigate(`/reporte?session=${sid}`)),
            }, icon('users'), 'Unificar reportes de técnicos'),
            h('button', { class: 'btn', onclick: async () => { if (await newSessionFlow()) navigate('/contar'); } }, icon('scan'), 'Iniciar nueva sesión'),
          ),
        ),

      // Lista de sesiones
      h('section', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h3', null, 'Sesiones guardadas'),
          h('button', { class: 'btn primary sm', onclick: async () => { if (await newSessionFlow()) navigate('/contar'); } }, 'Nueva sesión'),
        ),
        h('ul', { class: 'session-list' },
          sessions.length === 0 ? h('li', { class: 'empty' }, 'No hay sesiones registradas.') : null,
          sessions.map((s) => {
            const isCur = current?.id === s.id;
            const statusBadge = isCur
              ? h('span', { class: 'badge ok' }, 'Activa')
              : s.closed
                ? h('span', { class: 'badge info' }, 'Cerrada')
                : h('span', { class: 'badge warn' }, 'Abierta');

            return h('li', { class: `s-item ${isCur ? 'active' : ''}` },
              h('div', {
                class: 'grow',
                onclick: async () => {
                  if (s.closed) {
                    await reopenSession(s.id);
                    toast(`Sesión reabierta y activada: ${s.name}`, 'ok');
                  } else {
                    await setActiveSession(s.id);
                    toast(`Sesión activa: ${s.name}`, 'ok');
                  }
                  navigate('/equipo');
                },
              },
                h('div', { class: 's-name' }, s.name, ' ', statusBadge),
                h('div', { class: 'muted small' },
                  `${s.counter} · ${fmtDateTime(s.createdAt)}`,
                  s.closed && s.closedAt ? ` · Cerrada ${fmtDateTime(s.closedAt)}` : '',
                ),
              ),
              h('div', { class: 'row', style: 'gap: 6px; flex-shrink: 0;' },
                h('button', {
                  class: 'btn sm ghost',
                  title: 'Ver reporte',
                  onclick: (e: Event) => {
                    e.stopPropagation();
                    navigate(`/reporte?session=${s.id}`);
                  },
                }, icon('chart')),
                isCur
                  ? h('button', {
                    class: 'btn sm danger ghost',
                    onclick: async (e: Event) => {
                      e.stopPropagation();
                      if (await confirmDialog('Finalizar sesión', `¿Deseas finalizar la sesión "${s.name}"?`, 'Finalizar sesión', true)) {
                        await closeSession(s.id);
                        toast('Sesión finalizada con éxito', 'ok');
                        navigate('/equipo');
                      }
                    },
                  }, 'Finalizar')
                  : s.closed
                    ? h('button', {
                      class: 'btn sm',
                      onclick: async (e: Event) => {
                        e.stopPropagation();
                        await reopenSession(s.id);
                        toast(`Sesión reabierta y activada: ${s.name}`, 'ok');
                        navigate('/equipo');
                      },
                    }, 'Reabrir')
                    : h('button', {
                      class: 'btn sm',
                      onclick: async (e: Event) => {
                        e.stopPropagation();
                        await setActiveSession(s.id);
                        toast(`Sesión activa: ${s.name}`, 'ok');
                        navigate('/equipo');
                      },
                    }, 'Activar'),
                h('button', {
                  class: 'btn ghost sm danger',
                  'aria-label': 'Eliminar sesión',
                  onclick: async (e: Event) => {
                    e.stopPropagation();
                    if (await confirmDialog('Eliminar sesión', `¿Eliminar "${s.name}" y todos sus conteos?`, 'Eliminar', true)) {
                      await deleteSession(s.id);
                      if (isCur) await setActiveSession(null);
                      toast('Sesión eliminada');
                      navigate('/equipo');
                    }
                  },
                }, icon('trash')),
              ),
            );
          }),
        ),
      ),
    );
  },
};
