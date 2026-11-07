import { allSessions, countsForSession, getActiveSession, type Session } from '../db/db';
import type { CountFile } from '../io/exportResults';
import {
  parseTechnicianReportFile,
  unifyTechnicianReports,
} from '../io/mergeCounts';
import { settingsSync } from '../settings';
import { clear, fmtDateTime, fmtNum, h, icon, openDialog, pickFiles, toast } from './dom';
import { navigate } from './router';

interface LoadedFileItem {
  fileName: string;
  countFile: CountFile;
  technicians: string[];
  totalUnits: number;
}

/**
 * Abre el cuadro de diálogo interactivo para unificar reportes de múltiples técnicos
 * (archivos Excel .xlsx, CSV .csv, conteos .json y/o sesiones guardadas en el dispositivo).
 */
export async function openUnifyReportsDialog(
  onUnified?: (sessionId: string) => void,
): Promise<void> {
  const [sessions, activeSession] = await Promise.all([
    allSessions(),
    getActiveSession(),
  ]);

  const sessionCountsMap = new Map<string, { scans: number; units: number; techs: string[] }>();
  for (const s of sessions) {
    const sc = await countsForSession(s.id);
    const techs = [...new Set(sc.map((c) => c.counter || s.counter || 'Técnico'))];
    const units = sc.reduce((acc, c) => acc + c.qty, 0);
    sessionCountsMap.set(s.id, { scans: sc.length, units, techs });
  }

  let loadedFiles: LoadedFileItem[] = [];
  const selectedSessionIds = new Set<string>();
  let targetMode: 'new' | 'current' = 'new';

  const todayStr = new Date().toLocaleDateString('es-MX');
  const sessionNameInput = h('input', {
    class: 'input',
    type: 'text',
    value: `Reporte Unificado ${todayStr}`,
    placeholder: 'Ej. Reporte Unificado Mensual',
  }) as HTMLInputElement;

  const supervisorInput = h('input', {
    class: 'input',
    type: 'text',
    value: settingsSync().counterName || activeSession?.counter || 'Supervisor',
    placeholder: 'Nombre del supervisor o responsable',
  }) as HTMLInputElement;

  const filesListWrap = h('div', { class: 'queue-items-list' });
  const summaryBadge = h('div', { class: 'badge info', style: 'padding: 6px 10px; font-size: 12.5px;' });
  const newSessionFieldsWrap = h(
    'div',
    { class: 'grid2', style: 'margin-top: 8px;' },
    h('label', { class: 'field' }, h('span', null, 'Nombre del reporte unificado'), sessionNameInput),
    h('label', { class: 'field' }, h('span', null, 'Supervisor / Responsable'), supervisorInput),
  );

  const updateSummary = () => {
    const allTechs = new Set<string>();
    let totalScans = 0;
    let totalUnits = 0;

    for (const item of loadedFiles) {
      item.technicians.forEach((t) => allTechs.add(t));
      totalScans += item.countFile.counts.length;
      totalUnits += item.totalUnits;
    }

    for (const sid of selectedSessionIds) {
      const info = sessionCountsMap.get(sid);
      if (info) {
        info.techs.forEach((t) => allTechs.add(t));
        totalScans += info.scans;
        totalUnits += info.units;
      }
    }

    summaryBadge.textContent = `${loadedFiles.length} archivo(s) + ${selectedSessionIds.size} sesión(es) · ${allTechs.size} técnico(s) · ${fmtNum(totalScans)} registro(s) · ${fmtNum(totalUnits)} u. totales`;
  };

  const renderFilesList = () => {
    if (loadedFiles.length === 0) {
      clear(
        filesListWrap,
        h(
          'div',
          { class: 'empty', style: 'padding: 14px; text-align: center;' },
          'Aún no has cargado archivos. Pulsa "Seleccionar archivos de técnicos" arriba para agregar reportes (.xlsx, .csv o .json).',
        ),
      );
      return;
    }

    clear(
      filesListWrap,
      loadedFiles.map((item, idx) =>
        h(
          'div',
          { class: 'queue-item-row' },
          h(
            'div',
            { class: 'queue-item-meta' },
            h('div', { class: 'queue-item-title' }, `📄 ${item.fileName}`),
            h(
              'div',
              { class: 'queue-item-sub' },
              `Técnico(s): ${item.technicians.join(', ')} · ${item.countFile.counts.length} reg. · ${fmtNum(item.totalUnits)} u.`,
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm danger ghost',
              title: 'Quitar archivo',
              onclick: () => {
                loadedFiles.splice(idx, 1);
                renderFilesList();
                updateSummary();
              },
            },
            icon('trash'),
          ),
        ),
      ),
    );
  };

  const handleAddFiles = async () => {
    const picked = await pickFiles(
      '.xlsx,.xls,.csv,.json,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      true,
    );
    if (!picked.length) return;

    const errors: string[] = [];
    let addedCount = 0;

    for (const file of picked) {
      try {
        const countFile = await parseTechnicianReportFile(file);
        const techs = [
          ...new Set(
            countFile.counts
              .map((c) => c.counter?.trim())
              .filter((Boolean as unknown) as (x: string | undefined) => x is string),
          ),
        ];
        if (techs.length === 0 && countFile.session?.counter) {
          techs.push(countFile.session.counter);
        }
        const totalUnits = countFile.counts.reduce((sum, c) => sum + c.qty, 0);
        loadedFiles.push({
          fileName: file.name,
          countFile,
          technicians: techs.length ? techs : ['Técnico'],
          totalUnits,
        });
        addedCount++;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }

    if (errors.length) {
      toast(errors.join('\n'), 'warn', 5000);
    }
    if (addedCount > 0) {
      toast(`${addedCount} reporte(s) de técnico cargado(s)`, 'ok');
    }
    renderFilesList();
    updateSummary();
  };

  renderFilesList();
  updateSummary();

  const localSessionsSection =
    sessions.length > 0
      ? h(
          'section',
          { class: 'sheet-queue-section', style: 'margin-top: 8px;' },
          h(
            'div',
            { class: 'sheet-queue-header' },
            h('h4', { style: 'margin: 0;' }, '📱 Opcional: Incluir sesiones guardadas en este teléfono'),
          ),
          h(
            'div',
            { class: 'queue-items-list', style: 'max-height: 150px; overflow-y: auto;' },
            sessions.map((s: Session) => {
              const info = sessionCountsMap.get(s.id) ?? { scans: 0, units: 0, techs: [] };
              const chk = h('input', {
                type: 'checkbox',
                disabled: info.scans === 0,
                onchange: (e: Event) => {
                  if ((e.target as HTMLInputElement).checked) {
                    selectedSessionIds.add(s.id);
                  } else {
                    selectedSessionIds.delete(s.id);
                  }
                  updateSummary();
                },
              }) as HTMLInputElement;

              return h(
                'label',
                {
                  class: 'queue-item-row',
                  style: `cursor: pointer; ${info.scans === 0 ? 'opacity: 0.5;' : ''}`,
                },
                h(
                  'div',
                  { class: 'row', style: 'gap: 8px; align-items: center; min-width: 0;' },
                  chk,
                  h(
                    'div',
                    { class: 'queue-item-meta' },
                    h('div', { class: 'queue-item-title' }, s.name),
                    h(
                      'div',
                      { class: 'queue-item-sub' },
                      `${s.counter} · ${fmtDateTime(s.createdAt)} · ${info.scans} escaneo(s) (${fmtNum(info.units)} u.)`,
                    ),
                  ),
                ),
              );
            }),
          ),
        )
      : null;

  const modeNewRadio = h('input', {
    type: 'radio',
    name: 'unify-mode',
    value: 'new',
    checked: true,
    onchange: () => {
      targetMode = 'new';
      newSessionFieldsWrap.style.display = 'grid';
    },
  }) as HTMLInputElement;

  const modeCurrentRadio = h('input', {
    type: 'radio',
    name: 'unify-mode',
    value: 'current',
    disabled: !activeSession,
    onchange: () => {
      targetMode = 'current';
      newSessionFieldsWrap.style.display = 'none';
    },
  }) as HTMLInputElement;

  const body = h(
    'div',
    { class: 'form' },
    h(
      'p',
      { class: 'muted small', style: 'margin: 0 0 6px 0;' },
      'Combina los reportes enviados por varios técnicos (Excel .xlsx, CSV .csv o conteo .json) en un solo reporte maestro unificado con desglose por técnico.',
    ),
    h(
      'section',
      { class: 'sheet-queue-section' },
      h(
        'div',
        { class: 'sheet-queue-header' },
        h('h4', { style: 'margin: 0;' }, '📂 Archivos de reportes de técnicos'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn sm primary',
            onclick: handleAddFiles,
          },
          icon('upload'),
          'Seleccionar archivos (.xlsx, .csv, .json)',
        ),
      ),
      filesListWrap,
    ),
    localSessionsSection,
    h(
      'section',
      { class: 'sheet-queue-section', style: 'margin-top: 8px;' },
      h('h4', { style: 'margin: 0 0 6px 0;' }, '🎯 Destino de la unificación'),
      h(
        'label',
        { class: 'check-inline', style: 'margin-bottom: 4px;' },
        modeNewRadio,
        h('span', null, 'Crear un nuevo Reporte Unificado independiente (Recomendado)'),
      ),
      activeSession
        ? h(
            'label',
            { class: 'check-inline' },
            modeCurrentRadio,
            h('span', null, `Sumar directamente en la sesión activa ("${activeSession.name}")`),
          )
        : null,
      newSessionFieldsWrap,
    ),
    h('div', { style: 'margin-top: 6px;' }, summaryBadge),
  );

  openDialog('Unificar reportes de técnicos', body, [
    { label: 'Cancelar' },
    {
      label: 'Unificar y ver reporte',
      kind: 'primary',
      onClick: async () => {
        if (loadedFiles.length === 0 && selectedSessionIds.size === 0) {
          toast('Selecciona al menos un archivo de técnico o una sesión local para unificar', 'warn');
          return true;
        }
        try {
          const res = await unifyTechnicianReports({
            targetMode,
            newSessionName: sessionNameInput.value.trim() || `Reporte Unificado ${todayStr}`,
            supervisorName: supervisorInput.value.trim() || 'Supervisor',
            files: loadedFiles.map((f) => f.countFile),
            sourceSessionIds: [...selectedSessionIds],
          });

          const techLabel = res.counters.length ? ` de ${res.counters.join(', ')}` : '';
          toast(
            `Reporte unificado listo: ${res.added} registro(s) consolidados${techLabel}`,
            'ok',
            5000,
          );
          if (onUnified) {
            onUnified(res.session.id);
          } else {
            navigate(`/reporte?session=${res.session.id}`);
          }
        } catch (err) {
          toast((err as Error).message || 'Error al unificar reportes', 'error');
          return true;
        }
      },
    },
  ]);
}
