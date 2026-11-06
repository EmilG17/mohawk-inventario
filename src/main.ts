import './style.css';
import { bootstrapApp } from './ui/app';

bootstrapApp().catch((err) => {
  console.error('Error al iniciar la app:', err);
  const root = document.getElementById('app');
  if (root) root.textContent = 'Error al cargar la aplicación: ' + (err as Error).message;
});
