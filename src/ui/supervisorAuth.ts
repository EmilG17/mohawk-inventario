import { getActiveSession, setActiveSession } from '../db/db';
import { L } from '../i18n/i18n';
import { loadSettings, saveSettings, settingsSync } from '../settings';
import { isMobileViewport, isSupervisorModeEnabled } from './catalogMode';
import { h, icon, openDialog, toast } from './dom';

/**
 * Obtiene el PIN configurado de supervisor (por defecto: '1234').
 */
export function getSupervisorPin(): string {
  return (settingsSync().supervisorPin || '1234').trim();
}

/**
 * Valida si un PIN ingresado coincide con el PIN configurado.
 */
export function verifySupervisorPin(input: string): boolean {
  if (!input) return false;
  return input.trim() === getSupervisorPin();
}

/**
 * Muestra el diálogo moderno con teclado numérico para autenticar al Supervisor en dispositivos móviles.
 */
export function promptSupervisorPin(): Promise<boolean> {
  return new Promise((resolve) => {
    let currentInput = '';
    let resolved = false;

    const dots: HTMLSpanElement[] = [
      h('span', { class: 'pin-dot' }),
      h('span', { class: 'pin-dot' }),
      h('span', { class: 'pin-dot' }),
      h('span', { class: 'pin-dot' }),
    ];

    const dotsWrap = h('div', { class: 'pin-dots-wrap' }, ...dots);
    const errorMsg = h('div', { class: 'pin-error-msg', style: 'min-height: 20px;' });

    const hiddenInput = h('input', {
      type: 'password',
      inputmode: 'numeric',
      pattern: '[0-9]*',
      maxlength: '4',
      class: 'pin-hidden-input',
      autocomplete: 'off',
      autofocus: true,
    }) as HTMLInputElement;

    const updateDots = () => {
      dots.forEach((dot, idx) => {
        if (idx < currentInput.length) {
          dot.classList.add('filled');
        } else {
          dot.classList.remove('filled');
        }
      });
    };

    const trySubmit = () => {
      if (currentInput.length !== 4) return;
      if (verifySupervisorPin(currentInput)) {
        resolved = true;
        dialog.close();
        resolve(true);
      } else {
        dotsWrap.classList.add('pin-shake');
        dots.forEach((d) => d.classList.add('error'));
        errorMsg.textContent = L('PIN incorrecto. Intenta de nuevo.', 'Incorrect PIN. Try again.');
        setTimeout(() => {
          currentInput = '';
          hiddenInput.value = '';
          updateDots();
          dotsWrap.classList.remove('pin-shake');
          dots.forEach((d) => d.classList.remove('error'));
        }, 550);
      }
    };

    hiddenInput.addEventListener('input', () => {
      const sanitized = hiddenInput.value.replace(/\D/g, '').slice(0, 4);
      currentInput = sanitized;
      hiddenInput.value = sanitized;
      updateDots();
      if (currentInput.length === 4) {
        trySubmit();
      }
    });

    const addDigit = (d: string) => {
      if (currentInput.length >= 4) return;
      currentInput += d;
      hiddenInput.value = currentInput;
      updateDots();
      if (currentInput.length === 4) {
        trySubmit();
      }
    };

    const backspace = () => {
      if (currentInput.length > 0) {
        currentInput = currentInput.slice(0, -1);
        hiddenInput.value = currentInput;
        updateDots();
      }
    };

    const keyBtn = (text: string, action: () => void, isAction = false) =>
      h('button', {
        class: `pin-key-btn ${isAction ? 'pin-action-key' : ''}`,
        type: 'button',
        onclick: (e: Event) => {
          e.preventDefault();
          action();
        },
      }, text);

    const keypad = h('div', { class: 'pin-keypad' },
      keyBtn('1', () => addDigit('1')),
      keyBtn('2', () => addDigit('2')),
      keyBtn('3', () => addDigit('3')),
      keyBtn('4', () => addDigit('4')),
      keyBtn('5', () => addDigit('5')),
      keyBtn('6', () => addDigit('6')),
      keyBtn('7', () => addDigit('7')),
      keyBtn('8', () => addDigit('8')),
      keyBtn('9', () => addDigit('9')),
      keyBtn(L('Cancelar', 'Cancel'), () => dialog.close(), true),
      keyBtn('0', () => addDigit('0')),
      keyBtn('⌫', backspace, true),
    );

    const body = h('div', { class: 'pin-modal-body' },
      h('div', { class: 'pin-modal-icon' }, icon('lock')),
      h('p', { class: 'muted small', style: 'text-align: center; margin: 4px 0 12px 0;' },
        L(
          'Ingresa el PIN de 4 dígitos para acceder al Centro de Gestión y separar la sesión de conteo móvil.',
          'Enter the 4-digit PIN to access the Management Center and separate the mobile count session.',
        ),
      ),
      hiddenInput,
      dotsWrap,
      errorMsg,
      keypad,
      h('div', { class: 'pin-hint-text muted xsmall', style: 'text-align:center; margin-top: 10px;' },
        L('PIN por defecto: 1234 (configurable en Ajustes)', 'Default PIN: 1234 (customizable in Settings)'),
      ),
    );

    const dialog = openDialog(L('Acceso al Centro de Supervisor', 'Supervisor Center Access'), body, []);
    dialog.addEventListener('close', () => {
      if (!resolved) resolve(false);
    });

    setTimeout(() => {
      try {
        hiddenInput.focus();
      } catch {}
    }, 100);
  });
}

/**
 * Separa la sesión del técnico y activa la sesión de Supervisor en dispositivos móviles.
 */
export async function switchToSupervisorSession(): Promise<boolean> {
  const current = await getActiveSession();
  const s = await loadSettings();

  const currentId = current?.id || null;
  const savedTechId = s.techSessionId || currentId;

  // Restaurar la sesión previa de supervisor si existía
  if (s.supervisorSessionId && s.supervisorSessionId !== currentId) {
    await setActiveSession(s.supervisorSessionId);
  }

  await saveSettings({
    supervisorMode: true,
    userRole: 'supervisor',
    techSessionId: savedTechId,
  });

  if (typeof document !== 'undefined') {
    document.getElementById('app')?.setAttribute('data-supervisor', 'true');
    toast(L('Centro de Gestión de Supervisor desbloqueado', 'Supervisor Management Center unlocked'), 'ok');
  }
  return true;
}

/**
 * Bloquea la sesión de Supervisor y restaura la sesión del técnico en el dispositivo móvil.
 */
export async function switchToTechnicianSession(): Promise<boolean> {
  const current = await getActiveSession();
  const s = await loadSettings();

  const currentId = current?.id || null;

  // Guardar la sesión actual de supervisor para recuperarla cuando vuelva a entrar
  await saveSettings({
    supervisorMode: false,
    userRole: 'technician',
    supervisorSessionId: currentId,
  });

  // Restaurar la sesión de conteo del técnico si existía
  if (s.techSessionId && s.techSessionId !== currentId) {
    await setActiveSession(s.techSessionId);
  }

  if (typeof document !== 'undefined') {
    document.getElementById('app')?.setAttribute('data-supervisor', 'false');
    toast(L('Sesión de Supervisor bloqueada · Modo Técnico activado', 'Supervisor session locked · Technician mode enabled'), 'info');
  }
  return true;
}

/**
 * Puerta de acceso con PIN: si está en móvil y se intenta entrar a Supervisor, solicita el PIN.
 * Si ya está en Supervisor o en escritorio, no pide PIN.
 */
export async function ensureSupervisorAccess(): Promise<boolean> {
  if (isSupervisorModeEnabled() && !isMobileViewport()) {
    return true;
  }
  if (isSupervisorModeEnabled()) {
    return true;
  }
  const ok = await promptSupervisorPin();
  if (ok) {
    await switchToSupervisorSession();
    return true;
  }
  return false;
}
