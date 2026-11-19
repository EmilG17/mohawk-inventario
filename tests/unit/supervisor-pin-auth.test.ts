import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession, getActiveSession, getDB, setActiveSession } from '../../src/db/db';
import { loadSettings, saveSettings } from '../../src/settings';
import {
  getSupervisorPin,
  switchToSupervisorSession,
  switchToTechnicianSession,
  verifySupervisorPin,
} from '../../src/ui/supervisorAuth';
import { isSupervisorModeEnabled, isTechnicianRole } from '../../src/ui/catalogMode';
import 'fake-indexeddb/auto';

describe('Supervisor PIN Authentication and Session Separation Suite', () => {
  beforeEach(async () => {
    const db = await getDB();
    await db.clear('sessions');
    await db.clear('meta');
    await saveSettings({
      supervisorMode: false,
      userRole: 'technician',
      supervisorPin: '1234',
      techSessionId: null,
      supervisorSessionId: null,
    });
  });

  afterEach(async () => {
    const db = await getDB();
    await db.clear('sessions');
    await db.clear('meta');
  });

  it('verifica correctamente el PIN de supervisor por defecto y personalizado', async () => {
    expect(getSupervisorPin()).toBe('1234');
    expect(verifySupervisorPin('1234')).toBe(true);
    expect(verifySupervisorPin(' 1234 ')).toBe(true);
    expect(verifySupervisorPin('0000')).toBe(false);
    expect(verifySupervisorPin('')).toBe(false);

    // Personalizar PIN
    await saveSettings({ supervisorPin: '9876' });
    expect(getSupervisorPin()).toBe('9876');
    expect(verifySupervisorPin('9876')).toBe(true);
    expect(verifySupervisorPin('1234')).toBe(false);
  });

  it('separa limpiamente la sesión de técnico de la sesión de supervisor en móvil', async () => {
    // 1. Técnico crea y activa su sesión de conteo
    const techSession = await createSession('Conteo Estantería Norte', 'Técnico Juan');
    await setActiveSession(techSession.id);
    expect((await getActiveSession())?.id).toBe(techSession.id);

    // 2. Supervisor ingresa PIN y cambia a Modo Supervisor
    await switchToSupervisorSession();
    const s1 = await loadSettings();
    expect(s1.supervisorMode).toBe(true);
    expect(s1.userRole).toBe('supervisor');
    expect(s1.techSessionId).toBe(techSession.id);

    // 3. Supervisor crea y activa una sesión general de auditoría
    const supSession = await createSession('Auditoría General Planta', 'Supervisor Carlos');
    await setActiveSession(supSession.id);
    expect((await getActiveSession())?.id).toBe(supSession.id);

    // 4. Supervisor bloquea el terminal para devolvérselo al técnico
    await switchToTechnicianSession();
    const s2 = await loadSettings();
    expect(s2.supervisorMode).toBe(false);
    expect(s2.userRole).toBe('technician');
    expect(s2.supervisorSessionId).toBe(supSession.id);

    // La sesión activa del técnico se restaura automáticamente
    const restoredTechSession = await getActiveSession();
    expect(restoredTechSession?.id).toBe(techSession.id);
    expect(restoredTechSession?.name).toBe('Conteo Estantería Norte');

    // 5. Supervisor vuelve a desbloquear con PIN
    await switchToSupervisorSession();
    // La sesión del supervisor se restaura automáticamente
    const restoredSupSession = await getActiveSession();
    expect(restoredSupSession?.id).toBe(supSession.id);
    expect(restoredSupSession?.name).toBe('Auditoría General Planta');
  });

  it('en móvil (<900px) bloquea el acceso de supervisor aunque userRole sea supervisor si supervisorMode es false', async () => {
    const prevWin = (globalThis as any).window;
    (globalThis as any).window = { ...(prevWin || {}), innerWidth: 390 };
    try {
      await saveSettings({
        userRole: 'supervisor',
        supervisorMode: false,
        supervisorPin: '4321',
      });
      // En móvil nunca debe dar acceso automático por userRole: 'supervisor' sin desbloquear supervisorMode con PIN
      expect(isSupervisorModeEnabled()).toBe(false);
      expect(isTechnicianRole()).toBe(true);
      expect(verifySupervisorPin('1234')).toBe(false);
      expect(verifySupervisorPin('0000')).toBe(false);
      expect(verifySupervisorPin('4321')).toBe(true);

      await switchToSupervisorSession();
      expect(isSupervisorModeEnabled()).toBe(true);

      await switchToTechnicianSession();
      expect(isSupervisorModeEnabled()).toBe(false);
    } finally {
      (globalThis as any).window = prevWin;
    }
  });
});
