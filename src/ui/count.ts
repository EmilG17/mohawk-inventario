import {
  addCount, allProducts, closeSession, countsForSession, deleteCount, findBySku, getActiveSession, getProduct, putCount,
  type CountEntry, type Product, type Session,
} from '../db/db';
import { L } from '../i18n/i18n';
import { getIdealLevels } from '../db/movements';
import { mergeCountFiles } from '../io/mergeCounts';
import { displayBarcode, normalizeBarcode, parseNumber } from '../io/normalize';
import { resolveDescription, setManualDescription, type ResolveStatus } from '../lookup/lookup';
import { beep, cameraAvailable, createDebouncer, startScanner, unlockAudio, vibrate, type ScannerHandle } from '../scanner/scanner';
import { createWedgeController } from '../scanner/wedge';
import { loadSettings, saveSettings, settingsSync } from '../settings';
import {
  archiveSessionToCloud,
  decodeCompactCountQr,
  isCompactCountQr,
  onCloudRoomUpdate,
  publishLiveScannerState,
  triggerBackgroundSync,
} from '../sync/cloudSync';
import { computeRoomDataSig } from './cloudSignal';
import { clear, confirmDialog, fmtNum, fmtTime, h, icon, openDialog, toast } from './dom';
import { isMobileCatalogReadOnly, isSupervisorModeEnabled } from './catalogMode';
import { newSessionFlow } from './home';
import { editProductDialog, sourceBadge } from './productDialog';
import { navigate, type View } from './router';

interface Pending {
  code: string;
  qty: number;
  product?: Product;
  status: ResolveStatus | 'buscando';
  token: number;
  origin?: 'camara' | 'teclado' | 'manual';
}

let session: Session | undefined;
let countIdealLevels: Record<string, number> = {};
let scanner: ScannerHandle | null = null;
let torchOn = false;
let pending: Pending | null = null;
let tokenSeq = 0;
let els: {
  video: HTMLVideoElement; camMsg: HTMLElement; camBtn: HTMLButtonElement; torchBtn: HTMLButtonElement;
  card: HTMLElement; recent: HTMLElement; recentTitle: HTMLElement; input: HTMLInputElement; videoWrap: HTMLElement;
  cooldownBadge: HTMLElement;
};
const debounce = createDebouncer(1500);
let wantCamera = false;
let unsubscribeCountCloud: (() => void) | null = null;
let viewMounted = false;
let countRenderSeq = 0;
let cameraAttemptSeq = 0;
let countCloudTimer: ReturnType<typeof setTimeout> | null = null;
let lastCountDataFp = '';
const wedge = createWedgeController({
  minLength: 4,
  maxIntervalMs: 80,
  isBlocked: () => Boolean(document.querySelector('dialog[open]')) || isScanLocked(),
  onScan: (code) => {
    void processCode(code, 'teclado');
  },
});

const COOLDOWN_MS = 2000;
let cooldownUntil = 0;
let cooldownTimer: number | null = null;

export function isScanLocked(): boolean {
  // 1) Solo un producto a la vez: si hay un producto en tarjeta sin confirmar en modo normal, bloquear escáner
  if (pending !== null && !settingsSync().quickMode) {
    return true;
  }
  // 2) Pausa forzosa de 2 segundos antes de permitir volver a escanear
  if (Date.now() < cooldownUntil) {
    return true;
  }
  return false;
}

function updateCooldownUi(justFinished = false): void {
  if (!els?.cooldownBadge || !els?.videoWrap) return;
  const s = settingsSync();
  const now = Date.now();
  const remaining = cooldownUntil - now;

  if (remaining > 0) {
    els.videoWrap.classList.add('cooldown');
    els.videoWrap.classList.remove('locked');
    els.cooldownBadge.hidden = false;
    els.cooldownBadge.className = 'cam-cooldown active';
    const sec = (remaining / 1000).toFixed(1);
    els.cooldownBadge.innerHTML = `<span class="cooldown-ico">II</span> ${L('Pausa:', 'Pause:')} <b>${sec}s</b>`;
  } else if (justFinished) {
    els.videoWrap.classList.remove('cooldown');
    els.cooldownBadge.hidden = false;
    els.cooldownBadge.className = 'cam-cooldown ready';
    els.cooldownBadge.innerHTML = `<span class="cooldown-ico">✓</span> ${L('Listo para escanear', 'Ready to scan')}`;
    setTimeout(() => {
      if (Date.now() >= cooldownUntil && (!pending || s.quickMode)) {
        if (els?.cooldownBadge) els.cooldownBadge.hidden = true;
      }
    }, 450);
  } else if (pending && !s.quickMode) {
    els.videoWrap.classList.add('locked');
    els.videoWrap.classList.remove('cooldown');
    els.cooldownBadge.hidden = false;
    els.cooldownBadge.className = 'cam-cooldown locked';
    els.cooldownBadge.innerHTML = `<span class="cooldown-ico">●</span> ${L('1 producto a la vez · Confirma abajo', '1 product at a time · Confirm below')}`;
  } else {
    els.videoWrap.classList.remove('cooldown', 'locked');
    els.cooldownBadge.hidden = true;
  }
}

function triggerCooldown(ms = COOLDOWN_MS): void {
  if (!viewMounted) return;
  cooldownUntil = Date.now() + ms;
  debounce.reset();
  updateCooldownUi();
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = window.setInterval(() => {
    if (!viewMounted) {
      if (cooldownTimer) clearInterval(cooldownTimer);
      cooldownTimer = null;
      return;
    }
    const remaining = cooldownUntil - Date.now();
    if (remaining <= 0) {
      if (cooldownTimer) clearInterval(cooldownTimer);
      cooldownTimer = null;
      cooldownUntil = 0;
      updateCooldownUi(true);
    } else {
      updateCooldownUi();
    }
  }, 100);
}

// ---------------- telemetría en vivo ----------------
function emitScannerState(
  status: 'scanning' | 'pending_confirm' | 'registered' | 'idle',
  extra?: {
    barcode?: string;
    sku?: string;
    description?: string;
    qty?: number;
    origin?: 'camara' | 'teclado' | 'manual';
  },
): void {
  void publishLiveScannerState({
    status,
    cameraOn: Boolean(scanner),
    sessionName: session?.name,
    counter: session?.counter,
    ...extra,
  });
}

// ---------------- cámara ----------------
async function startCamera() {
  if (scanner || !viewMounted) return;
  const attempt = ++cameraAttemptSeq;
  unlockAudio();
  if (!cameraAvailable()) {
    els.camMsg.textContent = window.isSecureContext
      ? L('Este navegador no permite usar la cámara. Usa la captura manual o un lector Bluetooth.', 'This browser cannot access the camera. Use manual entry or a Bluetooth scanner.')
      : L('La cámara requiere que la app se abra con https://', 'Camera requires opening the app over https://');
    els.videoWrap.classList.add('off');
    return;
  }
  els.camMsg.textContent = L('Iniciando cámara…', 'Starting camera…');
  els.videoWrap.classList.remove('off');
  try {
    const started = await startScanner(els.video, (text) => onDetected(text));
    if (!viewMounted || attempt !== cameraAttemptSeq) {
      try { started.stop(); } catch {}
      return;
    }
    scanner = started;
    wantCamera = true;
    sessionStorage.setItem('camera', '1');
    els.camMsg.textContent = '';
    els.camBtn.replaceChildren(icon('stop'), L('Detener cámara', 'Stop camera'));
    els.torchBtn.hidden = !scanner.torchSupported;
    emitScannerState(
      pending ? 'pending_confirm' : 'scanning',
      pending
        ? {
            barcode: pending.code,
            sku: pending.product?.sku || pending.code,
            description: pending.product?.description,
            qty: pending.qty,
            origin: pending.origin,
          }
        : { origin: 'camara' },
    );
  } catch (e) {
    if (!viewMounted || attempt !== cameraAttemptSeq) return;
    const err = e as Error;
    scanner = null;
    els.videoWrap.classList.add('off');
    els.camMsg.textContent = err.name === 'NotAllowedError'
      ? L('Permiso de cámara denegado. Habilítalo en la configuración del navegador.', 'Camera permission denied. Enable it in browser settings.')
      : err.name === 'NotFoundError' ? L('No se encontró cámara en este dispositivo.', 'No camera found on this device.') : `${L('No se pudo iniciar la cámara:', 'Could not start camera:')} ${err.message}`;
  }
}

function stopCamera(remember = true) {
  cameraAttemptSeq++;
  scanner?.stop();
  scanner = null;
  torchOn = false;
  if (remember) {
    wantCamera = false;
    sessionStorage.removeItem('camera');
  }
  if (els) {
    els.videoWrap.classList.add('off');
    els.camMsg.textContent = L('Escáner físico listo · Cámara apagada', 'Hardware scanner ready · Camera off');
    els.camBtn.replaceChildren(icon('camera'), L('Activar cámara', 'Start camera'));
    els.torchBtn.hidden = true;
  }
  if (viewMounted) {
    emitScannerState(
      pending ? 'pending_confirm' : 'idle',
      pending
        ? {
            barcode: pending.code,
            sku: pending.product?.sku || pending.code,
            description: pending.product?.description,
            qty: pending.qty,
            origin: pending.origin,
          }
        : undefined,
    );
  }
}

function onVisibility() {
  if (document.hidden) {
    if (scanner) stopCamera(false);
  } else if (wantCamera && !scanner) {
    void startCamera();
  }
}

// ---------------- flujo de escaneo ----------------
function onDetected(text: string) {
  if (isScanLocked()) return;
  if (isCompactCountQr(text)) {
    if (!debounce(text)) return;
    void processCode(text, 'camara');
    return;
  }
  const code = normalizeBarcode(text);
  if (!code || !debounce(code)) return;
  void processCode(code, 'camara');
}

function feedback(kind: 'ok' | 'warn') {
  const s = settingsSync();
  if (s.beep) beep(kind);
  if (s.vibrate) vibrate(kind);
  els.videoWrap.classList.remove('flash-ok', 'flash-warn');
  void els.videoWrap.offsetWidth;
  els.videoWrap.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-warn');
}

export async function processCode(raw: string, origin: 'camara' | 'teclado' | 'manual'): Promise<void> {
  if (!session) return;
  if (isCompactCountQr(raw)) {
    try {
      const cf = decodeCompactCountQr(raw);
      const res = await mergeCountFiles(session.id, [cf]);
      feedback('ok');
      toast(
        L(
          `QR de ${cf.session.counter} consolidado: +${res.added} lectura(s) (${res.duplicates} duplicadas omitidas)`,
          `QR from ${cf.session.counter} merged: +${res.added} scan(s) (${res.duplicates} duplicates skipped)`,
        ),
        'ok',
        4500,
      );
      await renderRecent();
      triggerBackgroundSync(session.id);
    } catch (err) {
      toast((err as Error).message || L('Error al leer QR de técnico', 'Failed to read technician QR'), 'error');
    }
    return;
  }

  const code = raw.startsWith('SKU:') ? raw : normalizeBarcode(raw);
  if (!code) return;
  const s = settingsSync();

  // Escaneo 1 a 1: ignorar nuevas lecturas de cámara/lector si está bloqueado o en pausa
  if (origin !== 'manual') {
    if (isScanLocked()) return;
  } else {
    // Si viene de entrada manual y había un producto pendiente, guardarlo antes de cambiar
    if (pending && !s.quickMode) {
      await commitPending(true);
    }
  }

  const known = await getProduct(code);
  feedback(known && !known.uncataloged ? 'ok' : 'warn');

  const token = ++tokenSeq;
  pending = { code, qty: 1, product: known, status: known?.description ? 'catalogo' : 'buscando', token, origin };

  if (s.quickMode) {
    const entry = await addCount({ sessionId: session.id, barcode: code, qty: 1, counter: session.counter });
    lastQuick = entry;
    emitScannerState('registered', {
      barcode: code,
      sku: known?.sku || code,
      description: known?.description,
      qty: 1,
      origin,
    });
    triggerCooldown(COOLDOWN_MS);
    triggerBackgroundSync(session.id);
  } else {
    emitScannerState('pending_confirm', {
      barcode: code,
      sku: known?.sku || code,
      description: known?.description,
      qty: 1,
      origin,
    });
  }
  renderCard();

  if (!known?.description) {
    const r = await resolveDescription(code);
    if (!viewMounted) return;
    if (pending?.token === token) {
      pending.product = r.product;
      pending.status = r.status;
      if (!s.quickMode) {
        emitScannerState('pending_confirm', {
          barcode: code,
          sku: r.product?.sku || code,
          description: r.product?.description,
          qty: pending.qty,
          origin,
        });
      }
      renderCard();
    }
  } else if (viewMounted && pending?.token === token) {
    pending.status = known.source === 'catalogo' ? 'catalogo' : 'encontrado';
    renderCard();
  }
  if (s.quickMode && viewMounted) await renderRecent();
}

let lastQuick: CountEntry | null = null;

async function commitPending(silent = false, skipUi = false): Promise<void> {
  if (!pending || !session) return;
  const p = pending;
  pending = null;
  if (settingsSync().quickMode) {
    lastQuick = null;
    if (!skipUi && viewMounted) {
      triggerCooldown(COOLDOWN_MS);
      renderCard();
    }
    return;
  }
  if (!skipUi && viewMounted) triggerCooldown(COOLDOWN_MS);
  if (p.qty > 0) {
    await addCount({ sessionId: session.id, barcode: p.code, qty: p.qty, counter: session.counter });
    if (!silent) toast(`${L('Registrado:', 'Recorded:')} ${fmtNum(p.qty)} × ${p.product?.description || displayBarcode(p.code)}`, 'ok');
    if (!skipUi) {
      emitScannerState('registered', {
        barcode: p.code,
        sku: p.product?.sku || p.code,
        description: p.product?.description,
        qty: p.qty,
        origin: p.origin,
      });
    }
    triggerBackgroundSync(session.id);
  }
  if (!skipUi && viewMounted) {
    renderCard();
    await renderRecent();
  }
}

function getStatusText(status: Pending['status']): string {
  switch (status) {
    case 'buscando':
      return L('Buscando descripción…', 'Looking up description…');
    case 'no_encontrado':
      return L('No se encontró la descripción en internet. Escríbela abajo.', 'Description not found online. Enter it below.');
    case 'sin_conexion':
      return L('Sin conexión: se buscará automáticamente al recuperar internet. También puedes escribirla.', 'Offline: will look up automatically when back online. You can also enter it below.');
    case 'desactivado':
      return L('Producto no catalogado. Escribe la descripción.', 'Uncataloged product. Enter description.');
    default:
      return '';
  }
}

async function alreadyCounted(code: string): Promise<number> {
  if (!session) return 0;
  const all = await countsForSession(session.id);
  return all.filter((c) => c.barcode === code).reduce((a, c) => a + c.qty, 0);
}

function renderCard(): void {
  if (!viewMounted || !els?.card) return;
  const card = els.card;
  if (!pending) {
    clear(card);
    card.hidden = true;
    updateCooldownUi();
    return;
  }
  card.hidden = false;
  updateCooldownUi();
  const p = pending;
  const prod = p.product;
  const s = settingsSync();
  const supervisorUI = isSupervisorModeEnabled();
  const desc = prod?.description;
  const codeLabel = p.code.startsWith('SKU:') ? p.code.slice(4) : displayBarcode(p.code);

  const emitPendingQty = () => {
    emitScannerState('pending_confirm', {
      barcode: p.code,
      sku: p.product?.sku || p.code,
      description: p.product?.description,
      qty: p.qty,
      origin: p.origin,
    });
  };

  const descInput = h('input', { class: 'input', placeholder: L('Descripción del producto', 'Product description'), maxlength: 200 });
  const saveDesc = async () => {
    if (isMobileCatalogReadOnly()) return;
    const v = descInput.value.trim();
    if (!v) return;
    const saved = await setManualDescription(p.code, v);
    if (pending?.token === p.token) {
      pending.product = saved;
      pending.status = 'manual';
      renderCard();
    }
    toast(L('Descripción guardada', 'Description saved'), 'ok');
  };

  const qtyInput = h('input', {
    class: 'input qty', type: 'text', inputmode: 'decimal', value: String(p.qty), 'aria-label': L('Cantidad', 'Quantity'),
    oninput: () => {
      const n = parseNumber(qtyInput.value);
      if (n !== undefined && n >= 0) {
        p.qty = n;
        emitPendingQty();
      }
    },
    onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void commitPending(); } },
    onfocus: () => qtyInput.select(),
  });
  const counted = h('span', null, '…');
  void alreadyCounted(p.code).then((n) => (counted.textContent = fmtNum(n)));
  const skuKey = (prod?.sku || '').trim().toUpperCase();
  const codeKey = p.code.trim().toUpperCase();
  const idealVal =
    (skuKey && countIdealLevels[skuKey] !== undefined ? countIdealLevels[skuKey] : undefined) ??
    (codeKey && countIdealLevels[codeKey] !== undefined ? countIdealLevels[codeKey] : undefined) ??
    prod?.expectedQty ??
    prod?.maxQty;

  clear(card,
    h('div', { class: 'pc-head' },
      prod?.imageUrl && navigator.onLine ? h('img', { class: 'thumb', src: prod.imageUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e: Event) => (e.target as HTMLElement).remove() }) : null,
      h('div', { class: 'pc-title' },
        desc
          ? h('div', { class: 'pc-desc' }, desc)
          : h('div', { class: 'pc-desc muted' }, p.status === 'buscando' ? h('span', { class: 'spinner' }) : null, p.status === 'buscando' ? L('Buscando descripción…', 'Looking up description…') : L('Sin descripción', 'No description')),
        h('div', { class: 'pc-meta' },
          h('code', null, codeLabel),
          prod?.sku ? ` · ${prod.sku}` : '',
          prod?.unit ? ` · ${prod.unit}` : '',
          prod?.brand ? ` · ${prod.brand}` : '',
        ),
        h('div', { class: 'pc-badges' },
          prod ? sourceBadge(prod) : null,
          prod?.uncataloged ? h('span', { class: 'badge warn' }, L('No catalogado', 'Uncataloged')) : null,
        ),
      ),
    ),
    !desc && p.status !== 'buscando' && !isMobileCatalogReadOnly()
      ? h('div', { class: 'pc-manual' },
        h('p', { class: 'small warn-text' }, getStatusText(p.status)),
        h('form', { class: 'row', onsubmit: (e: Event) => { e.preventDefault(); void saveDesc(); } },
          descInput, h('button', { class: 'btn', type: 'submit' }, L('Guardar', 'Save'))))
      : null,
    h('div', { class: 'pc-info' },
      h('span', null, L('Ya contado en sesión: ', 'Already counted in session: '), h('b', null, counted)),
      s.showExpected && idealVal !== undefined ? h('span', { 'data-testid': 'count-ideal-info' }, 'Ideal: ', h('b', null, fmtNum(idealVal))) : null,
    ),
    s.quickMode
      ? h('div', { class: 'row' },
        h('div', { class: 'quick-ok' }, L('+1 registrado', '+1 recorded')),
        h('button', {
          class: 'btn', onclick: async () => {
            if (lastQuick) {
              await deleteCount(lastQuick.id);
              triggerBackgroundSync(session?.id);
              lastQuick = null;
              pending = null;
              emitScannerState(scanner ? 'scanning' : 'idle');
              toast(L('Escaneo deshecho', 'Scan undone'));
              renderCard();
              await renderRecent();
            }
          },
        }, L('Deshacer', 'Undo')),
        supervisorUI
          ? h('button', { class: 'btn ghost', onclick: () => editAndRefresh(p.code) }, icon('edit'), L('Producto', 'Product'))
          : null,
      )
      : [
        h('div', { class: 'qty-row' },
          h('button', { class: 'btn round', 'aria-label': L('Menos', 'Decrease'), onclick: () => { p.qty = Math.max(0, Math.round((p.qty - 1) * 1000) / 1000); qtyInput.value = String(p.qty); emitPendingQty(); } }, '−'),
          qtyInput,
          h('button', { class: 'btn round', 'aria-label': L('Más', 'Increase'), onclick: () => { p.qty = Math.round((p.qty + 1) * 1000) / 1000; qtyInput.value = String(p.qty); emitPendingQty(); } }, '+'),
        ),
        h('div', { class: 'qty-quick-chips', 'aria-label': L('Incremento rápido', 'Quick increment') },
          [5, 10, 25].map((step) =>
            h('button', {
              class: 'chip sm',
              type: 'button',
              'data-testid': `count-quick-plus-${step}`,
              onclick: () => {
                p.qty = Math.round((p.qty + step) * 1000) / 1000;
                qtyInput.value = String(p.qty);
                emitPendingQty();
              },
            }, `+${step}`),
          ),
        ),
        h('p', { class: 'muted small center' }, L('Confirma la cantidad con + / − y presiona Registrar.', 'Confirm quantity with + / − and press Record.')),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onclick: () => { pending = null; emitScannerState(scanner ? 'scanning' : 'idle'); renderCard(); triggerCooldown(COOLDOWN_MS); } }, L('Cancelar', 'Cancel')),
          supervisorUI
            ? h('button', { class: 'btn ghost', onclick: () => editAndRefresh(p.code) }, icon('edit'), L('Producto', 'Product'))
            : null,
          h('button', { class: 'btn primary grow', onclick: () => void commitPending() }, L('Registrar', 'Record')),
        ),
      ],
  );
}

async function editAndRefresh(code: string) {
  const saved = await editProductDialog(code);
  if (saved === 'deleted') {
    if (pending?.code === code) {
      pending = null;
      renderCard();
      triggerCooldown(COOLDOWN_MS);
    }
  } else if (saved && pending?.code === code) {
    pending.product = saved;
    pending.status = saved.description ? (saved.source === 'catalogo' ? 'catalogo' : 'manual') : 'no_encontrado';
    renderCard();
  }
  await renderRecent();
}

async function renderRecent(): Promise<void> {
  if (!viewMounted || !session || !els) return;
  const [counts, products] = await Promise.all([countsForSession(session.id), allProducts()]);
  if (!viewMounted || !session || !els) return;
  const pMap = new Map(products.map((p) => [p.barcode, p]));
  const distinct = new Set(counts.map((c) => c.barcode)).size;
  els.recentTitle.textContent = L(`Últimos escaneos · ${distinct} productos · ${counts.length} registros`, `Recent scans · ${distinct} products · ${counts.length} entries`);
  clear(els.recent,
    counts.length === 0 ? h('li', { class: 'empty' }, L('Aún no hay escaneos en esta sesión.', 'No scans in this session yet.')) : null,
    counts.slice(0, 60).map((c) => {
      const p = pMap.get(c.barcode);
      return h('li', { class: 'rec', onclick: () => editEntry(c, p) },
        h('div', { class: 'rec-main' },
          h('div', { class: 'rec-desc' }, p?.description || h('i', { class: 'muted' }, L('Sin descripción', 'No description'))),
          h('div', { class: 'rec-meta' }, h('code', null, c.barcode.startsWith('SKU:') ? c.barcode.slice(4) : displayBarcode(c.barcode)), ` · ${fmtTime(c.timestamp)} · ${c.counter}`),
        ),
        h('div', { class: 'rec-qty' }, fmtNum(c.qty)),
      );
    }),
  );
}

function editEntry(c: CountEntry, p?: Product) {
  const qty = h('input', { class: 'input qty', type: 'text', inputmode: 'decimal', value: String(c.qty) });
  const actions: { label: string; kind?: 'primary' | 'danger'; onClick: () => boolean | void | Promise<boolean | void> }[] = [
    {
      label: L('Eliminar', 'Delete'), kind: 'danger', onClick: async () => {
        if (await confirmDialog(L('Eliminar escaneo', 'Delete scan'), L('¿Eliminar este registro?', 'Delete this entry?'), L('Eliminar', 'Delete'), true)) {
          await deleteCount(c.id);
          triggerBackgroundSync(session?.id);
          await renderRecent();
          toast(L('Registro eliminado', 'Entry deleted'));
        } else return true;
      },
    },
    ...(isSupervisorModeEnabled()
      ? [{ label: L('Producto', 'Product'), onClick: () => { void editAndRefresh(c.barcode); } }]
      : []),
    {
      label: L('Guardar', 'Save'), kind: 'primary', onClick: async () => {
        const n = parseNumber(qty.value);
        if (n === undefined || n < 0) { toast(L('Cantidad inválida', 'Invalid quantity'), 'error'); return true; }
        await putCount({ ...c, qty: n, timestamp: Date.now() });
        triggerBackgroundSync(session?.id);
        await renderRecent();
        toast(L('Cantidad actualizada', 'Quantity updated'), 'ok');
      },
    },
  ];
  openDialog(L('Editar escaneo', 'Edit scan'), h('div', { class: 'form' },
    h('p', null, h('b', null, p?.description || L('Sin descripción', 'No description'))),
    h('p', { class: 'muted small' }, displayBarcode(c.barcode), ' · ', fmtTime(c.timestamp), ' · ', c.counter),
    h('label', { class: 'field' }, h('span', null, L('Cantidad', 'Quantity')), qty),
  ), actions);
  setTimeout(() => qty.select(), 50);
}

/** Captura manual: código, SKU o búsqueda por descripción. */
async function manualEntry(text: string) {
  const q = text.trim();
  if (!q) return;
  const code = normalizeBarcode(q);
  if (await getProduct(code)) return processCode(code, 'manual');
  const bySku = (await findBySku(q)) ?? (await findBySku(q.toUpperCase()));
  if (bySku) return processCode(bySku.barcode, 'manual');
  if (await getProduct('SKU:' + q.toUpperCase())) return processCode('SKU:' + q.toUpperCase(), 'manual');

  const words = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/);
  const matches = (await allProducts())
    .filter((p) => {
      const hay = `${p.description} ${p.sku} ${p.brand ?? ''}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return words.every((w) => hay.includes(w));
    })
    .slice(0, 30);
  const looksLikeCode = /^[A-Za-z0-9\-.]{4,}$/.test(q);
  if (!matches.length) {
    if (looksLikeCode) return processCode(code, 'manual');
    toast(L('Sin coincidencias', 'No matches'), 'warn');
    return;
  }
  const dlg = openDialog(`${L('Resultados', 'Results')} (${matches.length})`, h('ul', { class: 'pick-list' },
    matches.map((p) => h('li', { onclick: () => { dlg.close(); void processCode(p.barcode, 'manual'); } },
      h('div', null, p.description || L('Sin descripción', 'No description')),
      h('div', { class: 'muted small' }, p.barcode.startsWith('SKU:') ? '' : displayBarcode(p.barcode), p.sku ? ` · ${p.sku}` : ''),
    )),
    looksLikeCode ? h('li', { onclick: () => { dlg.close(); void processCode(code, 'manual'); } }, h('b', null, L(`Usar "${q}" como código nuevo`, `Use "${q}" as new code`))) : null,
  ), [{ label: L('Cerrar', 'Close') }]);
}

export const countView: View = {
  title: () => L('Contar', 'Count'),
  async render(root) {
    const seq = ++countRenderSeq;
    viewMounted = true;
    lastCountDataFp = '';
    await loadSettings();
    if (!viewMounted || seq !== countRenderSeq) return;
    session = await getActiveSession();
    if (!viewMounted || seq !== countRenderSeq) return;
    if (!session) {
      clear(root, h('section', { class: 'card idle-gate' },
        h('div', { class: 'badge warn', style: 'margin-bottom: 8px; display: inline-block;' }, L('Sin sesión activa', 'No active session')),
        h('h2', null, L('No hay sesión activa', 'No active session')),
        h('p', { class: 'muted' }, L('Para comenzar a escanear códigos de barras o registrar cantidades físicas, necesitas una sesión de conteo abierta.', 'To start scanning barcodes or recording physical counts, you need an open counting session.')),
        h('button', { class: 'btn primary xl', onclick: async () => { if (await newSessionFlow()) navigate('/contar'); } },
          icon('scan'), L('Iniciar nueva sesión', 'Start new session')),
        h('div', { class: 'row wrap', style: 'margin-top: 10px;' },
          h('button', { class: 'btn', onclick: () => navigate('/equipo') }, icon('users'), L('Seleccionar o reanudar sesión', 'Select or resume session')),
          h('button', { class: 'btn ghost', onclick: () => navigate('/catalogo') }, icon('list'), L('Ver catálogo de productos', 'View product catalog')),
        ),
      ));
      return;
    }
    const s = settingsSync();
    countIdealLevels = await getIdealLevels();
    if (!viewMounted || seq !== countRenderSeq) return;
    const supervisorUI = isSupervisorModeEnabled();
    const video = h('video', { playsinline: true, muted: true, autoplay: true }) as HTMLVideoElement;
    const camMsg = h('div', { class: 'cam-msg' }, L('Escáner físico listo · Cámara apagada', 'Hardware scanner ready · Camera off'));
    const cooldownBadge = h('div', { class: 'cam-cooldown', hidden: true });
    const videoWrap = h('div', { class: 'video-wrap off' }, video, h('div', { class: 'aim' }), cooldownBadge, camMsg);
    const camBtn = h('button', { class: 'btn', onclick: () => (scanner ? stopCamera() : startCamera()) }, icon('camera'), L('Activar cámara', 'Start camera')) as HTMLButtonElement;
    const torchBtn = h('button', {
      class: 'btn', hidden: true,
      onclick: async () => { if (scanner && (await scanner.setTorch(!torchOn))) { torchOn = !torchOn; torchBtn.classList.toggle('active', torchOn); } },
    }, icon('torch'), L('Linterna', 'Flashlight')) as HTMLButtonElement;
    const quick = h('label', { class: 'switch' },
      h('input', {
        type: 'checkbox', checked: s.quickMode,
        onchange: async (e: Event) => {
          if (pending) await commitPending(true);
          await saveSettings({ quickMode: (e.target as HTMLInputElement).checked });
          toast((e.target as HTMLInputElement).checked ? L('Modo rápido: cada escaneo suma 1', 'Quick mode: each scan adds 1') : L('Modo cantidad: confirma cada producto', 'Quantity mode: confirm each product'));
          renderCard();
        },
      }),
      h('span', null, L('Modo rápido (+1)', 'Quick mode (+1)')),
    );
    const input = h('input', {
      class: 'input', id: 'code-input', type: 'search', enterkeyhint: 'go', autocomplete: 'off', autocapitalize: 'off',
      placeholder: L('Código, No. de parte o descripción', 'Barcode, Part #, or description'),
    }) as HTMLInputElement;
    const card = h('section', { class: 'card pcard', hidden: true, id: 'pcard' });
    const recentTitle = h('h3', { class: 'section-title' }, L('Últimos escaneos', 'Recent scans'));
    const recent = h('ul', { class: 'recent', id: 'recent' });

    els = { video, camMsg, camBtn, torchBtn, card, recent, recentTitle, input, videoWrap, cooldownBadge };

    clear(root,
      h('div', { class: 'session-bar' },
        h('div', { class: 'session-info' },
          h('span', { class: 'muted small' }, L('Sesión: ', 'Session: ')), h('b', { class: 'small' }, session.name),
          h('span', { class: 'muted small' }, ` · ${session.counter}`),
        ),
        h('div', { class: 'session-bar-actions' },
          supervisorUI
            ? h('span', {
                class: 'badge info scanner-ready-badge',
                title: L('Lector físico USB/Bluetooth listo automáticamente en esta pantalla', 'USB/Bluetooth hardware scanner ready automatically on this screen'),
              }, L('Escáner USB/BT', 'USB/BT Scanner'))
            : null,
          h('button', {
            class: 'btn ghost sm',
            type: 'button',
            'data-testid': 'count-goto-kardex',
            onclick: () => navigate('/movimientos'),
          }, icon('swap'), 'Kardex'),
          supervisorUI
            ? h('button', {
                class: 'btn ghost sm',
                type: 'button',
                'data-testid': 'count-goto-report',
                onclick: () => navigate('/reporte'),
              }, icon('chart'), L('Reporte', 'Report'))
            : null,
          h('button', {
            class: 'btn ghost sm danger',
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog(
                L('Finalizar sesión de conteo', 'Close counting session'),
                L(
                  `¿Deseas finalizar la sesión "${session?.name}"? Los datos quedarán guardados y no habrá sesión activa hasta que inicies una nueva o decidas reabrirla.`,
                  `Close session "${session?.name}"? Data will stay saved and no session will be active until you start or reopen one.`,
                ),
                L('Finalizar sesión', 'Close session'),
                true,
              );
              if (ok && session) {
                stopCamera(true);
                if (pending) await commitPending(true);
                await closeSession(session.id);
                void archiveSessionToCloud(session.id).catch(() => {});
                toast(L('Sesión finalizada con éxito', 'Session closed'), 'ok');
                navigate('/');
              }
            },
          }, L('Finalizar sesión', 'Close session')),
        ),
      ),
      h('section', { class: 'card scan-workspace-card' },
        h('div', { class: 'scan-area' },
          videoWrap,
          h('div', { class: 'row cam-controls' }, camBtn, torchBtn, quick),
        ),
        h('form', {
          class: 'row manual', onsubmit: (e: Event) => { e.preventDefault(); unlockAudio(); const v = input.value; input.value = ''; input.blur(); void manualEntry(v); },
        }, input, h('button', { class: 'btn primary', type: 'submit', 'aria-label': L('Buscar', 'Search') }, icon('search'))),
      ),
      card,
      h('section', { class: 'card list-card' },
        recentTitle,
        recent,
      ),
    );

    if (!viewMounted || seq !== countRenderSeq) return;
    if (unsubscribeCountCloud) unsubscribeCountCloud();
    if (countCloudTimer) {
      clearTimeout(countCloudTimer);
      countCloudTimer = null;
    }
    unsubscribeCountCloud = onCloudRoomUpdate((roomState) => {
      if (!viewMounted || !session || !els) return;
      if (roomState) {
        const nextFp = computeRoomDataSig(roomState);
        if (nextFp && nextFp === lastCountDataFp) return;
        lastCountDataFp = nextFp;
      }
      if (countCloudTimer) clearTimeout(countCloudTimer);
      countCloudTimer = setTimeout(() => {
        countCloudTimer = null;
        if (!viewMounted || !session || !els) return;
        void getIdealLevels().then((lv) => {
          if (!viewMounted) return;
          countIdealLevels = lv;
          if (pending) renderCard();
        });
        void renderRecent();
      }, 0);
    });
    document.addEventListener('visibilitychange', onVisibility);
    wedge.attach();
    renderCard();
    await renderRecent();
    if (viewMounted && seq === countRenderSeq && sessionStorage.getItem('camera') === '1') void startCamera();
  },
  async destroy() {
    viewMounted = false;
    countRenderSeq++;
    cameraAttemptSeq++;
    if (countCloudTimer) {
      clearTimeout(countCloudTimer);
      countCloudTimer = null;
    }
    if (unsubscribeCountCloud) {
      unsubscribeCountCloud();
      unsubscribeCountCloud = null;
    }
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
    cooldownUntil = 0;
    document.removeEventListener('visibilitychange', onVisibility);
    wedge.detach();
    stopCamera(false);
    if (pending) await commitPending(true, true);
    pending = null;
    void publishLiveScannerState({
      status: 'idle',
      cameraOn: false,
      sessionName: session?.name,
      counter: session?.counter,
    });
  },
};

/** Para pruebas E2E: simula la lectura de un código por cámara. */
if (typeof window !== 'undefined') {
  (window as any).__simulateScan = (text: string) => onDetected(text);
  (window as any).__getScanState = () => ({
    isLocked: isScanLocked(),
    hasPending: pending !== null,
    cooldownRemaining: Math.max(0, cooldownUntil - Date.now()),
  });
}

