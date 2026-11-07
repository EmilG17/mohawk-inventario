import { beforeEach, describe, expect, it } from 'vitest';
import { addCount, countsForSession, createSession, getDB, putProduct } from '../../src/db/db';
import {
  _clearMemoryRooms,
  decodeCompactCountQr,
  encodeCompactCountQrChunks,
  isCompactCountQr,
  syncNow,
} from '../../src/sync/cloudSync';

describe('cloudSync (Sincronización en Línea y QR)', () => {
  beforeEach(async () => {
    _clearMemoryRooms();
    const db = await getDB();
    await db.clear('products');
    await db.clear('counts');
    await db.clear('sessions');
    await db.clear('meta');
  });

  it('sincroniza bidireccionalmente dos sesiones en la misma Sala en Línea sin duplicar lecturas', async () => {
    await putProduct({
      barcode: '00071153000100',
      sku: 'MHK-PPE-001',
      description: 'Guantes Nitrilo M',
      unit: 'CJA',
      minQty: 10,
      maxQty: 50,
      source: 'catalogo',
    });

    // Técnico 1 sube su conteo a la sala MHK-SALA-1
    const s1 = await createSession('Conteo Técnico 1', 'Carlos');
    await addCount({ sessionId: s1.id, barcode: '00071153000100', qty: 12, counter: 'Carlos' });

    const res1 = await syncNow({ sessionId: s1.id, roomCode: 'MHK-SALA-1' });
    expect(res1.roomCode).toBe('MHK-SALA-1');
    expect(res1.totalRoomCounts).toBe(1);

    // Técnico 2 / Supervisor cuenta en otra sesión y sincroniza con la misma sala MHK-SALA-1
    const s2 = await createSession('Conteo Supervisor', 'Elena');
    await addCount({ sessionId: s2.id, barcode: '00071153000100', qty: 8, counter: 'Elena' });

    const res2 = await syncNow({ sessionId: s2.id, roomCode: 'MHK-SALA-1' });
    expect(res2.addedCounts).toBe(1); // Recibió el conteo de Carlos
    expect(res2.totalRoomCounts).toBe(2); // Carlos (12) + Elena (8)

    const s2Counts = await countsForSession(s2.id);
    expect(s2Counts).toHaveLength(2);
    expect(s2Counts.reduce((acc, c) => acc + c.qty, 0)).toBe(20);

    // Re-sincronizar no duplica conteos
    const res3 = await syncNow({ sessionId: s2.id, roomCode: 'MHK-SALA-1' });
    expect(res3.addedCounts).toBe(0);
    expect(res3.duplicateCounts).toBe(2);
  });

  it('codifica y decodifica conteos en código QR compacto (MHKSYNC1|...)', async () => {
    const s = await createSession('Ruta Pasillo B', 'Miguel');
    const c1 = await addCount({ sessionId: s.id, barcode: '00071153000100', qty: 15, counter: 'Miguel' });
    const c2 = await addCount({ sessionId: s.id, barcode: '00079567011002', qty: 6, counter: 'Miguel' });

    const chunks = encodeCompactCountQrChunks(s, [c1, c2], 25);
    expect(chunks).toHaveLength(1);
    expect(isCompactCountQr(chunks[0])).toBe(true);

    const decoded = decodeCompactCountQr(chunks[0]);
    expect(decoded.session.name).toBe('Ruta Pasillo B');
    expect(decoded.session.counter).toBe('Miguel');
    expect(decoded.counts).toHaveLength(2);
    expect(decoded.counts[0].barcode).toBe('00071153000100');
    expect(decoded.counts[0].qty).toBe(15);
    expect(decoded.counts[1].barcode).toBe('00079567011002');
    expect(decoded.counts[1].qty).toBe(6);
  });
});
