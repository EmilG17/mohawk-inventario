import './style.css';
import { bootstrapApp } from './ui/app';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  let reloading = false;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    const pcardVisible = Boolean(document.getElementById('pcard')?.offsetParent);
    if (document.querySelector('dialog[open]') || pcardVisible) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => {
      for (const reg of regs) {
        reg.update().catch(() => {});
      }
    })
    .catch(() => {});
}

bootstrapApp().catch((err) => {
  console.error('Error al iniciar la app:', err);
  const root = document.getElementById('app');
  if (root) {
    const isEn = typeof navigator !== 'undefined' && /^en\b/i.test(navigator.language || '');
    const prefix = isEn ? 'Failed to load application: ' : 'Error al cargar la aplicación: ';
    root.textContent = prefix + (err as Error).message;
  }
});
