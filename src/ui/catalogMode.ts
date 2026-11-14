/** Umbral de ancho (en px) debajo del cual el catálogo se bloquea en modo solo lectura (terminal móvil). */
export const MOBILE_CATALOG_BREAKPOINT = 900;

/**
 * Indica si el dispositivo actual está en vista móvil (< 900px), donde la edición,
 * creación, importación o eliminación de productos del catálogo queda deshabilitada
 * para proteger la integridad de la base de datos maestra.
 */
export function isMobileCatalogReadOnly(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.innerWidth === 'number' &&
    window.innerWidth < MOBILE_CATALOG_BREAKPOINT
  );
}
