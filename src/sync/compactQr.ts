import { uid, type CountEntry, type Session } from '../db/db';
import { APP_ID, type CountFile } from '../io/exportResults';
import { normalizeBarcode } from '../io/normalize';
import { canonicalCountId } from './firebaseKeys';
import { QR_PREFIX } from './types';

function sanitizeIdPart(s: string): string {
  return String(s || '')
    .replace(/[.#$/[\]\s]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'qr';
}

function safeDecode(val: string, fallback: string): string {
  try {
    return decodeURIComponent(val);
  } catch {
    return fallback;
  }
}

export function isCompactCountQr(text: string): boolean {
  return (text || '').trim().startsWith(QR_PREFIX);
}

/**
 * Codifica los conteos de una sesión en uno o varios códigos QR compactos (`MHKSYNC1|...`)
 * para que el supervisor pueda escanearlos directamente desde la pantalla del técnico.
 */
export function encodeCompactCountQrChunks(
  session: Session,
  counts: CountEntry[],
  maxEntriesPerQr = 25,
): string[] {
  const safeSession = encodeURIComponent(session.name || 'Sesion');
  const safeCounter = encodeURIComponent(session.counter || 'Tecnico');
  if (counts.length === 0) {
    return [`${QR_PREFIX}${safeSession}|${safeCounter}|1/1|`];
  }

  const chunks: CountEntry[][] = [];
  for (let i = 0; i < counts.length; i += Math.max(1, maxEntriesPerQr)) {
    chunks.push(counts.slice(i, i + Math.max(1, maxEntriesPerQr)));
  }

  return chunks.map((chunk, idx) => {
    const entriesStr = chunk
      .map((c) => {
        const bc = encodeURIComponent(c.barcode);
        const qty = c.qty;
        const idShort = encodeURIComponent(canonicalCountId(c.id).slice(0, 12));
        const tsSec = Math.floor((c.timestamp || Date.now()) / 1000);
        const who = c.counter && c.counter !== session.counter ? encodeURIComponent(c.counter) : '';
        return `${bc}:${qty}:${idShort}:${tsSec}${who ? `:${who}` : ''}`;
      })
      .join(';');
    return `${QR_PREFIX}${safeSession}|${safeCounter}|${idx + 1}/${chunks.length}|${entriesStr}`;
  });
}

/**
 * Decodifica una cadena `MHKSYNC1|...` escaneada de un QR y devuelve un `CountFile` listo
 * para fusionar mediante `mergeCountFiles`.
 */
export function decodeCompactCountQr(payload: string): CountFile {
  const raw = (payload || '').trim();
  if (!raw.startsWith(QR_PREFIX)) {
    throw new Error('El código QR no corresponde a un reporte de conteo (MHKSYNC1).');
  }
  const body = raw.slice(QR_PREFIX.length);
  const parts = body.split('|');
  if (parts.length < 4) {
    throw new Error('Formato de QR de conteo incompleto.');
  }

  const sessionName = safeDecode(parts[0] || '', 'Sesión QR') || 'Sesión QR';
  const counterName = safeDecode(parts[1] || '', 'Técnico') || 'Técnico';
  const entriesRaw = parts.slice(3).join('|');

  const counts: CountEntry[] = [];
  if (entriesRaw.trim()) {
    for (const item of entriesRaw.split(';')) {
      if (!item.trim()) continue;
      const fields = item.split(':');
      if (fields.length < 2) continue;
      const rawBc = safeDecode(fields[0] || '', fields[0] || '');
      const barcode = rawBc.startsWith('SKU:') ? rawBc : normalizeBarcode(rawBc) || rawBc;
      const qty = Number(fields[1]);
      if (!barcode || !Number.isFinite(qty) || qty === 0) continue;
      const idShort = safeDecode(fields[2] || '', uid().slice(0, 10)) || uid().slice(0, 10);
      const tsSec = Number(fields[3]);
      const timestamp = Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : Date.now();
      const itemCounter = fields[4] ? safeDecode(fields[4], fields[4]) : counterName;

      counts.push({
        id: `qr_${sanitizeIdPart(counterName)}_${sanitizeIdPart(barcode)}_${sanitizeIdPart(idShort)}`,
        sessionId: 'qr-import',
        barcode,
        qty,
        counter: itemCounter,
        deviceId: `qr-${sanitizeIdPart(counterName)}`,
        timestamp,
      });
    }
  }

  return {
    app: APP_ID,
    version: 1,
    kind: 'conteo',
    exportedAt: new Date().toISOString(),
    deviceId: `qr-${sanitizeIdPart(counterName)}`,
    session: {
      id: `qr_${Date.now()}`,
      name: sessionName,
      counter: counterName,
      createdAt: Date.now(),
      closed: false,
    },
    counts,
    products: [],
  };
}
