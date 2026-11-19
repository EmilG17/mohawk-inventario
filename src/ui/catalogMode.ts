import { settingsSync } from '../settings';

/** Umbral de ancho (en px) debajo del cual el catálogo se bloquea en modo solo lectura (terminal móvil). */
export const MOBILE_CATALOG_BREAKPOINT = 900;

/** Indica si el ancho actual corresponde a una pantalla móvil (< 900px). */
export function isMobileViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.innerWidth === 'number' &&
    window.innerWidth < MOBILE_CATALOG_BREAKPOINT
  );
}

/**
 * Indica si las funciones y controles de Supervisor deben mostrarse en la interfaz.
 * En escritorio/tablet (>= 900px) está activo por defecto salvo que se fije el rol 'technician'.
 * En móvil (< 900px) solo cuando el usuario activa "Modo Supervisor" o su rol es 'supervisor'.
 */
export function isSupervisorModeEnabled(): boolean {
  const s = settingsSync();
  if (s.userRole === 'technician') return false;
  if (s.userRole === 'supervisor') return true;
  if (!isMobileViewport()) return true;
  return Boolean(s.supervisorMode);
}

/** Indica si el dispositivo está explicitamente configurado como Cliente-Técnico restringido. */
export function isStrictTechnicianClient(): boolean {
  return settingsSync().userRole === 'technician';
}

/** Indica si el usuario actual opera como Cliente-Técnico protegido. */
export function isTechnicianRole(): boolean {
  return !isSupervisorModeEnabled();
}

/**
 * Indica si el catálogo debe operar en modo protegido (solo lectura), donde la edición,
 * creación, importación o eliminación masiva de productos queda deshabilitada para
 * proteger la integridad del catálogo maestro frente a manipulaciones de técnicos o terminales móviles.
 */
export function isMobileCatalogReadOnly(): boolean {
  if (isTechnicianRole()) return true;
  return isMobileViewport();
}
