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
 * En escritorio/tablet (>= 900px) siempre está activo; en móvil (< 900px) solo cuando
 * el usuario activa explícitamente "Modo Supervisor".
 */
export function isSupervisorModeEnabled(): boolean {
  if (!isMobileViewport()) return true;
  return Boolean(settingsSync().supervisorMode);
}

/**
 * Indica si el dispositivo actual está en vista móvil (< 900px), donde la edición,
 * creación, importación o eliminación de productos del catálogo queda deshabilitada
 * para proteger la integridad de la base de datos maestra.
 */
export function isMobileCatalogReadOnly(): boolean {
  return isMobileViewport();
}
