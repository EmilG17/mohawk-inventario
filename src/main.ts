import './style.css';
import { bootstrapApp } from './ui/app';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
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
  if (root) root.textContent = 'Error al cargar la aplicación: ' + (err as Error).message;
});
