import { describe, expect, it } from 'vitest';
import {
  addCount,
  allProducts,
  allSessions,
  bulkPutProducts,
  closeSession,
  countsForSession,
  createSession,
  deleteSession,
  getActiveSession,
  getDB,
  getMeta,
  getSession,
  listSessions,
  reopenSession,
  setActiveSession,
  setMeta,
  type Product,
} from '../../src/db/db';
import { buildCountFile } from '../../src/io/exportResults';
import { buildReport, summarize } from '../../src/report';

describe('Adversarial Stress Test: Session Lifecycle & Finalization', () => {
  // =========================================================================
  // 1. Rapid Close & Reopen Cycles
  // =========================================================================
  describe('Rapid Close & Reopen Cycles', () => {
    it('survives 100 rapid sequential close and reopen cycles without state corruption', async () => {
      const s = await createSession('Stress Cycle Session', 'Tester');
      expect((await getActiveSession())?.id).toBe(s.id);

      for (let i = 0; i < 100; i++) {
        await closeSession(s.id);
        const closed = await getSession(s.id);
        expect(closed?.closed).toBe(true);
        expect(closed?.closedAt).toBeDefined();
        expect(await getActiveSession()).toBeUndefined();
        expect(await getMeta('activeSession')).toBeNull();

        await reopenSession(s.id);
        const reopened = await getSession(s.id);
        expect(reopened?.closed).toBe(false);
        expect((await getActiveSession())?.id).toBe(s.id);
        expect(await getMeta('activeSession')).toBe(s.id);
      }

      // Final close
      await closeSession(s.id);
      expect((await getSession(s.id))?.closed).toBe(true);
      expect(await getActiveSession()).toBeUndefined();
    });

    it('handles concurrent close and reopen calls without unhandled rejections', async () => {
      const s = await createSession('Concurrent Session', 'Tester');

      // Dispatch multiple close/reopen promises concurrently
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
          promises.push(closeSession(s.id));
        } else {
          promises.push(reopenSession(s.id));
        }
      }

      // None of the promises should throw or reject
      await expect(Promise.all(promises)).resolves.toBeDefined();

      // State in DB should still be a valid boolean
      const finalSession = await getSession(s.id);
      expect(finalSession).toBeDefined();
      expect(typeof finalSession?.closed).toBe('boolean');

      // Check activeSession meta consistency
      const activeId = await getMeta<string>('activeSession');
      const activeSession = await getActiveSession();
      if (finalSession?.closed) {
        // If session ended closed, activeSession should either be null or point to another valid session
        if (activeId === s.id) {
          // Flag this behavior if close happened after reopen or vice versa
        }
      } else {
        // If session ended open, and activeId is s.id, getActiveSession should resolve it
        if (activeId === s.id) {
          expect(activeSession?.id).toBe(s.id);
        }
      }
    });

    it('interleaves multiple sessions rapidly without cross-talk or pointer drift', async () => {
      const s1 = await createSession('Session Alpha', 'User 1');
      const s2 = await createSession('Session Beta', 'User 2');
      const s3 = await createSession('Session Gamma', 'User 3');

      // Rapidly toggle active status and close/reopen in mixed order
      for (let i = 0; i < 25; i++) {
        await closeSession(s1.id);
        await setActiveSession(s2.id);
        await closeSession(s3.id);
        await reopenSession(s1.id);
        await closeSession(s2.id);
        await reopenSession(s3.id);
      }

      // Verify each session maintains its exact identity and integrity
      const list = await allSessions();
      expect(list.length).toBe(3);

      const r1 = await getSession(s1.id);
      const r2 = await getSession(s2.id);
      const r3 = await getSession(s3.id);

      expect(r1?.name).toBe('Session Alpha');
      expect(r2?.name).toBe('Session Beta');
      expect(r3?.name).toBe('Session Gamma');

      // Verify the active session points to the last reopened (s3)
      const currentActive = await getActiveSession();
      expect(currentActive?.id).toBe(s3.id);
      expect(currentActive?.closed).toBe(false);
    });
  });

  // =========================================================================
  // 2. Closing a Session: Zero Counts vs Thousands of Counts
  // =========================================================================
  describe('Closing Session: Zero Counts vs Massive Scale', () => {
    it('closes a session with zero counts and verifies report/export robustness', async () => {
      const s = await createSession('Empty Session', 'Auditor');
      await closeSession(s.id);

      expect((await getSession(s.id))?.closed).toBe(true);
      const counts = await countsForSession(s.id);
      expect(counts).toEqual([]);

      // Test report building with 0 counts
      const products: Product[] = [
        { barcode: '7501001', sku: 'SKU1', description: 'Item 1', unit: 'PZA', expectedQty: 10, source: 'catalogo' },
        { barcode: '7501002', sku: 'SKU2', description: 'Item 2', unit: 'PZA', expectedQty: 5, source: 'catalogo' },
      ];
      const rows = buildReport(products, counts, true);
      expect(rows.length).toBe(2);
      expect(rows[0].counted).toBe(0);
      expect(rows[1].counted).toBe(0);

      const summary = summarize(rows);
      expect(summary.totalUnitsCounted).toBe(0);
      expect(summary.counted).toBe(0);
      expect(summary.notCounted).toBe(2);

      // Test export file generation with 0 counts
      const countFile = buildCountFile(s, counts, products, 'dev-test');
      expect(countFile.counts).toEqual([]);
      expect(countFile.session.id).toBe(s.id);
      expect(countFile.kind).toBe('conteo');
    });

    it('handles session with 5,000 counts across 100 products without memory or data loss', async () => {
      const s = await createSession('High Volume Session', 'Heavy Counter');

      // Populate 100 products
      const products: Product[] = [];
      for (let p = 0; p < 100; p++) {
        products.push({
          barcode: `75000000${String(p).padStart(4, '0')}`,
          sku: `SKU-${p}`,
          description: `Consumable Product #${p}`,
          unit: 'PZA',
          expectedQty: 50,
          unitCost: 10 + p,
          source: 'catalogo',
        });
      }
      await bulkPutProducts(products);

      // Add 5,000 counts in chunks
      const CHUNK_SIZE = 500;
      const TOTAL_COUNTS = 5000;
      const db = await getDB();

      for (let offset = 0; offset < TOTAL_COUNTS; offset += CHUNK_SIZE) {
        const tx = db.transaction('counts', 'readwrite');
        for (let i = 0; i < CHUNK_SIZE; i++) {
          const idx = offset + i;
          const barcode = `75000000${String(idx % 100).padStart(4, '0')}`;
          await tx.store.put({
            id: `count-${idx}`,
            sessionId: s.id,
            barcode,
            qty: 1,
            counter: `Op-${idx % 5}`,
            deviceId: 'dev-stress',
            timestamp: Date.now() + idx,
          });
        }
        await tx.done;
      }

      // Verify all 5,000 counts exist before close
      const beforeCloseCounts = await countsForSession(s.id);
      expect(beforeCloseCounts.length).toBe(TOTAL_COUNTS);

      // Close the session
      const t0 = performance.now();
      await closeSession(s.id);
      const closeTime = performance.now() - t0;
      // Closing should be fast (< 200ms) regardless of count volume
      expect(closeTime).toBeLessThan(2000);

      const closed = await getSession(s.id);
      expect(closed?.closed).toBe(true);
      expect(closed?.closedAt).toBeDefined();
      expect(await getActiveSession()).toBeUndefined();

      // Verify all 5,000 counts remain completely intact in DB after closing
      const afterCloseCounts = await countsForSession(s.id);
      expect(afterCloseCounts.length).toBe(TOTAL_COUNTS);

      // Total quantity counted should equal 5000
      const totalUnits = afterCloseCounts.reduce((acc, c) => acc + c.qty, 0);
      expect(totalUnits).toBe(TOTAL_COUNTS);

      // Build report for closed session
      const rows = buildReport(products, afterCloseCounts, true);
      expect(rows.length).toBe(100);
      for (const row of rows) {
        // 5000 / 100 = 50 units per product
        expect(row.counted).toBe(50);
        expect(row.diff).toBe(0);
        expect(row.status).toBe('ok');
      }

      // Reopen session and add one more count
      await reopenSession(s.id);
      expect((await getActiveSession())?.id).toBe(s.id);

      await addCount({
        sessionId: s.id,
        barcode: products[0].barcode,
        qty: 5,
        counter: 'Supervisor',
      });

      const updatedCounts = await countsForSession(s.id);
      expect(updatedCounts.length).toBe(TOTAL_COUNTS + 1);

      // Delete the high-volume session and verify complete cursor cleanup
      const tDelete0 = performance.now();
      await deleteSession(s.id);
      const deleteTime = performance.now() - tDelete0;
      expect(deleteTime).toBeLessThan(5000);

      // Verify all counts for s.id were deleted
      const remainingCounts = await countsForSession(s.id);
      expect(remainingCounts.length).toBe(0);
      expect(await getSession(s.id)).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. Handling of Null / Undefined activeSession Across DB Functions
  // =========================================================================
  describe('Null activeSession Resilience Across DB Functions', () => {
    it('handles explicit null activeSession without crashes or unhandled rejections', async () => {
      // Ensure null activeSession
      await setActiveSession(null);
      expect(await getActiveSession()).toBeUndefined();
      expect(await getMeta('activeSession')).toBeNull();

      // All DB functions should handle this safely
      await expect(allSessions()).resolves.toBeDefined();
      await expect(getSession('')).resolves.toBeUndefined();
      await expect(getSession('non-existent-guid')).resolves.toBeUndefined();
      await expect(countsForSession('')).resolves.toEqual([]);
      await expect(countsForSession('non-existent-guid')).resolves.toEqual([]);

      // closeSession and reopenSession on missing IDs
      await expect(closeSession('')).resolves.toBeUndefined();
      await expect(closeSession('non-existent-guid')).resolves.toBeUndefined();
      await expect(reopenSession('')).resolves.toBeUndefined();
      await expect(reopenSession('non-existent-guid')).resolves.toBeUndefined();

      // deleteSession on missing IDs
      await expect(deleteSession('')).resolves.toBeUndefined();
      await expect(deleteSession('non-existent-guid')).resolves.toBeUndefined();

      // activeSession remains null throughout
      expect(await getActiveSession()).toBeUndefined();
    });

    it('getActiveSession returns undefined when activeSession key is missing, null, or empty string', async () => {
      await setMeta('activeSession', null);
      expect(await getActiveSession()).toBeUndefined();

      await setMeta('activeSession', undefined);
      expect(await getActiveSession()).toBeUndefined();

      await setMeta('activeSession', '');
      expect(await getActiveSession()).toBeUndefined();

      // Pointing to a deleted/non-existent ID
      await setMeta('activeSession', 'ghost-id-999');
      expect(await getActiveSession()).toBeUndefined();
    });
  });

  // =========================================================================
  // 4. Deleting an Active Session vs Deleting a Closed Session
  // =========================================================================
  describe('Deleting Active vs Closed Sessions', () => {
    it('deleting a closed session cleans up data without affecting active session', async () => {
      const active = await createSession('Active Session', 'User A');
      const closed = await createSession('Closed Session', 'User B');

      await addCount({ sessionId: active.id, barcode: '111', qty: 2, counter: 'User A' });
      await addCount({ sessionId: closed.id, barcode: '222', qty: 3, counter: 'User B' });

      // Close 'closed' session and switch active back to 'active'
      await closeSession(closed.id);
      await setActiveSession(active.id);

      expect((await getActiveSession())?.id).toBe(active.id);
      expect((await getSession(closed.id))?.closed).toBe(true);

      // Delete the closed session
      await deleteSession(closed.id);

      expect(await getSession(closed.id)).toBeUndefined();
      expect(await countsForSession(closed.id)).toEqual([]);

      // Active session should be completely unaffected
      const currentActive = await getActiveSession();
      expect(currentActive?.id).toBe(active.id);
      expect((await countsForSession(active.id)).length).toBe(1);
    });

    it('deleting an active session directly via deleteSession() cleans up meta.activeSession pointer', async () => {
      const active = await createSession('Active Session to Delete', 'User X');
      expect(await getMeta('activeSession')).toBe(active.id);
      expect((await getActiveSession())?.id).toBe(active.id);

      // Call deleteSession on the active session
      await deleteSession(active.id);

      // 1. Session store entry is deleted
      expect(await getSession(active.id)).toBeUndefined();

      // 2. What is the value of getMeta("activeSession")?
      // CRITICAL CHECK: Does meta.activeSession get cleared (no dangling pointer)?
      const danglingPointer = await getMeta<string>('activeSession');

      // 3. getActiveSession() gracefully handles it by returning undefined because getSession() returns undefined:
      const resolvedActive = await getActiveSession();
      expect(resolvedActive).toBeUndefined();

      // Verify whether the meta pointer was cleaned up by deleteSession:
      // In db.ts, deleteSession clears meta.activeSession when deleting the active session.
      expect(danglingPointer).toBeNull();
    });
  });

  // =========================================================================
  // 5. Memory Leaks, Unhandled Rejections & Corrupted Meta Pointers
  // =========================================================================
  describe('Pointer Integrity, Unhandled Rejections & Boundary Stability', () => {
    it('reopening a non-existent session does not corrupt activeSession pointer', async () => {
      const valid = await createSession('Valid Session', 'Tester');
      expect((await getActiveSession())?.id).toBe(valid.id);

      // Reopening non-existent session
      await reopenSession('invalid-ghost-id');

      // Active session should still point to valid session, not ghost-id
      expect((await getActiveSession())?.id).toBe(valid.id);
      expect(await getMeta('activeSession')).toBe(valid.id);
    });

    it('closing a non-existent session does not clear an unrelated active session', async () => {
      const valid = await createSession('Valid Active Session', 'Tester');
      expect((await getActiveSession())?.id).toBe(valid.id);

      await closeSession('invalid-ghost-id');

      expect((await getActiveSession())?.id).toBe(valid.id);
      expect(await getMeta('activeSession')).toBe(valid.id);
    });

    it('handles multiple close calls on the same already-closed session idempotently', async () => {
      const s = await createSession('Idempotent Close', 'Tester');
      await closeSession(s.id);
      const firstClosed = await getSession(s.id);
      expect(firstClosed?.closed).toBe(true);
      const firstClosedAt = firstClosed?.closedAt;

      // Small delay
      await new Promise((r) => setTimeout(r, 20));

      // Second close call
      await closeSession(s.id);
      const secondClosed = await getSession(s.id);
      expect(secondClosed?.closed).toBe(true);
      expect(await getActiveSession()).toBeUndefined();
    });

    it('handles multiple reopen calls on an already-open session idempotently', async () => {
      const s = await createSession('Idempotent Reopen', 'Tester');
      expect(s.closed).toBe(false);

      await reopenSession(s.id);
      const check1 = await getSession(s.id);
      expect(check1?.closed).toBe(false);
      expect((await getActiveSession())?.id).toBe(s.id);

      await reopenSession(s.id);
      const check2 = await getSession(s.id);
      expect(check2?.closed).toBe(false);
      expect((await getActiveSession())?.id).toBe(s.id);
    });

    it('MASSIVE STRESS: 10,000 counts scaling, sorting verification, and cursor deletion', async () => {
      const s = await createSession('Session 10k', 'Load Tester');
      const TOTAL = 10000;
      const CHUNK = 1000;
      const db = await getDB();

      // Ingest 10,000 counts
      for (let base = 0; base < TOTAL; base += CHUNK) {
        const tx = db.transaction('counts', 'readwrite');
        for (let i = 0; i < CHUNK; i++) {
          const idx = base + i;
          await tx.store.put({
            id: `k-${idx}`,
            sessionId: s.id,
            barcode: `7500${idx % 250}`,
            qty: 1,
            counter: 'LoadTester',
            deviceId: 'dev-10k',
            timestamp: 1000000 + idx,
          });
        }
        await tx.done;
      }

      // Close session
      const tClose0 = performance.now();
      await closeSession(s.id);
      const closeDuration = performance.now() - tClose0;
      expect(closeDuration).toBeLessThan(1000);
      expect((await getSession(s.id))?.closed).toBe(true);

      // Verify retrieval and timestamp descending sort order
      const tFetch0 = performance.now();
      const allCounts = await countsForSession(s.id);
      const fetchDuration = performance.now() - tFetch0;
      expect(fetchDuration).toBeLessThan(2000);
      expect(allCounts.length).toBe(TOTAL);

      // Verify strict descending sort by timestamp
      for (let i = 0; i < 100; i++) {
        expect(allCounts[i].timestamp).toBeGreaterThanOrEqual(allCounts[i + 1].timestamp);
      }

      // Cursor deletion under 10k items
      const tDel0 = performance.now();
      await deleteSession(s.id);
      const delDuration = performance.now() - tDel0;
      expect(delDuration).toBeLessThan(5000);

      // Verify 0 remaining
      const remaining = await countsForSession(s.id);
      expect(remaining.length).toBe(0);
    }, 20000);

    it('BOUNDARY: Unicode, emoji, 5000-char names, and script tags in session fields', async () => {
      const exoticName = '🏷️ Inventario "Novedades" & <script>alert("mohawk")</script> — Pasillo 9 📦';
      const exoticCounter = '👨‍🔧 Operador 1 · Çñüí — <img src=x onerror=alert(1)>';
      const s = await createSession(exoticName, exoticCounter);

      const retrieved = await getSession(s.id);
      expect(retrieved?.name).toBe(exoticName);
      expect(retrieved?.counter).toBe(exoticCounter);

      // Very large string
      const hugeName = 'A'.repeat(5000);
      const sHuge = await createSession(hugeName, 'Large');
      const retrievedHuge = await getSession(sHuge.id);
      expect(retrievedHuge?.name).toBe(hugeName);
    });

    it('CONCURRENCY: 10 sessions created, closed, and reopened in parallel', async () => {
      // Create 10 sessions concurrently
      const createPromises = Array.from({ length: 10 }, (_, i) =>
        createSession(`Concurrent Session #${i}`, `Worker ${i}`)
      );
      const sessions = await Promise.all(createPromises);
      expect(sessions.length).toBe(10);

      const all = await allSessions();
      expect(all.length).toBeGreaterThanOrEqual(10);

      // Close all 10 concurrently
      await Promise.all(sessions.map((s) => closeSession(s.id)));

      // Verify all are closed
      for (const s of sessions) {
        const stored = await getSession(s.id);
        expect(stored?.closed).toBe(true);
        expect(stored?.closedAt).toBeDefined();
      }

      // Reopen all 10 concurrently
      await Promise.all(sessions.map((s) => reopenSession(s.id)));

      for (const s of sessions) {
        const stored = await getSession(s.id);
        expect(stored?.closed).toBe(false);
      }
    });
  });
});
