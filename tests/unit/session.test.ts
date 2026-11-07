import { describe, expect, it } from 'vitest';
import {
  addCount,
  allSessions,
  closeSession,
  countsForSession,
  createSession,
  deleteSession,
  getActiveSession,
  getMeta,
  getSession,
  listSessions,
  reopenSession,
  setActiveSession,
} from '../../src/db/db';

describe('Session Lifecycle & Management', () => {
  it('creates a session with closed = false and sets activeSession', async () => {
    const session = await createSession('Inventario Pasillo 1', 'Juan');
    expect(session.id).toBeDefined();
    expect(session.name).toBe('Inventario Pasillo 1');
    expect(session.counter).toBe('Juan');
    expect(session.closed).toBe(false);
    expect(session.closedAt).toBeUndefined();
    expect(session.createdAt).toBeGreaterThan(0);

    const active = await getActiveSession();
    expect(active).toBeDefined();
    expect(active?.id).toBe(session.id);
    expect(active?.closed).toBe(false);

    const fromDb = await getSession(session.id);
    expect(fromDb).toEqual(session);
  });

  it('closeSession sets closed = true, closedAt, and clears activeSession if active', async () => {
    const session = await createSession('Inventario Almacén', 'Ana');
    expect((await getActiveSession())?.id).toBe(session.id);

    const beforeClose = Date.now();
    await closeSession(session.id);
    const afterClose = Date.now();

    const closed = await getSession(session.id);
    expect(closed).toBeDefined();
    expect(closed?.closed).toBe(true);
    expect(closed?.closedAt).toBeGreaterThanOrEqual(beforeClose);
    expect(closed?.closedAt).toBeLessThanOrEqual(afterClose);

    const active = await getActiveSession();
    expect(active).toBeUndefined();

    const activeMeta = await getMeta('activeSession');
    expect(activeMeta).toBeNull();
  });

  it('closeSession on a non-active session preserves the current active session', async () => {
    const session1 = await createSession('Sesión 1', 'Carlos');
    const session2 = await createSession('Sesión 2', 'Diana');

    // session2 is active
    expect((await getActiveSession())?.id).toBe(session2.id);

    // Close session1
    await closeSession(session1.id);

    const s1 = await getSession(session1.id);
    expect(s1?.closed).toBe(true);
    expect(s1?.closedAt).toBeDefined();

    // session2 should still be active
    const active = await getActiveSession();
    expect(active?.id).toBe(session2.id);
  });

  it('closeSession gracefully handles non-existent session IDs', async () => {
    await expect(closeSession('non-existent-id')).resolves.not.toThrow();
  });

  it('reopenSession sets closed = false and restores activeSession', async () => {
    const session = await createSession('Inventario Estantería B', 'Roberto');
    await closeSession(session.id);
    expect((await getActiveSession())).toBeUndefined();
    expect((await getSession(session.id))?.closed).toBe(true);

    await reopenSession(session.id);

    const reopened = await getSession(session.id);
    expect(reopened?.closed).toBe(false);

    const active = await getActiveSession();
    expect(active?.id).toBe(session.id);
    expect(active?.closed).toBe(false);
  });

  it('reopenSession gracefully handles non-existent session IDs', async () => {
    await expect(reopenSession('non-existent-id')).resolves.not.toThrow();
  });

  it('listSessions and allSessions list all sessions sorted by createdAt desc', async () => {
    expect(listSessions).toBe(allSessions);

    const s1 = await createSession('Sesión Antigua', 'User 1');
    // Ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 10));
    const s2 = await createSession('Sesión Media', 'User 2');
    await new Promise((r) => setTimeout(r, 10));
    const s3 = await createSession('Sesión Reciente', 'User 3');

    const list = await listSessions();
    expect(list.length).toBe(3);
    expect(list[0].id).toBe(s3.id);
    expect(list[1].id).toBe(s2.id);
    expect(list[2].id).toBe(s1.id);

    // Closing one does not remove it from the list
    await closeSession(s2.id);
    const listAfterClose = await listSessions();
    expect(listAfterClose.length).toBe(3);
    const closedEntry = listAfterClose.find((s) => s.id === s2.id);
    expect(closedEntry?.closed).toBe(true);
  });

  it('setActiveSession can switch or clear active session', async () => {
    const s1 = await createSession('Sesión 1', 'User 1');
    const s2 = await createSession('Sesión 2', 'User 2');

    expect((await getActiveSession())?.id).toBe(s2.id);

    await setActiveSession(s1.id);
    expect((await getActiveSession())?.id).toBe(s1.id);

    await setActiveSession(null);
    expect(await getActiveSession()).toBeUndefined();
  });

  it('deleteSession purges session and all related counts', async () => {
    const s = await createSession('Para eliminar', 'User');
    await addCount({ sessionId: s.id, barcode: '75010001', qty: 5, counter: 'User' });
    await addCount({ sessionId: s.id, barcode: '75010002', qty: 2, counter: 'User' });

    let counts = await countsForSession(s.id);
    expect(counts.length).toBe(2);

    await deleteSession(s.id);

    expect(await getSession(s.id)).toBeUndefined();
    counts = await countsForSession(s.id);
    expect(counts.length).toBe(0);
  });

  it('complete multi-session lifecycle without losing counts', async () => {
    // 1. Create session A
    const sA = await createSession('Auditoría Turno Mañana', 'Operador 1');
    await addCount({ sessionId: sA.id, barcode: '75010001', qty: 10, counter: 'Operador 1' });

    // 2. Close session A
    await closeSession(sA.id);
    expect(await getActiveSession()).toBeUndefined();

    // 3. Counts for session A are still retained in database
    const countsA = await countsForSession(sA.id);
    expect(countsA.length).toBe(1);
    expect(countsA[0].qty).toBe(10);

    // 4. Create session B
    const sB = await createSession('Auditoría Turno Tarde', 'Operador 2');
    expect((await getActiveSession())?.id).toBe(sB.id);
    await addCount({ sessionId: sB.id, barcode: '75010002', qty: 20, counter: 'Operador 2' });

    // 5. Close session B
    await closeSession(sB.id);
    expect(await getActiveSession()).toBeUndefined();

    // 6. Reopen session A
    await reopenSession(sA.id);
    expect((await getActiveSession())?.id).toBe(sA.id);
    expect((await getSession(sA.id))?.closed).toBe(false);

    // 7. Add another count to reopened session A
    await addCount({ sessionId: sA.id, barcode: '75010003', qty: 5, counter: 'Operador 1' });
    const updatedCountsA = await countsForSession(sA.id);
    expect(updatedCountsA.length).toBe(2);

    // 8. Session B remains closed with its counts intact
    const sBStored = await getSession(sB.id);
    expect(sBStored?.closed).toBe(true);
    const countsB = await countsForSession(sB.id);
    expect(countsB.length).toBe(1);
    expect(countsB[0].qty).toBe(20);
  });
});
