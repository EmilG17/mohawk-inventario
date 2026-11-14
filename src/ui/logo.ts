import { h } from './dom';

/**
 * Geometría unificada del logotipo Mohawk Inventario:
 * cubo isométrico con esquinas de escaneo (#38bdf8) y código de barras frontal.
 */
export const BRAND_CUBE_SVG_PATHS = `
  <g stroke="#38bdf8" stroke-width="28" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M84 160 V108 A24 24 0 0 1 108 84 H160" />
    <path d="M428 160 V108 A24 24 0 0 0 404 84 H352" />
    <path d="M84 352 V404 A24 24 0 0 0 108 428 H160" />
    <path d="M428 352 V404 A24 24 0 0 1 404 428 H352" />
  </g>
  <path d="M256 120 L372 178 L256 236 L140 178 Z" fill="none" stroke="#ffffff" stroke-width="26" stroke-linejoin="round" />
  <path d="M198 149 L314 207" stroke="#38bdf8" stroke-width="22" stroke-linecap="round" />
  <path d="M140 178 V328 L256 386 L372 328 V178" fill="none" stroke="#ffffff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" />
  <rect x="190" y="254" width="22" height="72" rx="10" fill="#ffffff" />
  <rect x="234" y="260" width="28" height="72" rx="10" fill="#38bdf8" />
  <rect x="284" y="254" width="24" height="72" rx="10" fill="#ffffff" />
`;

/** Crea un elemento HTML con el logotipo vectorial de la aplicación. */
export function createBrandLogo(size = 24, className = 'brand-mark'): HTMLElement {
  const el = h('span', { class: className, 'aria-hidden': 'true' });
  el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" style="display:block;">${BRAND_CUBE_SVG_PATHS}</svg>`;
  return el;
}

/** Genera el SVG autónomo (para favicon e iconos PWA) usando la misma geometría del cubo. */
export function buildStandaloneIconSvg(size = 512): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <defs>
    <linearGradient id="mohawk-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#1e3a5f" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#mohawk-bg)" />${BRAND_CUBE_SVG_PATHS}
</svg>
`;
}
