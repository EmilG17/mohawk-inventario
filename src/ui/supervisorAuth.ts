import { getActiveSession, getSession, setActiveSession } from '../db/db';
import { L } from '../i18n/i18n';
import { loadSettings, saveSettings, settingsSync } from '../settings';
import { isMobileViewport, isSupervisorModeEnabled } from './catalogMode';
import { h, icon, openDialog, toast } from './dom';

const MOBILE_PIN_SESSION_KEY = 'mhk_mobile_pin_verified';

export function isMobilePinSessionVerified(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(MOBILE_PIN_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearMobilePinSession(): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(MOBILE_PIN_SESSION_KEY);
    }
  } catch {}
}

export function isValidSupervisorPin(pin: string): boolean {
  return /^\d{4}$/.test(String(pin || '').trim());
}

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

function dispatchAuthEvents(role: 'supervisor' | 'technician'): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent('mhk:rolechange', { detail: { role } }));
  window.dispatchEvent(new CustomEvent('mhk:sessionchange'));
}

/**
 * Muestra el diálogo moderno con teclado numérico para autenticar al Supervisor en dispositivos móviles.
 */
export function promptSupervisorPin(): Promise<boolean> {
  void loadSettings();
  return new Promise((resolve) => {
    let currentInput = '';
    let resolved = false;
    let isResetting = false;
    let shakeTimer: ReturnType<typeof setTimeout> | null = null;
    let focusTimer: ReturnType<typeof setTimeout> | null = null;

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
      'aria-label': L('PIN de Supervisor de 4 dígitos', '4-digit Supervisor PIN'),
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
      if (isResetting || resolved || currentInput.length !== 4) return;
      if (verifySupervisorPin(currentInput)) {
        resolved = true;
        try {
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem(MOBILE_PIN_SESSION_KEY, '1');
          }
        } catch {}
        dialog.close();
        resolve(true);
      } else {
        isResetting = true;
        dotsWrap.classList.add('pin-shake');
        dots.forEach((d) => d.classList.add('error'));
        errorMsg.textContent = L('PIN incorrecto. Intenta de nuevo.', 'Incorrect PIN. Try again.');
        shakeTimer = setTimeout(() => {
          shakeTimer = null;
          isResetting = false;
          currentInput = '';
          hiddenInput.value = '';
          updateDots();
          dotsWrap.classList.remove('pin-shake');
          dots.forEach((d) => d.classList.remove('error'));
        }, 550);
      }
    };

    hiddenInput.addEventListener('input', () => {
      if (isResetting || resolved) {
        hiddenInput.value = currentInput;
        return;
      }
      const sanitized = hiddenInput.value.replace(/\D/g, '').slice(0, 4);
      currentInput = sanitized;
      hiddenInput.value = sanitized;
      if (sanitized.length > 0 && errorMsg.textContent) errorMsg.textContent = '';
      updateDots();
      if (currentInput.length === 4) {
        trySubmit();
      }
    });

    const addDigit = (d: string) => {
      if (isResetting || resolved || currentInput.length >= 4) return;
      if (errorMsg.textContent) errorMsg.textContent = '';
      currentInput += d;
      hiddenInput.value = currentInput;
      updateDots();
      if (currentInput.length === 4) {
        trySubmit();
      }
    };

    const backspace = () => {
      if (isResetting || resolved) return;
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
      h('p', { class: 'muted small pin-modal-desc' },
        L(
          'Ingresa el PIN de 4 dígitos para acceder al Centro de Gestión y separar la sesión de conteo móvil.',
          'Enter the 4-digit PIN to access the Management Center and separate the mobile count session.',
        ),
      ),
      hiddenInput,
      dotsWrap,
      errorMsg,
      keypad,
      h('div', { class: 'pin-hint-text muted xsmall' },
        L('Configura o cambia tu PIN en Ajustes', 'Configure or change your PIN in Settings'),
      ),
    );

    const dialog = openDialog(L('Acceso al Centro de Supervisor', 'Supervisor Center Access'), body, []);

    const onDialogKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.activeElement === hiddenInput) {
        if (e.key === 'Enter' && currentInput.length === 4) {
          e.preventDefault();
          trySubmit();
        }
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        addDigit(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        backspace();
      } else if (e.key === 'Enter' && currentInput.length === 4) {
        e.preventDefault();
        trySubmit();
      }
    };
    dialog.addEventListener('keydown', onDialogKeyDown);

    dialog.addEventListener('close', () => {
      dialog.removeEventListener('keydown', onDialogKeyDown);
      if (shakeTimer) {
        clearTimeout(shakeTimer);
        shakeTimer = null;
      }
      if (focusTimer) {
        clearTimeout(focusTimer);
        focusTimer = null;
      }
      if (!resolved) resolve(false);
    });

    const isCoarsePointer =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;

    if (!isCoarsePointer) {
      focusTimer = setTimeout(() => {
        focusTimer = null;
        try {
          hiddenInput.focus();
        } catch {}
      }, 100);
    }
  });
}

/**
 * Separa la sesión del técnico y activa la sesión de Supervisor en dispositivos móviles.
 */
export async function switchToSupervisorSession(): Promise<boolean> {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(MOBILE_PIN_SESSION_KEY, '1');
    }
  } catch {}
  const s = await loadSettings();
  if (s.userRole === 'supervisor' && s.supervisorMode === true) {
    if (typeof document !== 'undefined') {
      document.getElementById('app')?.setAttribute('data-supervisor', 'true');
    }
    dispatchAuthEvents('supervisor');
    return true;
  }

  const current = await getActiveSession();
  const currentId = current && !current.closed ? current.id : null;
  const savedTechId = currentId ?? s.techSessionId ?? null;

  let nextSupId: string | null = s.supervisorSessionId || null;
  if (s.supervisorSessionId && s.supervisorSessionId !== currentId) {
    const supSess = await getSession(s.supervisorSessionId);
    if (supSess && !supSess.closed) {
      await setActiveSession(supSess.id);
      nextSupId = supSess.id;
    } else {
      nextSupId = null;
    }
  }

  await saveSettings({
    supervisorMode: true,
    userRole: 'supervisor',
    techSessionId: savedTechId,
    supervisorSessionId: nextSupId,
  });

  if (typeof document !== 'undefined') {
    document.getElementById('app')?.setAttribute('data-supervisor', 'true');
    toast(L('Centro de Gestión de Supervisor desbloqueado', 'Supervisor Management Center unlocked'), 'ok');
  }
  dispatchAuthEvents('supervisor');
  return true;
}

/**
 * Bloquea la sesión de Supervisor y restaura la sesión del técnico en el dispositivo móvil.
 */
export async function switchToTechnicianSession(): Promise<boolean> {
  clearMobilePinSession();
  const s = await loadSettings();
  if (s.userRole === 'technician' && s.supervisorMode === false) {
    if (typeof document !== 'undefined') {
      document.getElementById('app')?.setAttribute('data-supervisor', 'false');
    }
    dispatchAuthEvents('technician');
    return true;
  }

  const current = await getActiveSession();
  const currentId = current && !current.closed ? current.id : null;

  const nextSupId =
    currentId && currentId !== s.techSessionId ? currentId : (s.supervisorSessionId || null);

  let nextTechId: string | null = s.techSessionId || null;
  if (s.techSessionId) {
    const techSess = await getSession(s.techSessionId);
    if (techSess && !techSess.closed) {
      if (techSess.id !== currentId) {
        await setActiveSession(techSess.id);
      }
      nextTechId = techSess.id;
    } else {
      nextTechId = null;
    }
  }

  await saveSettings({
    supervisorMode: false,
    userRole: 'technician',
    supervisorSessionId: nextSupId,
    techSessionId: nextTechId,
  });

  if (typeof document !== 'undefined') {
    document.getElementById('app')?.setAttribute('data-supervisor', 'false');
    toast(L('Sesión de Supervisor bloqueada · Modo Técnico activado', 'Supervisor session locked · Technician mode enabled'), 'info');
  }
  dispatchAuthEvents('technician');
  return true;
}

/**
 * Puerta de acceso con PIN: si está en móvil y se intenta entrar a Supervisor, solicita el PIN.
 * Si ya está en Supervisor, no pide PIN.
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
