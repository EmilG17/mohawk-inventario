import { renderQrCodeSvg } from '../../barcode/code128';
import type { CountEntry, Session } from '../../db/db';
import { L } from '../../i18n/i18n';
import { mergeCountFiles } from '../../io/mergeCounts';
import {
  buildRoomInviteUrl,
  decodeCompactCountQr,
  encodeCompactCountQrChunks,
} from '../../sync/cloudSync';
import { h, icon, openDialog, toast } from '../dom';

export function openRoomInviteQrDialog(roomCode: string, endpointUrl: string): void {
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
    qrBox.innerHTML = renderQrCodeSvg(inviteUrl, 240, 2);
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
    h('div', { class: 'badge ok', style: 'align-self: center;' }, `${L('Sala en Vivo:', 'Live Room:')} ${roomCode}`),
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

export function openShowMyQrDialog(session: Session, counts: CountEntry[]): void {
  const chunks = encodeCompactCountQrChunks(session, counts, 25);
  let idx = 0;

  const qrBox = h('div', {
    style: 'display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px; background: #fff; border-radius: 12px; border: 1px solid var(--border);',
  });
  const pageLabel = h('div', { class: 'badge info' });

  const renderSlide = () => {
    qrBox.innerHTML = renderQrCodeSvg(chunks[idx], 240, 2);
    pageLabel.textContent =
      chunks.length > 1
        ? L(
            `Código QR ${idx + 1} de ${chunks.length} (${counts.length} lecturas totales)`,
            `QR code ${idx + 1} of ${chunks.length} (${counts.length} total scans)`,
          )
        : L(
            `Código QR listo (${counts.length} lectura${counts.length === 1 ? '' : 's'})`,
            `QR code ready (${counts.length} scan${counts.length === 1 ? '' : 's'})`,
          );
  };
  renderSlide();

  const body = h(
    'div',
    { class: 'form', style: 'text-align: center;' },
    h(
      'p',
      { class: 'muted small', style: 'margin: 0;' },
      L(
        `Pide al supervisor que escanee este código QR desde la pestaña Contar o desde Supervisor → "Recibir por QR" para consolidar los conteos de ${session.counter}.`,
        `Ask the supervisor to scan this QR code from the Count tab or Supervisor → "Receive via QR" to merge ${session.counter}'s counts.`,
      ),
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
            L('Anterior', 'Previous'),
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
            L('Siguiente', 'Next'),
          ),
        )
      : null,
  );

  openDialog(`${L('QR de conteo', 'Count QR')} · ${session.counter}`, body, [{ label: L('Cerrar', 'Close') }]);
}

export function openReceiveQrDialog(activeSession: Session, onMerged: () => void): void {
  const input = h('textarea', {
    class: 'input',
    rows: 3,
    placeholder: L('Escanea el QR con lector o pega aquí el código MHKSYNC1|...', 'Scan QR with a reader or paste MHKSYNC1|... code here'),
  }) as HTMLTextAreaElement;

  const body = h(
    'div',
    { class: 'form' },
    h(
      'p',
      { class: 'muted small', style: 'margin: 0;' },
      L(
        'Puedes escanear directamente el QR del técnico desde la cámara en la pestaña "Contar", con pistola lectora 2D aquí, o pegar el texto del QR:',
        'You can scan the technician QR directly using the camera in the "Count" tab, a 2D barcode gun here, or paste the QR text:',
      ),
    ),
    input,
  );

  openDialog(L('Recibir conteo por QR', 'Receive count via QR'), body, [
    { label: L('Cancelar', 'Cancel') },
    {
      label: L('Consolidar QR', 'Merge QR'),
      kind: 'primary',
      onClick: async () => {
        const val = input.value.trim();
        if (!val) {
          toast(L('Escanea o pega primero el contenido del QR', 'Scan or paste the QR payload first'), 'warn');
          return true;
        }
        try {
          const cf = decodeCompactCountQr(val);
          const res = await mergeCountFiles(activeSession.id, [cf]);
          toast(
            L(
              `QR de ${cf.session.counter} integrado: +${res.added} lectura(s) (${res.duplicates} duplicadas omitidas)`,
              `Merged QR from ${cf.session.counter}: +${res.added} scan(s) (${res.duplicates} duplicates skipped)`,
            ),
            'ok',
            4500,
          );
          onMerged();
        } catch (err) {
          toast((err as Error).message || L('QR inválido', 'Invalid QR'), 'error');
          return true;
        }
      },
    },
  ]);
}
