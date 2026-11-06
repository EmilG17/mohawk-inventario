import {
  bulkPutProducts, getDB, type CountEntry, type Product,
} from '../db/db';
import { APP_ID, type CatalogFile, type CountFile } from './exportResults';

export type AppFile = CountFile | CatalogFile;

export function parseAppFile(text: string): AppFile {
  let data: any;
  try {
    data = JSON.parse(text.replace(/^\ufeff/, ''));
  } catch {
    throw new Error('El archivo no es un archivo de inventario válido (JSON).');
  }
  if (!data || data.app !== APP_ID || data.version !== 1) {
    throw new Error('El archivo no fue generado por la app de Inventario Mohawk.');
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

export interface MergeResult {
  added: number;
  duplicates: number;
  productsAdded: number;
  counters: string[];
}

/**
 * Agrega a la sesión destino los conteos de uno o varios archivos.
 * Cada escaneo conserva su id único, así que importar el mismo archivo dos veces no duplica cantidades.
 */
export async function mergeCountFiles(targetSessionId: string, files: CountFile[]): Promise<MergeResult> {
  const db = await getDB();
  const res: MergeResult = { added: 0, duplicates: 0, productsAdded: 0, counters: [] };
  const counters = new Set<string>();

  // Productos: solo agregar los que no existen localmente o los que localmente están pendientes
  const incoming = new Map<string, Product>();
  for (const f of files) for (const p of f.products) incoming.set(p.barcode, p);
  const toPut: Product[] = [];
  for (const p of incoming.values()) {
    const local = await db.get('products', p.barcode);
    if (!local || (local.source === 'pendiente' && p.source !== 'pendiente')) {
      toPut.push(local ? { ...local, description: p.description, brand: p.brand, imageUrl: p.imageUrl, source: p.source } : p);
    }
  }
  if (toPut.length) await bulkPutProducts(toPut);
  res.productsAdded = toPut.length;

  const tx = db.transaction('counts', 'readwrite');
  for (const f of files) {
    for (const c of f.counts) {
      if (await tx.store.get(c.id)) {
        res.duplicates++;
        continue;
      }
      const entry: CountEntry = { ...c, sessionId: targetSessionId };
      await tx.store.put(entry);
      res.added++;
      if (c.counter) counters.add(c.counter);
    }
  }
  await tx.done;
  res.counters = [...counters].sort();
  return res;
}

export async function importCatalogFile(f: CatalogFile, mode: 'merge' | 'replace'): Promise<number> {
  await bulkPutProducts(f.products, mode);
  return f.products.length;
}
