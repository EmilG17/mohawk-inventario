import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addCount,
  countsForSession,
  createSession,
  deleteCount,
  getActiveSession,
  getDB,
  getMeta,
  putCount,
  putProduct,
  setMeta,
  type CountEntry,
} from '../../src/db/db';
import {
  deleteMovement,
  getAllMovements,
  listMovements,
  saveAllMovements,
  type Movement,
} from '../../src/db/movements';
import { mergeCountFiles } from '../../src/io/mergeCounts';
import {
  _clearMemoryRooms,
  applyIncomingRoomStateToLocal,
  canonicalCountId,
  computeStateFingerprint,
  getLocalTombstones,
  mergeRoomStates,
  recordTombstone,
  syncNow,
  type CloudRoomState,
} from '../../src/sync/cloudSync';

describe('Sync Hardening & Inventory Reliability (Milestone M1)', () => {
  beforeEach(async () => {
    _clearMemoryRooms();
    const db = await getDB();
    await db.clear('products');
    await db.clear('counts');
    await db.clear('sessions');
    await db.clear('meta');
    vi.restoreAllMocks();
  });

  describe('1. Deletion Tombstones (Zombie Record Elimination)', () => {
    it('eliminates deleted counts and prevents zombie resurrection upon room merge', async () => {
      const roomCode = 'MHK-TOMB-TEST';
      const s1 = await createSession('Sesion A', 'Carlos');

      // Create 3 counts
      const c1 = await addCount({ sessionId: s1.id, barcode: '75010001', qty: 5, counter: 'Carlos' });
      const c2 = await addCount({ sessionId: s1.id, barcode: '75010002', qty: 10, counter: 'Carlos' });
      const c3 = await addCount({ sessionId: s1.id, barcode: '75010003', qty: 15, counter: 'Carlos' });

      // First sync: uploads c1, c2, c3
      const sync1 = await syncNow({ sessionId: s1.id, roomCode });
      expect(sync1.totalRoomCounts).toBe(3);

      // Client deletes c2
      await deleteCount(c2.id);
      const remainingCounts = await countsForSession(s1.id);
      expect(remainingCounts.map((c) => c.id)).not.toContain(c2.id);

      // Verify tombstone was recorded
      const tombstones = await getLocalTombstones();
      const canonId = canonicalCountId(c2.id);
      expect(tombstones.counts?.[canonId]).toBeDefined();

      // Second sync: pushes tombstone to room
      const sync2 = await syncNow({ sessionId: s1.id, roomCode });
      expect(sync2.totalRoomCounts).toBe(2);

      // Simulate a second client syncing with the room
      const s2 = await createSession('Sesion B', 'Elena');
      // Elena had previously cached c2 before it was deleted
      await addCount({ id: c2.id, sessionId: s2.id, barcode: '75010002', qty: 10, counter: 'Carlos', timestamp: c2.timestamp });
      expect(await countsForSession(s2.id)).toHaveLength(1);

      // Elena syncs with the room: the tombstone must delete c2 from Elena's session
      const syncElena = await syncNow({ sessionId: s2.id, roomCode });
      expect(syncElena.totalRoomCounts).toBe(2);

      const elenaCounts = await countsForSession(s2.id);
      const elenaIds = elenaCounts.map((c) => canonicalCountId(c.id));
      expect(elenaIds).not.toContain(canonId);
      expect(elenaCounts.length).toBe(2); // Has c1 and c3, c2 was purged!
    });

    it('prunes tombstoned kardex movements via deleteMovement and prevents zombie resurrection upon room sync', async () => {
      const roomCode = 'MHK-MOV-TOMB';
      const m1: Movement = {
        id: 'mov-uuid-1',
        timestamp: 1000,
        sku: 'MHK-SKU-1',
        type: 'IN',
        quantity: 50,
        technicianOrSupplier: 'Proveedor A',
        machineOrArea: 'Area 1',
        folio: 'F-001',
      };
      const m2: Movement = {
        id: 'mov-uuid-2',
        timestamp: 1100,
        sku: 'MHK-SKU-2',
        type: 'OUT',
        quantity: 10,
        technicianOrSupplier: 'Técnico B',
        machineOrArea: 'Area 2',
        folio: 'F-002',
      };
      await saveAllMovements([m1, m2]);

      const s = await createSession('S1', 'User');
      await syncNow({ sessionId: s.id, roomCode });

      // Call genuine deleteMovement API
      const deleted = await deleteMovement(m1.id);
      expect(deleted).toBe(true);

      // Verify m1 is deleted locally
      const localAfterDelete = await listMovements();
      expect(localAfterDelete.map((m) => m.id)).not.toContain(m1.id);

      // Verify tombstone was recorded in getLocalTombstones()
      const tombstones = await getLocalTombstones();
      expect(tombstones.movements?.[m1.id]).toBeDefined();
      expect(typeof tombstones.movements?.[m1.id]).toBe('number');

      // Next sync: room state previously had m1, but tombstone prevents resurrection
      await syncNow({ sessionId: s.id, roomCode });

      const localAfterSync = await listMovements();
      expect(localAfterSync.map((m) => m.id)).toEqual(['mov-uuid-2']);
      expect(localAfterSync.map((m) => m.id)).not.toContain(m1.id);

      // Merge room states with tombstone
      const baseRoom: CloudRoomState = {
        app: 'mohawk-inventario',
        version: 1,
        roomCode,
        updatedAt: Date.now(),
        sessionName: 'Sala Test',
        counts: [],
        products: [],
        participants: {},
        movements: [m1, m2],
      };

      const merged = mergeRoomStates(baseRoom, {
        roomCode,
        sessionName: 'Sala Test',
        counts: [],
        products: [],
        movements: [m1, m2],
        tombstones: { movements: { [m1.id]: tombstones.movements![m1.id] } },
      });

      expect(merged.movements?.map((m) => m.id)).toEqual(['mov-uuid-2']);
      expect(merged.tombstones?.movements?.[m1.id]).toBe(tombstones.movements![m1.id]);
    });
  });

  describe('2. Quantity Edit Propagation Between Simulated Clients', () => {
    it('propagates in-place quantity updates between devices instead of discarding as duplicate', async () => {
      const roomCode = 'MHK-EDIT-PROP';

      // Device 1: initial count of 10
      const s1 = await createSession('Taller Central', 'Mario');
      const c1 = await addCount({
        id: 'count-fixed-uuid',
        sessionId: s1.id,
        barcode: '750100010001',
        qty: 10,
        counter: 'Mario',
        timestamp: 1000,
      });
      await syncNow({ sessionId: s1.id, roomCode });

      // Device 2: syncs and receives the count
      const s2 = await createSession('Almacén Móvil', 'Laura');
      await syncNow({ sessionId: s2.id, roomCode });

      let dev2Counts = await countsForSession(s2.id);
      expect(dev2Counts).toHaveLength(1);
      expect(dev2Counts[0].qty).toBe(10);

      // Device 1: Mario updates the count quantity to 35 with a newer timestamp
      await putCount({
        ...c1,
        qty: 35,
        timestamp: 2500,
      });

      // Device 1 syncs the updated quantity to the room
      const syncMario2 = await syncNow({ sessionId: s1.id, roomCode });
      expect(syncMario2.totalRoomCounts).toBe(1);

      // Device 2 syncs: must update existing record to 35 instead of treating it as duplicate
      const syncLaura2 = await syncNow({ sessionId: s2.id, roomCode });
      dev2Counts = await countsForSession(s2.id);

      expect(dev2Counts).toHaveLength(1);
      expect(dev2Counts[0].qty).toBe(35);
      expect(dev2Counts[0].timestamp).toBe(2500);
    });

    it('mergeCountFiles updates existing count when incoming is newer and quantity differs', async () => {
      const s = await createSession('Target Session', 'Tester');
      const existing = await addCount({
        id: 'entry-test-1',
        sessionId: s.id,
        barcode: 'BAR-100',
        qty: 2,
        counter: 'Tester',
        timestamp: 1000,
      });

      // Incoming file with same ID but newer timestamp and different qty
      const file: any = {
        app: 'mohawk-inventario',
        version: 1,
        kind: 'conteo',
        counts: [
          {
            id: 'entry-test-1',
            barcode: 'BAR-100',
            qty: 8,
            counter: 'Supervisor',
            timestamp: 2000,
          },
        ],
        products: [],
      };

      const res = await mergeCountFiles(s.id, [file]);
      expect(res.added).toBe(0);
      expect(res.updated).toBe(1);
      expect(res.duplicates).toBe(0);

      const updatedCounts = await countsForSession(s.id);
      expect(updatedCounts).toHaveLength(1);
      expect(updatedCounts[0].qty).toBe(8);
      expect(updatedCounts[0].counter).toBe('Supervisor');
      expect(updatedCounts[0].timestamp).toBe(2000);
    });
  });

  describe('3. Re-Entrancy Mutex Protection', () => {
    it('serializes rapid concurrent syncNow calls without race conditions or duplicated writes', async () => {
      const roomCode = 'MHK-MUTEX-TEST';
      const s = await createSession('Parallel Session', 'Concurrency tester');

      // Launch 15 rapid concurrent sync calls in parallel
      const syncPromises = Array.from({ length: 15 }, (_, i) =>
        syncNow({ sessionId: s.id, roomCode }).then(async (res) => {
          // Concurrently add a count while others might be syncing
          if (i % 3 === 0) {
            await addCount({
              sessionId: s.id,
              barcode: `75000000000${i}`,
              qty: i + 1,
              counter: 'Tester',
            });
          }
          return res;
        }),
      );

      const results = await Promise.all(syncPromises);
      expect(results).toHaveLength(15);
      for (const res of results) {
        expect(res.roomCode).toBe(roomCode);
        expect(res.sessionId).toBe(s.id);
      }

      // Final verification sync
      const finalSync = await syncNow({ sessionId: s.id, roomCode });
      const allCounts = await countsForSession(s.id);
      expect(finalSync.totalRoomCounts).toBe(allCounts.length);
    });
  });

  describe('4. Network Timeout & Error Recovery', () => {
    it('gracefully handles network timeout without throwing unhandled exceptions', async () => {
      const roomCode = 'MHK-TIMEOUT-TEST';
      const s = await createSession('Timeout Session', 'Net Tester');

      // Mock fetch to simulate AbortSignal timeout / network error
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

      try {
        const result = await syncNow({
          sessionId: s.id,
          roomCode,
          endpointUrl: 'https://mock-test-hang.firebaseio.com',
        });

        // Must succeed via fallback to local mirror
        expect(result).toBeDefined();
        expect(result.roomCode).toBe(roomCode);
        expect(result.transport).toBe('local');

        // Check pending sync was scheduled
        const pending = await getMeta<string>('pendingCloudSyncRoom');
        expect(pending).toBe(roomCode);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('recovers cleanly when network is restored', async () => {
      const roomCode = 'MHK-RESTORE-TEST';
      const s = await createSession('Restore Session', 'Net Tester');

      const originalFetch = globalThis.fetch;
      let shouldFail = true;

      globalThis.fetch = vi.fn().mockImplementation(async (url, init) => {
        if (shouldFail) {
          throw new Error('Network offline');
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            roomCode,
            counts: [],
            products: [],
            participants: {},
          }),
        };
      });

      try {
        // Step 1: fails and falls back
        const resFail = await syncNow({
          sessionId: s.id,
          roomCode,
          endpointUrl: 'https://mock-test.firebaseio.com',
        });
        expect(resFail.transport).toBe('local');

        // Step 2: network returns
        shouldFail = false;
        const resOk = await syncNow({
          sessionId: s.id,
          roomCode,
          endpointUrl: 'https://mock-test.firebaseio.com',
        });
        expect(resOk.transport).toBe('remote');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('5. State Fingerprint & Movement Detection Sensitivity', () => {
    it('detects in-place count quantity modifications and changes fingerprint', () => {
      const state1: CloudRoomState = {
        app: 'mohawk-inventario',
        version: 1,
        roomCode: 'MHK-FP-TEST',
        updatedAt: 1000,
        sessionName: 'Sala Fingerprint',
        counts: [
          { id: 'c1', sessionId: 's1', barcode: 'B1', qty: 5, counter: 'A', timestamp: 500 },
          { id: 'c2', sessionId: 's1', barcode: 'B2', qty: 10, counter: 'A', timestamp: 600 },
        ],
        products: [],
        participants: {},
      };

      const fp1 = computeStateFingerprint(state1);

      // Edit quantity of c1 in place without changing array length or last item timestamp
      const state2: CloudRoomState = {
        ...state1,
        counts: [
          { id: 'c1', sessionId: 's1', barcode: 'B1', qty: 99, counter: 'A', timestamp: 500 },
          { id: 'c2', sessionId: 's1', barcode: 'B2', qty: 10, counter: 'A', timestamp: 600 },
        ],
      };

      const fp2 = computeStateFingerprint(state2);
      expect(fp1).not.toBe(fp2);
    });

    it('detects in-place movement modifications and tombstones', () => {
      const state1: CloudRoomState = {
        app: 'mohawk-inventario',
        version: 1,
        roomCode: 'MHK-FP-TEST2',
        updatedAt: 1000,
        sessionName: 'Sala FP Movements',
        counts: [],
        products: [],
        participants: {},
        movements: [
          { id: 'm1', timestamp: 500, sku: 'SKU1', type: 'IN', quantity: 10, technicianOrSupplier: 'T1' },
        ],
      };

      const fp1 = computeStateFingerprint(state1);

      // Modify movement quantity
      const state2: CloudRoomState = {
        ...state1,
        movements: [
          { id: 'm1', timestamp: 500, sku: 'SKU1', type: 'IN', quantity: 99, technicianOrSupplier: 'T1' },
        ],
      };
      const fp2 = computeStateFingerprint(state2);
      expect(fp1).not.toBe(fp2);

      // Add tombstone
      const state3: CloudRoomState = {
        ...state2,
        tombstones: { movements: { m1: 700 } },
      };
      const fp3 = computeStateFingerprint(state3);
      expect(fp3).not.toBe(fp2);
    });
  });

  describe('6. Idle Session Respect', () => {
    it('does not auto-create a local session during background sync when no session is active', async () => {
      // Ensure no active session
      expect(await getActiveSession()).toBeUndefined();

      const incomingState: CloudRoomState = {
        app: 'mohawk-inventario',
        version: 1,
        roomCode: 'MHK-IDLE-TEST',
        updatedAt: Date.now(),
        sessionName: 'Remote Session',
        counts: [
          { id: 'c-remote-1', sessionId: 's-remote', barcode: '75010001', qty: 5, counter: 'Remote Tech', timestamp: 1000 },
        ],
        products: [],
        participants: {},
      };

      // Apply incoming state (as would happen via SSE or quiet pull)
      await applyIncomingRoomStateToLocal(incomingState, 'remote');

      // activeSession MUST remain undefined
      expect(await getActiveSession()).toBeUndefined();
      expect(await getMeta('activeSession')).toBeFalsy();
    });
  });
});
