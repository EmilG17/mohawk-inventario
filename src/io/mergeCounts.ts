import * as XLSX from 'xlsx';
import {
  allProducts,
  bulkPutProducts,
  countsForSession,
  createSession,
  getActiveSession,
  getDB,
  getSession,
  type CountEntry,
  type Product,
  type Session,
} from '../db/db';
import { APP_ID, type CatalogFile, type CountFile } from './exportResults';
import { normalizeBarcode, parseNumber } from './normalize';

export type AppFile = CountFile | CatalogFile;

export function parseAppFile(text: string): AppFile {
  let data: any;
  try {
    data = JSON.parse(text.replace(/^\ufeff/, ''));
  } catch {
    throw new Error('El archivo no es un archivo de inventario válido (JSON).');
  }
  const validApps = [APP_ID, 'inventario-consumibles'];
  if (!data || !validApps.includes(data.app) || data.version !== 1) {
    throw new Error('El archivo no fue generado por la app de Inventario de Consumibles (Mohawk).');
  }
  if (data.kind === 'conteo') {
    if (!Array.isArray(data.counts) || !data.session) throw new Error('Archivo de conteo incompleto.');
    for (const c of data.counts) {
      if (typeof c.id !== 'string' || typeof c.barcode !== 'string' || typeof c.qty !== 'number') {
        throw new Error('Archivo de conteo con registros inválidos.');
      }
    }
    data.products = Array.isArray(data.products) ? data.products : [];
    return data as CountFile;
  }
  if (data.kind === 'catalogo') {
    if (!Array.isArray(data.products)) throw new Error('Archivo de catálogo incompleto.');
    return data as CatalogFile;
  }
  throw new Error('Tipo de archivo desconocido.');
}

function normKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function getRowField(row: Record<string, any>, aliases: string[]): any {
  const keys = Object.keys(row);
  for (const alias of aliases) {
    const target = normKey(alias);
    const found = keys.find((k) => normKey(k) === target || normKey(k).includes(target));
    if (found !== undefined && row[found] !== undefined && row[found] !== '') {
      return row[found];
    }
  }
  return undefined;
}

/**
 * Parsea un archivo de reporte de técnico en cualquiera de los formatos soportados:
 * - JSON (.json / .conteo.json)
 * - Excel (.xlsx / .xls) generado por la pestaña Reporte o tabla de conteo
 * - CSV (.csv) generado por la pestaña Reporte
 */
export async function parseTechnicianReportBuffer(
  buffer: ArrayBuffer,
  fileName: string,
): Promise<CountFile> {
  const lower = fileName.toLowerCase();
  const baseName = fileName.replace(/\.[^.]+$/, '').replace(/^inventario_|^conteo_/i, '');

  // 1. Intentar como JSON si termina en .json o empieza con '{'
  const firstBytes = new TextDecoder('utf-8').decode(buffer.slice(0, 64)).trim();
  if (lower.endsWith('.json') || firstBytes.startsWith('{')) {
    const text = new TextDecoder('utf-8').decode(buffer);
    const parsed = parseAppFile(text);
    if (parsed.kind !== 'conteo') {
      throw new Error(`${fileName}: es un archivo de catálogo, no un reporte de conteo.`);
    }
    return parsed;
  }

  // 2. Parsear como Workbook Excel (.xlsx / .xls) o CSV (.csv)
  let wb: XLSX.WorkBook;
  try {
    if (lower.endsWith('.csv')) {
      const csvText = new TextDecoder('utf-8').decode(buffer).replace(/^\ufeff/, '');
      wb = XLSX.read(csvText, { type: 'string', raw: false });
    } else {
      wb = XLSX.read(new Uint8Array(buffer), { type: 'array', raw: false });
    }
  } catch {
    throw new Error(`${fileName}: no se pudo leer el archivo Excel/CSV.`);
  }

  let sessionName = baseName || 'Reporte Técnico';
  let defaultCounter = baseName || 'Técnico';

  // Extraer metadatos de la hoja "Resumen" si existe
  if (wb.SheetNames.includes('Resumen')) {
    const wsResumen = wb.Sheets['Resumen'];
    const aoa = XLSX.utils.sheet_to_json<any[]>(wsResumen, { header: 1 });
    for (const row of aoa) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const k = normKey(String(row[0] ?? ''));
      const v = String(row[1] ?? '').trim();
      if (k === 'sesion' && v) sessionName = v;
      if ((k === 'responsable' || k === 'contador' || k === 'tecnico') && v) defaultCounter = v;
    }
  }

  const productsMap = new Map<string, Product>();
  const counts: CountEntry[] = [];

  // Extraer catálogo/productos de "Conteo completo" o primera hoja de datos
  const mainSheetName =
    wb.SheetNames.find((n) => normKey(n).includes('conteocompleto')) ||
    wb.SheetNames.find((n) => normKey(n) !== 'resumen' && !normKey(n).includes('detalle')) ||
    wb.SheetNames[0];

  const mainRows = mainSheetName
    ? XLSX.utils.sheet_to_json<Record<string, any>>(wb.Sheets[mainSheetName], { defval: '' })
    : [];

  for (const r of mainRows) {
    const rawCode = String(
      getRowField(r, ['Código de barras', 'Codigo de barras', 'Barcode', 'Codigo']) ?? '',
    ).trim();
    const rawSku = String(
      getRowField(r, ['No. de parte', 'No de parte', 'SKU', 'Parte']) ?? '',
    ).trim();
    const desc = String(
      getRowField(r, ['Descripción', 'Descripcion', 'Producto', 'Nombre']) ?? '',
    ).trim();
    const unit = String(getRowField(r, ['Unidad', 'UOM', 'UM']) ?? '').trim();
    const expected = parseNumber(
      String(getRowField(r, ['Existencia teórica', 'Existencia teorica', 'Teórico', 'Esperado']) ?? ''),
    );
    const unitCost = parseNumber(
      String(getRowField(r, ['Costo unitario', 'Costo', 'Precio']) ?? ''),
    );

    const barcode = rawCode ? normalizeBarcode(rawCode) : rawSku ? `SKU:${rawSku.toUpperCase()}` : '';
    if (!barcode) continue;

    if (!productsMap.has(barcode)) {
      productsMap.set(barcode, {
        barcode,
        sku: rawSku,
        description: desc,
        unit,
        expectedQty: expected,
        unitCost,
        source: desc ? 'catalogo' : 'pendiente',
      });
    }
  }

  // Si existe la hoja "Detalle de escaneos", extraer cada escaneo individual
  const detailSheetName = wb.SheetNames.find((n) => normKey(n).includes('detalledeescaneos'));
  if (detailSheetName) {
    const detailRows = XLSX.utils.sheet_to_json<Record<string, any>>(wb.Sheets[detailSheetName], {
      defval: '',
    });
    detailRows.forEach((r, idx) => {
      const rawCode = String(
        getRowField(r, ['Código de barras', 'Codigo de barras', 'Barcode', 'Codigo']) ?? '',
      ).trim();
      const desc = String(getRowField(r, ['Descripción', 'Descripcion']) ?? '').trim();
      const qty = parseNumber(String(getRowField(r, ['Cantidad', 'Contado', 'Qty']) ?? ''));
      const counter =
        String(getRowField(r, ['Contador', 'Técnico', 'Tecnico', 'Responsable']) ?? '').trim() ||
        defaultCounter;
      const dev = String(getRowField(r, ['Dispositivo', 'Device']) ?? '').trim() || 'xlsx';
      const dateStr = String(getRowField(r, ['Fecha/hora', 'Fecha']) ?? '').trim();

      if (!rawCode || !qty || qty <= 0) return;
      const barcode = normalizeBarcode(rawCode);

      if (!productsMap.has(barcode) && desc) {
        productsMap.set(barcode, {
          barcode,
          sku: '',
          description: desc,
          unit: '',
          source: 'manual',
        });
      }

      const idSeed = `xlsx_${normKey(fileName)}_${idx}_${barcode}_${normKey(counter)}_${qty}_${normKey(dateStr)}`;
      counts.push({
        id: idSeed,
        sessionId: 'imported',
        barcode,
        qty,
        counter,
        timestamp: Date.now() - (detailRows.length - idx) * 1000,
        deviceId: dev,
      });
    });
  }

  // Si no hubo filas en "Detalle de escaneos" (ej. reporte CSV o hoja resumen de conteo), extraer de mainRows
  if (counts.length === 0 && mainRows.length > 0) {
    mainRows.forEach((r, idx) => {
      const rawCode = String(
        getRowField(r, ['Código de barras', 'Codigo de barras', 'Barcode', 'Codigo']) ?? '',
      ).trim();
      const rawSku = String(
        getRowField(r, ['No. de parte', 'No de parte', 'SKU', 'Parte']) ?? '',
      ).trim();
      const qty = parseNumber(
        String(getRowField(r, ['Contado', 'Cantidad', 'Físico', 'Fisico', 'Conteo']) ?? ''),
      );
      const countersRaw = String(
        getRowField(r, ['Contadores', 'Contador', 'Técnico', 'Tecnico', 'Responsable']) ?? '',
      ).trim();
      const counter = countersRaw || defaultCounter;

      const barcode = rawCode ? normalizeBarcode(rawCode) : rawSku ? `SKU:${rawSku.toUpperCase()}` : '';
      if (!barcode || !qty || qty <= 0) return;

      const idSeed = `sheet_${normKey(fileName)}_${idx}_${barcode}_${normKey(counter)}_${qty}`;
      counts.push({
        id: idSeed,
        sessionId: 'imported',
        barcode,
        qty,
        counter,
        timestamp: Date.now() - (mainRows.length - idx) * 1000,
        deviceId: 'sheet-import',
      });
    });
  }

  if (counts.length === 0) {
    throw new Error(`${fileName}: no se encontraron registros con cantidades contadas (> 0).`);
  }

  return {
    app: APP_ID,
    version: 1,
    kind: 'conteo',
    exportedAt: new Date().toISOString(),
    deviceId: 'report-import',
    session: {
      id: `imp_${Date.now()}`,
      name: sessionName,
      counter: defaultCounter,
      createdAt: Date.now(),
      closed: false,
    },
    counts,
    products: [...productsMap.values()],
  };
}

export async function parseTechnicianReportFile(file: File): Promise<CountFile> {
  const buffer = await file.arrayBuffer();
  return parseTechnicianReportBuffer(buffer, file.name);
}

export interface MergeResult {
  added: number;
  duplicates: number;
  productsAdded: number;
  counters: string[];
}

export interface ReconcileCatalogResult {
  added: number;
  updated: number;
}

/**
 * Concilia una lista de productos entrantes (desde Firebase, archivo importado o catálogo)
 * con el catálogo local en IndexedDB, unificando por código de barras y por SKU,
 * promoviendo productos "no catalogados" cuando aparece su registro oficial y actualizando
 * existencias teóricas, mínimos, máximos, costos y descripciones.
 */
export async function reconcileCatalogProducts(
  incomingProducts: Product[],
): Promise<ReconcileCatalogResult> {
  if (!incomingProducts || incomingProducts.length === 0) {
    return { added: 0, updated: 0 };
  }
  const db = await getDB();
  const localAll = await db.getAll('products');
  const byBarcode = new Map<string, Product>();
  const bySku = new Map<string, Product>();

  for (const lp of localAll) {
    byBarcode.set(lp.barcode, lp);
    if (lp.sku) {
      bySku.set(lp.sku.trim().toUpperCase(), lp);
    }
  }

  const toPut: Product[] = [];
  const toDeleteBarcodes = new Set<string>();
  const barcodeRemap = new Map<string, string>();
  let added = 0;
  let updated = 0;

  for (const p of incomingProducts) {
    if (!p || !p.barcode) continue;
    const skuUpper = (p.sku || '').trim().toUpperCase();
    let local = byBarcode.get(p.barcode);

    // Si no coincidió por barcode directo, verificar si existía como código temporal SKU:... o mismo SKU
    if (!local && skuUpper) {
      const skuMatch = bySku.get(skuUpper) || byBarcode.get(`SKU:${skuUpper}`);
      if (skuMatch && (skuMatch.uncataloged || skuMatch.barcode.startsWith('SKU:'))) {
        local = skuMatch;
      }
    }

    if (!local) {
      toPut.push(p);
      byBarcode.set(p.barcode, p);
      if (skuUpper) bySku.set(skuUpper, p);
      added++;
      continue;
    }

    const incomingIsOfficial = !p.uncataloged && (p.source === 'catalogo' || p.source === 'manual');
    const localIsPending = local.source === 'pendiente' || Boolean(local.uncataloged);

    // Elegir el barcode canónico (preferir el código de barras real frente a un placeholder SKU:...)
    const targetBarcode =
      local.barcode.startsWith('SKU:') && !p.barcode.startsWith('SKU:')
        ? p.barcode
        : p.barcode.startsWith('SKU:') && !local.barcode.startsWith('SKU:')
          ? local.barcode
          : local.barcode;

    if (local.barcode !== targetBarcode) {
      toDeleteBarcodes.add(local.barcode);
      barcodeRemap.set(local.barcode, targetBarcode);
    }
    if (p.barcode !== targetBarcode) {
      barcodeRemap.set(p.barcode, targetBarcode);
    }

    const nextDesc =
      p.description && (localIsPending || incomingIsOfficial || !local.description)
        ? p.description
        : local.description || p.description;

    const nextSource: Product['source'] =
      p.source === 'catalogo' || local.source === 'catalogo'
        ? 'catalogo'
        : local.source === 'pendiente' && p.source !== 'pendiente'
          ? p.source
          : local.source;

    const nextUncataloged =
      p.uncataloged === false || local.uncataloged === false || nextSource === 'catalogo'
        ? false
        : Boolean(local.uncataloged && p.uncataloged);

    const merged: Product = {
      ...local,
      ...p,
      barcode: targetBarcode,
      description: nextDesc,
      sku: p.sku || local.sku,
      unit: p.unit || local.unit,
      expectedQty: p.expectedQty !== undefined ? p.expectedQty : local.expectedQty,
      minQty: p.minQty !== undefined ? p.minQty : local.minQty,
      maxQty: p.maxQty !== undefined ? p.maxQty : local.maxQty,
      unitCost: p.unitCost !== undefined ? p.unitCost : local.unitCost,
      brand: p.brand || local.brand,
      imageUrl: p.imageUrl || local.imageUrl,
      uncataloged: nextUncataloged,
      source: nextSource,
    };

    if (JSON.stringify(merged) !== JSON.stringify(local)) {
      toPut.push(merged);
      byBarcode.set(targetBarcode, merged);
      if (merged.sku) bySku.set(merged.sku.trim().toUpperCase(), merged);
      updated++;
    }
  }

  if (toDeleteBarcodes.size > 0) {
    const txDel = db.transaction('products', 'readwrite');
    for (const oldBc of toDeleteBarcodes) {
      await txDel.store.delete(oldBc);
    }
    await txDel.done;
  }

  if (toPut.length > 0) {
    await bulkPutProducts(toPut, 'merge');
  }

  // Si algún código temporal SKU:... se remapeó a su código de barras oficial, actualizar conteos locales
  if (barcodeRemap.size > 0) {
    const allCounts = await db.getAll('counts');
    const txCounts = db.transaction('counts', 'readwrite');
    for (const c of allCounts) {
      const mapped = barcodeRemap.get(c.barcode);
      if (mapped && mapped !== c.barcode) {
        await txCounts.store.put({ ...c, barcode: mapped });
      }
    }
    await txCounts.done;
  }

  return { added, updated };
}

/**
 * Agrega a la sesión destino los conteos de uno o varios archivos.
 * Cada escaneo conserva su id único por sesión, así que importar el mismo archivo dos veces
 * en la misma sesión no duplica cantidades.
 */
export async function mergeCountFiles(targetSessionId: string, files: CountFile[]): Promise<MergeResult> {
  const db = await getDB();
  const res: MergeResult = { added: 0, duplicates: 0, productsAdded: 0, counters: [] };
  const counters = new Set<string>();

  // Conciliar todos los productos entrantes con el catálogo local
  const incoming = new Map<string, Product>();
  for (const f of files) {
    for (const p of f.products || []) {
      if (p && p.barcode) incoming.set(p.barcode, p);
    }
  }
  const recRes = await reconcileCatalogProducts([...incoming.values()]);
  res.productsAdded = recRes.added + recRes.updated;

  const tx = db.transaction('counts', 'readwrite');
  for (const f of files) {
    const fallbackCounter = f.session?.counter || 'Técnico';
    for (const c of f.counts) {
      const existingDirect = await tx.store.get(c.id);
      const scopedId = `${targetSessionId}__${c.id}`;
      const existingScoped = await tx.store.get(scopedId);

      if (
        (existingDirect && existingDirect.sessionId === targetSessionId) ||
        existingScoped
      ) {
        res.duplicates++;
        continue;
      }

      const finalId = existingDirect ? scopedId : c.id;
      const counterName = c.counter?.trim() || fallbackCounter;
      const entry: CountEntry = {
        ...c,
        id: finalId,
        sessionId: targetSessionId,
        counter: counterName,
      };
      await tx.store.put(entry);
      res.added++;
      if (counterName) counters.add(counterName);
    }
  }
  await tx.done;
  res.counters = [...counters].sort();
  return res;
}

export interface UnifyReportsOptions {
  targetMode: 'new' | 'current';
  newSessionName?: string;
  supervisorName?: string;
  files?: CountFile[];
  sourceSessionIds?: string[];
}

export interface UnifyReportsResult extends MergeResult {
  session: Session;
}

/**
 * Unifica múltiples reportes de técnicos (archivos .xlsx, .csv, .json y/o sesiones locales)
 * en una nueva sesión consolidada o en la sesión activa actual.
 */
export async function unifyTechnicianReports(
  opts: UnifyReportsOptions,
): Promise<UnifyReportsResult> {
  const allFiles: CountFile[] = [...(opts.files ?? [])];
  const products = await allProducts();

  if (opts.sourceSessionIds && opts.sourceSessionIds.length > 0) {
    for (const sid of opts.sourceSessionIds) {
      const s = await getSession(sid);
      if (!s) continue;
      const sCounts = await countsForSession(sid);
      if (!sCounts.length) continue;
      allFiles.push({
        app: APP_ID,
        version: 1,
        kind: 'conteo',
        exportedAt: new Date().toISOString(),
        deviceId: 'local-session',
        session: s,
        counts: sCounts,
        products,
      });
    }
  }

  let targetSession: Session | undefined;
  if (opts.targetMode === 'current') {
    targetSession = await getActiveSession();
  }
  if (!targetSession) {
    const defaultName =
      opts.newSessionName?.trim() ||
      `Reporte Unificado ${new Date().toLocaleDateString('es-MX')}`;
    const sup = opts.supervisorName?.trim() || 'Supervisor';
    targetSession = await createSession(defaultName, sup);
  }

  // Filtrar si por error se incluyó la misma sesión destino como origen
  const filteredFiles = allFiles.filter((f) => f.session?.id !== targetSession!.id);
  const mergeRes = await mergeCountFiles(targetSession.id, filteredFiles);

  return {
    session: targetSession,
    ...mergeRes,
  };
}

export async function importCatalogFile(f: CatalogFile, mode: 'merge' | 'replace'): Promise<number> {
  await bulkPutProducts(f.products, mode);
  return f.products.length;
}

