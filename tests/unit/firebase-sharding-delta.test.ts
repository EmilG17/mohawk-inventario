import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addCount, clearProducts, countsForSession, createSession, getDB, putProduct } from '../../src/db/db';
import { clearMovements, listMovements, recordMovement } from '../../src/db/movements';
import {
  _clearMemoryRooms,
  archiveSessionToCloud,
  checkRoomExistsInDb,
  fetchCloudArchivedSession,
  fetchRemoteUpdatedAt,
  generateUniqueRoomCode,
  isRoomInviteUrl,
  joinRoomFromInvite,
  listAvailableRoomsInDb,
  listCloudArchivedSessions,
  normalizeRoomCode,
  parseRoomInviteUrl,
  patchRemoteRoomDelta,
  syncDeltaToRemote,
  syncNow,
  triggerBackgroundSync,
} from '../../src/sync/cloudSync';
import { loadSettings, saveSettings } from '../../src/settings';
import 'fake-indexeddb/auto';

describe('Firebase Realtime DB Granular Sharding & Delta Sync Suite', () => {
  beforeEach(async () => {
    _clearMemoryRooms();
    await clearProducts();
    await clearMovements();
    const db = await getDB();
    await db.clear('counts');
    await db.clear('sessions');
    await db.clear('meta');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchRemoteUpdatedAt consulta el timestamp sin descargar datos pesados', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/rooms/MHK-DELTA/updatedAt.json')) {
        return new Response(JSON.stringify(1794860000123), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    const ts = await fetchRemoteUpdatedAt('https://mi-empresa-default-rtdb.firebaseio.com', 'MHK-DELTA');
    expect(ts).toBe(1794860000123);
    expect(fetchSpy).toHaveBeenCalled();
    const calledUrl = String(fetchSpy.mock.calls[0][0]);
    expect(calledUrl).toContain('/rooms/MHK-DELTA/updatedAt.json');
  });

  it('patchRemoteRoomDelta envía un payload multi-location compacto a Firebase', async () => {
    let capturedBody: any = null;
    let capturedMethod = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
      capturedMethod = opts?.method || '';
      capturedBody = JSON.parse(opts?.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const ok = await patchRemoteRoomDelta('https://mi-empresa-default-rtdb.firebaseio.com', 'MHK-DELTA', {
      counts: {
        cnt_1: { id: 'cnt_1', sessionId: 's1', barcode: '7501001', qty: 5, counter: 'Juan', deviceId: 'dev_1', timestamp: 1000 },
      },
      tombstones: {
        counts: { cnt_old: 9999 },
      },
      updatedAt: 1794860000000,
    });

    expect(ok).toBe(true);
    expect(capturedMethod).toBe('PATCH');
    expect(capturedBody).toBeDefined();
    // Verifica que use sub-rutas multi-location
    expect(capturedBody['counts/cnt_1']).toBeDefined();
    expect(capturedBody['counts/cnt_1'].barcode).toBe('7501001');
    expect(capturedBody['tombstones/counts/cnt_old']).toBe(9999);
    expect(capturedBody['counts/cnt_old']).toBeNull(); // Eliminación atómica en RTDB
    expect(capturedBody.updatedAt).toBe(1794860000000);
  });

  it('syncDeltaToRemote solo transmite conteos y movimientos nuevos sin reenviar la sala completa', async () => {
    await saveSettings({
      syncEnabled: true,
      syncRoomCode: 'MHK-DELTA-TEST',
      syncEndpointUrl: 'https://mi-empresa-default-rtdb.firebaseio.com',
      counterName: 'Carlos',
    });

    const s = await createSession('Sesión Auditoría', 'Carlos');
    // Conteo viejo (antes de la última sincronización)
    await addCount({ sessionId: s.id, barcode: '7501001', qty: 2, counter: 'Carlos', timestamp: 1000 });

    // Conteo nuevo (posterior a la última sincronización)
    await addCount({ sessionId: s.id, barcode: '7501002', qty: 10, counter: 'Carlos', timestamp: 2500 });

    let capturedPayload: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      if (opts?.method === 'PATCH') {
        capturedPayload = JSON.parse(opts.body as string);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    // Sincronizar solo los deltas generados desde timestamp 2000
    const deltaRes = await syncDeltaToRemote({
      sessionId: s.id,
      roomCode: 'MHK-DELTA-TEST',
      endpointUrl: 'https://mi-empresa-default-rtdb.firebaseio.com',
      sinceTimestamp: 2000,
    });

    expect(deltaRes).toBe(true);
    expect(capturedPayload).not.toBeNull();
    // Solo debe haber enviado el conteo 7501002, NO el viejo 7501001
    const countsKeys = Object.keys(capturedPayload).filter((k) => k.startsWith('counts/'));
    expect(countsKeys).toHaveLength(1);
    expect(capturedPayload[countsKeys[0]].barcode).toBe('7501002');
  });

  it('archiveSessionToCloud y listCloudArchivedSessions desacoplan sesiones cerradas de la sala activa', async () => {
    const s = await createSession('Inventario Anual 2026', 'Supervisor');
    await addCount({ sessionId: s.id, barcode: 'ABC-123', qty: 15, counter: 'Supervisor' });
    await addCount({ sessionId: s.id, barcode: 'XYZ-789', qty: 25, counter: 'Supervisor' });

    let archivedDetail: any = null;
    let archivedSummary: any = null;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      const u = String(url);
      if (opts?.method === 'PUT') {
        if (u.includes('/sessions_archive/')) {
          archivedDetail = JSON.parse(opts.body as string);
        } else if (u.includes('/history_summaries/')) {
          archivedSummary = JSON.parse(opts.body as string);
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (opts?.method === 'GET') {
        if (u.includes('/history_summaries.json')) {
          return new Response(JSON.stringify({ [s.id]: archivedSummary }), { status: 200 });
        }
        if (u.includes(`/sessions_archive/${encodeURIComponent(s.id)}.json`)) {
          return new Response(JSON.stringify(archivedDetail), { status: 200 });
        }
      }
      return new Response('Not found', { status: 404 });
    });

    const archived = await archiveSessionToCloud(s.id, {
      roomCode: 'MHK-ARCHIVE-ROOM',
      endpointUrl: 'https://mi-empresa-default-rtdb.firebaseio.com',
    });
    expect(archived).toBe(true);
    expect(archivedSummary).toBeDefined();
    expect(archivedSummary.name).toBe('Inventario Anual 2026');
    expect(archivedSummary.totalCounts).toBe(2);
    expect(archivedSummary.totalUnits).toBe(40);

    expect(archivedDetail).toBeDefined();
    expect(archivedDetail.counts).toHaveLength(2);

    // Listar resúmenes ligeros sin descargar detalle
    const list = await listCloudArchivedSessions({
      roomCode: 'MHK-ARCHIVE-ROOM',
      endpointUrl: 'https://mi-empresa-default-rtdb.firebaseio.com',
    });
    expect(list).toHaveLength(1);
    expect(list[0].totalUnits).toBe(40);

    // Descargar detalle bajo demanda
    const fetchedDetail = await fetchCloudArchivedSession(s.id, {
      roomCode: 'MHK-ARCHIVE-ROOM',
      endpointUrl: 'https://mi-empresa-default-rtdb.firebaseio.com',
    });
    expect(fetchedDetail).not.toBeNull();
    expect(fetchedDetail?.counts).toHaveLength(2);
  });

  describe('Prevención de salas duplicadas y normalización canónica', () => {
    it('normaliza variaciones tipográficas a una sala canónica única', () => {
      // Casos comunes de duplicados por tecleo de técnicos
      expect(normalizeRoomCode('mhk-01')).toBe('MHK-1');
      expect(normalizeRoomCode('MHK 1')).toBe('MHK-1');
      expect(normalizeRoomCode('mhk_1')).toBe('MHK-1');
      expect(normalizeRoomCode('mhk 001')).toBe('MHK-1');
      expect(normalizeRoomCode('mhk2026')).toBe('MHK-2026');
      expect(normalizeRoomCode('Salón 1')).toBe('SALON-1');
      expect(normalizeRoomCode('  mhk-planta-02  ')).toBe('MHK-PLANTA-2');
      expect(normalizeRoomCode('MHK-ALMACEN_CENTRAL-007')).toBe('MHK-ALMACEN-CENTRAL-7');
    });

    it('identifica y procesa URLs de invitación para unirse con 1-tap/escaneo', async () => {
      const inviteUrl = 'https://app.mohawk.com/?room=MHK-AUDIT-1&endpoint=https%3A%2F%2Fdemo-rtdb.firebaseio.com';
      expect(isRoomInviteUrl(inviteUrl)).toBe(true);
      expect(isRoomInviteUrl('750100123456')).toBe(false);

      const parsed = parseRoomInviteUrl(inviteUrl);
      expect(parsed).not.toBeNull();
      expect(parsed?.roomCode).toBe('MHK-AUDIT-1');
      expect(parsed?.endpointUrl).toBe('https://demo-rtdb.firebaseio.com');

      const joined = await joinRoomFromInvite(inviteUrl);
      expect(joined.success).toBe(true);
      expect(joined.roomCode).toBe('MHK-AUDIT-1');

      const s = await loadSettings();
      expect(s.syncRoomCode).toBe('MHK-AUDIT-1');
      expect(s.syncEndpointUrl).toBe('https://demo-rtdb.firebaseio.com');
      expect(s.syncEnabled).toBe(true);
    });

    it('listAvailableRoomsInDb y checkRoomExistsInDb consultan el índice de salas en Firebase', async () => {
      const mockRoomsIndex = {
        'MHK-1': { roomCode: 'MHK-1', sessionName: 'Inventario General', updatedAt: 1794860000000 },
        'MHK-2': { roomCode: 'MHK-2', sessionName: 'Auditoría Tienda', updatedAt: 1794860050000 },
      };

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes('/rooms_index.json')) {
          return new Response(JSON.stringify(mockRoomsIndex), { status: 200 });
        }
        if (u.includes('/rooms/MHK-1/updatedAt.json')) {
          return new Response(JSON.stringify(1794860000000), { status: 200 });
        }
        if (u.includes('/rooms/MHK-99/updatedAt.json')) {
          return new Response('null', { status: 200 });
        }
        return new Response('null', { status: 200 });
      });

      const rooms = await listAvailableRoomsInDb('https://demo-rtdb.firebaseio.com');
      expect(rooms).toHaveLength(2);
      expect(rooms.map((r) => r.roomCode)).toContain('MHK-1');
      expect(rooms.map((r) => r.roomCode)).toContain('MHK-2');

      const exists1 = await checkRoomExistsInDb('https://demo-rtdb.firebaseio.com', 'mhk-01'); // Debe normalizarse a MHK-1
      expect(exists1.exists).toBe(true);

      const exists99 = await checkRoomExistsInDb('https://demo-rtdb.firebaseio.com', 'MHK-99');
      expect(exists99.exists).toBe(false);
    });

    it('generateUniqueRoomCode busca un número secuencial no utilizado evitando colisiones', async () => {
      const existingRooms = {
        'MHK-1': true,
        'MHK-2': true,
        'MHK-3': true,
      };

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes('/rooms.json?shallow=true')) {
          return new Response(JSON.stringify(existingRooms), { status: 200 });
        }
        return new Response('null', { status: 200 });
      });

      const uniqueCode = await generateUniqueRoomCode('https://demo-rtdb.firebaseio.com', 'MHK');
      expect(uniqueCode).toBe('MHK-4');
    });
  });
});
