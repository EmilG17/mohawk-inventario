import { describe, expect, it } from 'vitest';
import { countsForSession, createSession } from '../../src/db/db';
import type { CountFile } from '../../src/io/exportResults';
import { mergeCountFiles, parseAppFile } from '../../src/io/mergeCounts';

describe('mergeCountFiles', () => {
  it('combina conteos de varios dispositivos sin duplicar al importar dos veces', async () => {
    const session = await createSession('Inventario Mohawk Consolidado', 'Supervisor');

    const fileA: CountFile = {
      app: 'mohawk-inventario',
      version: 1,
      kind: 'conteo',
      exportedAt: new Date().toISOString(),
      deviceId: 'dev-A',
      session: { id: 'sa', name: 'Sesion A', counter: 'Juan', createdAt: 1, closed: false },
      counts: [
        { id: 'scan-1', sessionId: 'sa', barcode: '00071153000108', qty: 10, counter: 'Juan', deviceId: 'dev-A', timestamp: 100 },
        { id: 'scan-2', sessionId: 'sa', barcode: '00071153000108', qty: 5, counter: 'Juan', deviceId: 'dev-A', timestamp: 110 },
      ],
      products: [],
    };

    const fileB: CountFile = {
      app: 'mohawk-inventario',
      version: 1,
      kind: 'conteo',
      exportedAt: new Date().toISOString(),
      deviceId: 'dev-B',
      session: { id: 'sb', name: 'Sesion B', counter: 'Pedro', createdAt: 2, closed: false },
      counts: [
        { id: 'scan-3', sessionId: 'sb', barcode: '00071153000108', qty: 20, counter: 'Pedro', deviceId: 'dev-B', timestamp: 200 },
        { id: 'scan-4', sessionId: 'sb', barcode: '00079567011003', qty: 12, counter: 'Pedro', deviceId: 'dev-B', timestamp: 210 },
      ],
      products: [
        { barcode: '00079567011003', sku: '', description: 'WD-40 obtenido en línea', unit: '', source: 'UPCitemdb' },
      ],
    };

    // Primera consolidación
    const res1 = await mergeCountFiles(session.id, [fileA, fileB]);
    expect(res1.added).toBe(4);
    expect(res1.duplicates).toBe(0);
    expect(res1.productsAdded).toBe(1);
    expect(res1.counters).toEqual(['Juan', 'Pedro']);

    let saved = await countsForSession(session.id);
    expect(saved).toHaveLength(4);
    const totalGuantes = saved.filter((c) => c.barcode === '00071153000108').reduce((a, c) => a + c.qty, 0);
    expect(totalGuantes).toBe(35); // 10 + 5 + 20

    // Si el supervisor vuelve a importar el archivo A por error
    const res2 = await mergeCountFiles(session.id, [fileA]);
    expect(res2.added).toBe(0);
    expect(res2.duplicates).toBe(2);

    saved = await countsForSession(session.id);
    expect(saved).toHaveLength(4); // sigue siendo 4, no duplicó cantidades
  });

  it('valida el formato del archivo JSON importado', () => {
    expect(() => parseAppFile('not json')).toThrow(/válido/);
    expect(() => parseAppFile(JSON.stringify({ app: 'otro', version: 1 }))).toThrow(/Mohawk/);
    expect(() => parseAppFile(JSON.stringify({ app: 'mohawk-inventario', version: 1, kind: 'desconocido' }))).toThrow(/desconocido/);
  });
});
