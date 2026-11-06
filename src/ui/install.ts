let deferred: any = null;

export function initInstall(onChange: () => void): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    onChange();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    onChange();
  });
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}

export function installState(): { canPrompt: boolean; iosHint: boolean } {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return { canPrompt: !!deferred && !isStandalone(), iosHint: ios && !isStandalone() };
}

export async function promptInstall(): Promise<void> {
  if (!deferred) return;
  deferred.prompt();
  await deferred.userChoice.catch(() => undefined);
  deferred = null;
}
