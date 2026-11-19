import { allSessions, countsForSession, getActiveSession, type Session } from '../db/db';
import { L, getLocaleTag } from '../i18n/i18n';
import type { CountFile } from '../io/exportResults';
import {
  parseTechnicianReportFile,
  unifyTechnicianReports,
} from '../io/mergeCounts';
import { settingsSync } from '../settings';
import { triggerBackgroundSync } from '../sync/cloudSync';
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
    const techs = [...new Set(sc.map((c) => c.counter || s.counter || L('Técnico', 'Technician')))];
    const units = sc.reduce((acc, c) => acc + c.qty, 0);
    sessionCountsMap.set(s.id, { scans: sc.length, units, techs });
  }

  let loadedFiles: LoadedFileItem[] = [];
  const selectedSessionIds = new Set<string>();
  const sessionCheckboxes = new Map<string, { checkbox: HTMLInputElement; scans: number }>();
  let targetMode: 'new' | 'current' = 'new';

  const todayStr = new Date().toLocaleDateString(getLocaleTag());
  const defaultReportTitle = L(`Reporte Unificado ${todayStr}`, `Unified Report ${todayStr}`);
  const sessionNameInput = h('input', {
    class: 'input',
    type: 'text',
    value: defaultReportTitle,
    placeholder: L('Ej. Reporte Unificado Mensual', 'e.g. Monthly Unified Report'),
  }) as HTMLInputElement;

  const supervisorInput = h('input', {
    class: 'input',
    type: 'text',
    value: settingsSync().counterName || activeSession?.counter || 'Supervisor',
    placeholder: L('Nombre del supervisor o responsable', 'Supervisor or manager name'),
  }) as HTMLInputElement;

  const filesListWrap = h('div', { class: 'queue-items-list' });
  const summaryBadge = h('div', { class: 'badge info', style: 'padding: 6px 10px; font-size: 12.5px;' });
  const newSessionFieldsWrap = h(
    'div',
    { class: 'grid2', style: 'margin-top: 8px;' },
    h('label', { class: 'field' }, h('span', null, L('Nombre del reporte unificado', 'Unified report name')), sessionNameInput),
    h('label', { class: 'field' }, h('span', null, L('Supervisor / Responsable', 'Supervisor / Lead')), supervisorInput),
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

    summaryBadge.textContent = L(
      `${loadedFiles.length} archivo(s) + ${selectedSessionIds.size} sesión(es) · ${allTechs.size} técnico(s) · ${fmtNum(totalScans)} registro(s) · ${fmtNum(totalUnits)} u. totales`,
      `${loadedFiles.length} file(s) + ${selectedSessionIds.size} session(s) · ${allTechs.size} tech(s) · ${fmtNum(totalScans)} record(s) · ${fmtNum(totalUnits)} total units`,
    );
  };

  const renderFilesList = () => {
    if (loadedFiles.length === 0) {
      clear(
        filesListWrap,
        h(
          'div',
          { class: 'empty', style: 'padding: 14px; text-align: center;' },
          L(
            'Aún no has cargado archivos. Pulsa "Seleccionar archivos (.xlsx, .csv, .json)" arriba para agregar reportes.',
            'No files uploaded yet. Click "Select files (.xlsx, .csv, .json)" above to add reports.',
          ),
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
            h('div', { class: 'queue-item-title' }, item.fileName),
            h(
              'div',
              { class: 'queue-item-sub' },
              L(
                `Técnico(s): ${item.technicians.join(', ')} · ${item.countFile.counts.length} reg. · ${fmtNum(item.totalUnits)} u.`,
                `Tech(s): ${item.technicians.join(', ')} · ${item.countFile.counts.length} rec. · ${fmtNum(item.totalUnits)} u.`,
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm danger ghost',
              title: L('Quitar archivo', 'Remove file'),
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
          technicians: techs.length ? techs : [L('Técnico', 'Technician')],
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
      toast(
        L(`${addedCount} reporte(s) de técnico cargado(s)`, `${addedCount} technician report(s) loaded`),
        'ok',
      );
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
            h('h4', { style: 'margin: 0;' }, L('Opcional: Incluir sesiones guardadas en este dispositivo', 'Optional: Include sessions saved on this device')),
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
              sessionCheckboxes.set(s.id, { checkbox: chk, scans: info.scans });

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
                      `${s.counter} · ${fmtDateTime(s.createdAt)} · ${info.scans} ${L('escaneo(s)', 'scan(s)')} (${fmtNum(info.units)} u.)`,
                    ),
                  ),
                ),
              );
            }),
          ),
        )
      : null;

  const syncTargetSessionCheck = () => {
    if (!activeSession) return;
    const entry = sessionCheckboxes.get(activeSession.id);
    if (!entry) return;
    if (targetMode === 'current') {
      entry.checkbox.checked = false;
      entry.checkbox.disabled = true;
      selectedSessionIds.delete(activeSession.id);
    } else {
      entry.checkbox.disabled = entry.scans === 0;
    }
    updateSummary();
  };

  const modeNewRadio = h('input', {
    type: 'radio',
    name: 'unify-mode',
    value: 'new',
    checked: true,
    onchange: () => {
      targetMode = 'new';
      newSessionFieldsWrap.style.display = 'grid';
      syncTargetSessionCheck();
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
      syncTargetSessionCheck();
    },
  }) as HTMLInputElement;

  const body = h(
    'div',
    { class: 'form' },
    h(
      'p',
      { class: 'muted small', style: 'margin: 0 0 6px 0;' },
      L(
        'Combina los reportes enviados por varios técnicos (Excel .xlsx, CSV .csv o conteo .json) en un solo reporte maestro unificado con desglose por técnico.',
        'Combine reports sent by multiple technicians (Excel .xlsx, CSV .csv, or count .json) into a single unified master report with per-tech breakdown.',
      ),
    ),
    h(
      'section',
      { class: 'sheet-queue-section' },
      h(
        'div',
        { class: 'sheet-queue-header' },
        h('h4', { style: 'margin: 0;' }, L('Archivos de reportes de técnicos', 'Technician report files')),
        h(
          'button',
          {
            type: 'button',
            class: 'btn sm primary',
            onclick: handleAddFiles,
          },
          icon('upload'),
          L('Seleccionar archivos (.xlsx, .csv, .json)', 'Select files (.xlsx, .csv, .json)'),
        ),
      ),
      filesListWrap,
    ),
    localSessionsSection,
    h(
      'section',
      { class: 'sheet-queue-section', style: 'margin-top: 8px;' },
      h('h4', { style: 'margin: 0 0 6px 0;' }, L('Destino de la unificación', 'Unification target')),
      h(
        'label',
        { class: 'check-inline', style: 'margin-bottom: 4px;' },
        modeNewRadio,
        h('span', null, L('Crear un nuevo Reporte Unificado independiente (Recomendado)', 'Create a new standalone Unified Report (Recommended)')),
      ),
      activeSession
        ? h(
            'label',
            { class: 'check-inline' },
            modeCurrentRadio,
            h('span', null, L(`Sumar directamente en la sesión activa ("${activeSession.name}")`, `Merge directly into the active session ("${activeSession.name}")`)),
          )
        : null,
      newSessionFieldsWrap,
    ),
    h('div', { style: 'margin-top: 6px;' }, summaryBadge),
  );

  openDialog(L('Unificar reportes de técnicos', 'Unify technician reports'), body, [
    { label: L('Cancelar', 'Cancel') },
    {
      label: L('Unificar y ver reporte', 'Unify & view report'),
      kind: 'primary',
      onClick: async () => {
        const filteredSessionIds =
          targetMode === 'current' && activeSession
            ? [...selectedSessionIds].filter((sid) => sid !== activeSession.id)
            : [...selectedSessionIds];

        if (loadedFiles.length === 0 && filteredSessionIds.length === 0) {
          toast(
            L(
              'Selecciona al menos un archivo de técnico o una sesión local distinta para unificar',
              'Select at least one technician file or another local session to unify',
            ),
            'warn',
          );
          return true;
        }
        try {
          const res = await unifyTechnicianReports({
            targetMode,
            newSessionName: sessionNameInput.value.trim() || defaultReportTitle,
            supervisorName: supervisorInput.value.trim() || 'Supervisor',
            files: loadedFiles.map((f) => f.countFile),
            sourceSessionIds: filteredSessionIds,
          });

          triggerBackgroundSync(res.session.id);

          const techLabel = res.counters.length ? ` (${res.counters.join(', ')})` : '';
          toast(
            L(
              `Reporte unificado listo: ${res.added} registro(s) consolidados${techLabel}`,
              `Unified report ready: ${res.added} record(s) consolidated${techLabel}`,
            ),
            'ok',
            5000,
          );
          if (onUnified) {
            onUnified(res.session.id);
          } else {
            navigate(`/reporte?session=${res.session.id}`);
          }
        } catch (err) {
          toast((err as Error).message || L('Error al unificar reportes', 'Failed to unify reports'), 'error');
          return true;
        }
      },
    },
  ]);
}
