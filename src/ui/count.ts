import {
  addCount, allProducts, countsForSession, deleteCount, findBySku, getActiveSession, getProduct, putCount,
  type CountEntry, type Product, type Session,
} from '../db/db';
import { displayBarcode, normalizeBarcode, parseNumber } from '../io/normalize';
import { resolveDescription, setManualDescription, type ResolveStatus } from '../lookup/lookup';
import { beep, cameraAvailable, createDebouncer, startScanner, unlockAudio, vibrate, type ScannerHandle } from '../scanner/scanner';
import { loadSettings, saveSettings, settingsSync } from '../settings';
import { clear, confirmDialog, fmtNum, fmtTime, h, icon, openDialog, toast } from './dom';
import { newSessionFlow } from './home';
import { editProductDialog, sourceBadge } from './productDialog';
import { navigate, type View } from './router';

interface Pending {
  code: string;
  qty: number;
  product?: Product;
  status: ResolveStatus | 'buscando';
  token: number;
}

let session: Session | undefined;
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
let keyBuffer = '';
let keyLast = 0;
let wantCamera = false;

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
    els.cooldownBadge.innerHTML = `<span class="cooldown-ico">⏸️</span> Pausa: <b>${sec}s</b>`;
  } else if (justFinished) {
    els.videoWrap.classList.remove('cooldown');
    els.cooldownBadge.hidden = false;
    els.cooldownBadge.className = 'cam-cooldown ready';
    els.cooldownBadge.innerHTML = `<span class="cooldown-ico">✓</span> Listo para escanear`;
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
    els.cooldownBadge.innerHTML = `<span class="cooldown-ico">🔒</span> 1 producto a la vez · Confirma abajo`;
  } else {
    els.videoWrap.classList.remove('cooldown', 'locked');
    els.cooldownBadge.hidden = true;
  }
}

export function triggerCooldown(ms = COOLDOWN_MS): void {
  cooldownUntil = Date.now() + ms;
  debounce.reset();
  updateCooldownUi();
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = window.setInterval(() => {
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

// ---------------- cámara ----------------
async function startCamera() {
  if (scanner) return;
  unlockAudio();
  if (!cameraAvailable()) {
    els.camMsg.textContent = window.isSecureContext
      ? 'Este navegador no permite usar la cámara. Usa la captura manual o un lector Bluetooth.'
      : 'La cámara requiere que la app se abra con https://';
    els.videoWrap.classList.add('off');
    return;
  }
  els.camMsg.textContent = 'Iniciando cámara…';
  els.videoWrap.classList.remove('off');
  try {
    scanner = await startScanner(els.video, (text) => onDetected(text));
    wantCamera = true;
    sessionStorage.setItem('camera', '1');
    els.camMsg.textContent = '';
    els.camBtn.replaceChildren(icon('stop'), 'Detener cámara');
    els.torchBtn.hidden = !scanner.torchSupported;
  } catch (e) {
    const err = e as Error;
    scanner = null;
    els.videoWrap.classList.add('off');
    els.camMsg.textContent = err.name === 'NotAllowedError'
      ? 'Permiso de cámara denegado. Habilítalo en la configuración del navegador.'
      : err.name === 'NotFoundError' ? 'No se encontró cámara en este dispositivo.' : `No se pudo iniciar la cámara: ${err.message}`;
  }
}

function stopCamera(remember = true) {
  scanner?.stop();
  scanner = null;
  torchOn = false;
  if (remember) {
    wantCamera = false;
    sessionStorage.removeItem('camera');
  }
  if (els) {
    els.videoWrap.classList.add('off');
    els.camMsg.textContent = 'Cámara apagada';
    els.camBtn.replaceChildren(icon('camera'), 'Activar cámara');
    els.torchBtn.hidden = true;
  }
}

function onVisibility() {
  if (document.hidden) {
    if (scanner) stopCamera(false);
  } else if (wantCamera && !scanner) {
    void startCamera();
  }
}

/** Lectores Bluetooth/USB en modo teclado: teclean rápido y terminan con Enter. */
function onKeydown(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (document.querySelector('dialog[open]')) return;
  if (isScanLocked()) return;
  const now = Date.now();
  if (now - keyLast > 80) keyBuffer = '';
  keyLast = now;
  if (e.key === 'Enter') {
    if (keyBuffer.length >= 4) {
      const code = keyBuffer;
      keyBuffer = '';
      e.preventDefault();
      void processCode(code, 'teclado');
    }
    return;
  }
  if (e.key.length === 1) keyBuffer += e.key;
}

// ---------------- flujo de escaneo ----------------
function onDetected(text: string) {
  if (isScanLocked()) return;
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
  const code = raw.startsWith('SKU:') ? raw : normalizeBarcode(raw);
  if (!code || !session) return;
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
  pending = { code, qty: 1, product: known, status: known?.description ? 'catalogo' : 'buscando', token };

  if (s.quickMode) {
    const entry = await addCount({ sessionId: session.id, barcode: code, qty: 1, counter: session.counter });
    lastQuick = entry;
    triggerCooldown(COOLDOWN_MS);
  }
  renderCard();

  if (!known?.description) {
    const r = await resolveDescription(code);
    if (pending?.token === token) {
      pending.product = r.product;
      pending.status = r.status;
      renderCard();
    }
  } else {
    pending.status = known.source === 'catalogo' ? 'catalogo' : 'encontrado';
    renderCard();
  }
  if (s.quickMode) await renderRecent();
}

let lastQuick: CountEntry | null = null;

async function commitPending(silent = false): Promise<void> {
  if (!pending || !session) return;
  const p = pending;
  pending = null;
  if (settingsSync().quickMode) {
    lastQuick = null;
    renderCard();
    triggerCooldown(COOLDOWN_MS);
    return;
  }
  if (p.qty > 0) {
    await addCount({ sessionId: session.id, barcode: p.code, qty: p.qty, counter: session.counter });
    if (!silent) toast(`Registrado: ${fmtNum(p.qty)} × ${p.product?.description || displayBarcode(p.code)}`, 'ok');
  }
  renderCard();
  await renderRecent();
  triggerCooldown(COOLDOWN_MS);
}

const STATUS_TEXT: Record<Pending['status'], string> = {
  buscando: 'Buscando descripción…',
  catalogo: '',
  encontrado: '',
  manual: '',
  no_encontrado: 'No se encontró la descripción en internet. Escríbela abajo.',
  sin_conexion: 'Sin conexión: se buscará automáticamente al recuperar internet. También puedes escribirla.',
  desactivado: 'Producto no catalogado. Escribe la descripción.',
};

async function alreadyCounted(code: string): Promise<number> {
  if (!session) return 0;
  const all = await countsForSession(session.id);
  return all.filter((c) => c.barcode === code).reduce((a, c) => a + c.qty, 0);
}

function renderCard(): void {
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
  const desc = prod?.description;
  const codeLabel = p.code.startsWith('SKU:') ? p.code.slice(4) : displayBarcode(p.code);

  const descInput = h('input', { class: 'input', placeholder: 'Descripción del producto', maxlength: 200 });
  const saveDesc = async () => {
    const v = descInput.value.trim();
    if (!v) return;
    const saved = await setManualDescription(p.code, v);
    if (pending?.token === p.token) {
      pending.product = saved;
      pending.status = 'manual';
      renderCard();
    }
    toast('Descripción guardada', 'ok');
  };

  const qtyInput = h('input', {
    class: 'input qty', type: 'text', inputmode: 'decimal', value: String(p.qty), 'aria-label': 'Cantidad',
    oninput: () => { const n = parseNumber(qtyInput.value); if (n !== undefined && n >= 0) p.qty = n; },
    onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void commitPending(); } },
    onfocus: () => qtyInput.select(),
  });
  const counted = h('span', null, '…');
  void alreadyCounted(p.code).then((n) => (counted.textContent = fmtNum(n)));

  clear(card,
    h('div', { class: 'pc-head' },
      prod?.imageUrl && navigator.onLine ? h('img', { class: 'thumb', src: prod.imageUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e: Event) => (e.target as HTMLElement).remove() }) : null,
      h('div', { class: 'pc-title' },
        desc
          ? h('div', { class: 'pc-desc' }, desc)
          : h('div', { class: 'pc-desc muted' }, p.status === 'buscando' ? h('span', { class: 'spinner' }) : null, p.status === 'buscando' ? 'Buscando descripción…' : 'Sin descripción'),
        h('div', { class: 'pc-meta' },
          h('code', null, codeLabel),
          prod?.sku ? ` · ${prod.sku}` : '',
          prod?.unit ? ` · ${prod.unit}` : '',
          prod?.brand ? ` · ${prod.brand}` : '',
        ),
        h('div', { class: 'pc-badges' },
          prod ? sourceBadge(prod) : null,
          prod?.uncataloged ? h('span', { class: 'badge warn' }, 'No catalogado') : null,
        ),
      ),
    ),
    !desc && p.status !== 'buscando'
      ? h('div', { class: 'pc-manual' },
        h('p', { class: 'small warn-text' }, STATUS_TEXT[p.status]),
        h('form', { class: 'row', onsubmit: (e: Event) => { e.preventDefault(); void saveDesc(); } },
          descInput, h('button', { class: 'btn', type: 'submit' }, 'Guardar')))
      : null,
    h('div', { class: 'pc-info' },
      h('span', null, 'Ya contado en sesión: ', h('b', null, counted)),
      s.showExpected && prod?.expectedQty !== undefined ? h('span', null, 'Teórico: ', h('b', null, fmtNum(prod.expectedQty))) : null,
    ),
    s.quickMode
      ? h('div', { class: 'row' },
        h('div', { class: 'quick-ok' }, '+1 registrado'),
        h('button', {
          class: 'btn', onclick: async () => {
            if (lastQuick) { await deleteCount(lastQuick.id); lastQuick = null; pending = null; toast('Escaneo deshecho'); renderCard(); await renderRecent(); }
          },
        }, 'Deshacer'),
        h('button', { class: 'btn ghost', onclick: () => editAndRefresh(p.code) }, icon('edit'), 'Producto'),
      )
      : [
        h('div', { class: 'qty-row' },
          h('button', { class: 'btn round', 'aria-label': 'Menos', onclick: () => { p.qty = Math.max(0, Math.round((p.qty - 1) * 1000) / 1000); qtyInput.value = String(p.qty); } }, '−'),
          qtyInput,
          h('button', { class: 'btn round', 'aria-label': 'Más', onclick: () => { p.qty = Math.round((p.qty + 1) * 1000) / 1000; qtyInput.value = String(p.qty); } }, '+'),
        ),
        h('p', { class: 'muted small center' }, 'Confirma la cantidad con + / − y presiona Registrar.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onclick: () => { pending = null; renderCard(); triggerCooldown(COOLDOWN_MS); } }, 'Cancelar'),
          h('button', { class: 'btn ghost', onclick: () => editAndRefresh(p.code) }, icon('edit'), 'Producto'),
          h('button', { class: 'btn primary grow', onclick: () => void commitPending() }, 'Registrar'),
        ),
      ],
  );
}

async function editAndRefresh(code: string) {
  const saved = await editProductDialog(code);
  if (saved && pending?.code === code) {
    pending.product = saved;
    pending.status = saved.description ? (saved.source === 'catalogo' ? 'catalogo' : 'manual') : 'no_encontrado';
    renderCard();
  }
  await renderRecent();
}

async function renderRecent(): Promise<void> {
  if (!session || !els) return;
  const [counts, products] = await Promise.all([countsForSession(session.id), allProducts()]);
  const pMap = new Map(products.map((p) => [p.barcode, p]));
  const distinct = new Set(counts.map((c) => c.barcode)).size;
  els.recentTitle.textContent = `Últimos escaneos · ${distinct} productos · ${counts.length} registros`;
  clear(els.recent,
    counts.length === 0 ? h('li', { class: 'empty' }, 'Aún no hay escaneos en esta sesión.') : null,
    counts.slice(0, 60).map((c) => {
      const p = pMap.get(c.barcode);
      return h('li', { class: 'rec', onclick: () => editEntry(c, p) },
        h('div', { class: 'rec-main' },
          h('div', { class: 'rec-desc' }, p?.description || h('i', { class: 'muted' }, 'Sin descripción')),
          h('div', { class: 'rec-meta' }, h('code', null, c.barcode.startsWith('SKU:') ? c.barcode.slice(4) : displayBarcode(c.barcode)), ` · ${fmtTime(c.timestamp)} · ${c.counter}`),
        ),
        h('div', { class: 'rec-qty' }, fmtNum(c.qty)),
      );
    }),
  );
}

function editEntry(c: CountEntry, p?: Product) {
  const qty = h('input', { class: 'input qty', type: 'text', inputmode: 'decimal', value: String(c.qty) });
  openDialog('Editar escaneo', h('div', { class: 'form' },
    h('p', null, h('b', null, p?.description || 'Sin descripción')),
    h('p', { class: 'muted small' }, displayBarcode(c.barcode), ' · ', fmtTime(c.timestamp), ' · ', c.counter),
    h('label', { class: 'field' }, h('span', null, 'Cantidad'), qty),
  ), [
    {
      label: 'Eliminar', kind: 'danger', onClick: async () => {
        if (await confirmDialog('Eliminar escaneo', '¿Eliminar este registro?', 'Eliminar', true)) {
          await deleteCount(c.id);
          await renderRecent();
          toast('Registro eliminado');
        } else return true;
      },
    },
    { label: 'Producto', onClick: () => { void editAndRefresh(c.barcode); } },
    {
      label: 'Guardar', kind: 'primary', onClick: async () => {
        const n = parseNumber(qty.value);
        if (n === undefined || n < 0) { toast('Cantidad inválida', 'error'); return true; }
        await putCount({ ...c, qty: n });
        await renderRecent();
        toast('Cantidad actualizada', 'ok');
      },
    },
  ]);
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
    toast('Sin coincidencias', 'warn');
    return;
  }
  const dlg = openDialog(`Resultados (${matches.length})`, h('ul', { class: 'pick-list' },
    matches.map((p) => h('li', { onclick: () => { dlg.close(); void processCode(p.barcode, 'manual'); } },
      h('div', null, p.description || 'Sin descripción'),
      h('div', { class: 'muted small' }, p.barcode.startsWith('SKU:') ? '' : displayBarcode(p.barcode), p.sku ? ` · ${p.sku}` : ''),
    )),
    looksLikeCode ? h('li', { onclick: () => { dlg.close(); void processCode(code, 'manual'); } }, h('b', null, `Usar "${q}" como código nuevo`)) : null,
  ), [{ label: 'Cerrar' }]);
}

export const countView: View = {
  title: 'Contar',
  async render(root) {
    await loadSettings();
    session = await getActiveSession();
    if (!session) {
      clear(root, h('section', { class: 'card' },
        h('h2', null, 'No hay sesión activa'),
        h('p', { class: 'muted' }, 'Crea una sesión para empezar a contar.'),
        h('button', { class: 'btn primary xl', onclick: async () => { if (await newSessionFlow()) navigate('/contar'); } }, 'Iniciar conteo'),
      ));
      return;
    }
    const s = settingsSync();
    const video = h('video', { playsinline: true, muted: true, autoplay: true }) as HTMLVideoElement;
    const camMsg = h('div', { class: 'cam-msg' }, 'Cámara apagada');
    const cooldownBadge = h('div', { class: 'cam-cooldown', hidden: true });
    const videoWrap = h('div', { class: 'video-wrap off' }, video, h('div', { class: 'aim' }), cooldownBadge, camMsg);
    const camBtn = h('button', { class: 'btn', onclick: () => (scanner ? stopCamera() : startCamera()) }, icon('camera'), 'Activar cámara') as HTMLButtonElement;
    const torchBtn = h('button', {
      class: 'btn', hidden: true,
      onclick: async () => { if (scanner && (await scanner.setTorch(!torchOn))) { torchOn = !torchOn; torchBtn.classList.toggle('active', torchOn); } },
    }, icon('torch'), 'Linterna') as HTMLButtonElement;
    const quick = h('label', { class: 'switch' },
      h('input', {
        type: 'checkbox', checked: s.quickMode,
        onchange: async (e: Event) => {
          if (pending) await commitPending(true);
          await saveSettings({ quickMode: (e.target as HTMLInputElement).checked });
          toast((e.target as HTMLInputElement).checked ? 'Modo rápido: cada escaneo suma 1' : 'Modo cantidad: confirma cada producto');
          renderCard();
        },
      }),
      h('span', null, 'Modo rápido (+1)'),
    );
    const input = h('input', {
      class: 'input', id: 'code-input', type: 'search', enterkeyhint: 'go', autocomplete: 'off', autocapitalize: 'off',
      placeholder: 'Código, No. de parte o descripción',
    }) as HTMLInputElement;
    const card = h('section', { class: 'card pcard', hidden: true, id: 'pcard' });
    const recentTitle = h('h3', { class: 'section-title' }, 'Últimos escaneos');
    const recent = h('ul', { class: 'recent', id: 'recent' });

    els = { video, camMsg, camBtn, torchBtn, card, recent, recentTitle, input, videoWrap, cooldownBadge };

    clear(root,
      h('div', { class: 'session-bar' },
        h('span', { class: 'muted small' }, 'Sesión: '), h('b', { class: 'small' }, session.name),
        h('span', { class: 'muted small' }, ` · ${session.counter}`),
      ),
      h('section', { class: 'scan-area' },
        videoWrap,
        h('div', { class: 'row cam-controls' }, camBtn, torchBtn, quick),
      ),
      h('form', {
        class: 'row manual', onsubmit: (e: Event) => { e.preventDefault(); unlockAudio(); const v = input.value; input.value = ''; input.blur(); void manualEntry(v); },
      }, input, h('button', { class: 'btn primary', type: 'submit', 'aria-label': 'Buscar' }, icon('search'))),
      card,
      recentTitle,
      recent,
    );

    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('keydown', onKeydown);
    renderCard();
    await renderRecent();
    if (sessionStorage.getItem('camera') === '1') void startCamera();
  },
  async destroy() {
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
    cooldownUntil = 0;
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('keydown', onKeydown);
    stopCamera(false);
    if (pending) await commitPending(true);
    pending = null;
  },
};

/** Para pruebas E2E: simula la lectura de un código por cámara. */
(window as any).__simulateScan = (text: string) => onDetected(text);
(window as any).__getScanState = () => ({
  isLocked: isScanLocked(),
  hasPending: pending !== null,
  cooldownRemaining: Math.max(0, cooldownUntil - Date.now()),
});
