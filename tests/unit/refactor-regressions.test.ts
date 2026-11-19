import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession, getActiveSession, getDB, setActiveSession } from '../../src/db/db';
import { parseNumber } from '../../src/io/normalize';
import { _resetSettingsCache, saveSettings } from '../../src/settings';
import { encodeFirebaseKey, decodeFirebaseKey } from '../../src/sync/firebaseKeys';
import { mergeRoomStates } from '../../src/sync/roomMerge';
import type { CloudRoomState } from '../../src/sync/types';
import { fmtMoney, h, openDialog } from '../../src/ui/dom';
import {
  isValidSupervisorPin,
  switchToSupervisorSession,
  switchToTechnicianSession,
} from '../../src/ui/supervisorAuth';

describe('Refactor Regressions Suite', () => {
  beforeEach(async () => {
    _resetSettingsCache();
    const db = await getDB();
    await db.clear('sessions');
    await db.clear('meta');
    await db.clear('products');
    await db.clear('counts');
    await saveSettings({
      supervisorMode: false,
      userRole: 'technician',
      supervisorPin: '1234',
      techSessionId: null,
      supervisorSessionId: null,
    });
  });

  it('parseNumber distills 3-decimal floats vs thousands separators vs blank/currency strings', () => {
    expect(parseNumber('1.250')).toBe(1.25);
    expect(parseNumber('0.005')).toBe(0.005);
    expect(parseNumber('1,250.50')).toBe(1250.5);
    expect(parseNumber('1.250.000')).toBe(1250000);
    expect(parseNumber('2,500')).toBe(2500);
    expect(parseNumber('12,500')).toBe(12500);
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('   ')).toBeUndefined();
    expect(parseNumber('$')).toBeUndefined();
    expect(parseNumber('MXN ---')).toBeUndefined();
    expect(parseNumber('$1,234.56')).toBe(1234.56);
  });

  it('encodeFirebaseKey and decodeFirebaseKey round-trip losslessly across reserved chars', () => {
    const samples = [
      'ABC.123',
      'SKU$#[]/~TEST',
      'a~0.b~1$c/d#e[f]g',
      '0750105530001',
      'MHK/01.02#3',
      '~~~...$$$///',
    ];
    for (const raw of samples) {
      const escaped = encodeFirebaseKey(raw);
      expect(escaped).not.toMatch(/[.$#[\]/]/);
      expect(decodeFirebaseKey(escaped)).toBe(raw);
    }
    expect(encodeFirebaseKey('A.B')).not.toBe(encodeFirebaseKey('A_B'));
    expect(decodeFirebaseKey(encodeFirebaseKey('A.B'))).toBe('A.B');
    expect(decodeFirebaseKey(encodeFirebaseKey('A_B'))).toBe('A_B');
  });

  it('mergeRoomStates prunes tombstones even when incomingState.tombstones is omitted and keeps newer idealLevels', () => {
    const now = Date.now();
    const localState: CloudRoomState = {
      roomCode: 'TST-01',
      updatedAt: now - 1000,
      catalogUpdatedAt: now - 1000,
      sessions: [],
      counts: [],
      products: [],
      contributors: {},
      idealLevels: { 'SKU-1': 10, 'SKU-OLD': 5 },
      idealLevelsUpdatedAt: now - 500,
      tombstones: {
        products: {
          '001': now - 40 * 24 * 60 * 60 * 1000, // expired > 30d -> pruned
          '002': now - 1000, // recent -> kept
        },
        counts: {
          c1: now - 40 * 24 * 60 * 60 * 1000, // expired -> pruned
        },
      },
    };

    const incomingWithoutTombstones: CloudRoomState = {
      roomCode: 'TST-01',
      updatedAt: now,
      catalogUpdatedAt: now,
      sessions: [],
      counts: [],
      products: [],
      contributors: {},
      idealLevels: { 'SKU-1': 25, 'SKU-NEW': 40 },
      idealLevelsUpdatedAt: now,
    };

    const merged = mergeRoomStates(localState, incomingWithoutTombstones);
    expect(merged.tombstones?.products?.['001']).toBeUndefined();
    expect(merged.tombstones?.products?.['002']).toBe(now - 1000);
    expect(merged.tombstones?.counts?.c1).toBeUndefined();
    expect(merged.idealLevels?.['SKU-1']).toBe(25);
    expect(merged.idealLevels?.['SKU-NEW']).toBe(40);
  });

  it('isValidSupervisorPin validates 4-digit pins and session separation stays idempotent', async () => {
    expect(isValidSupervisorPin('1234')).toBe(true);
    expect(isValidSupervisorPin('0000')).toBe(true);
    expect(isValidSupervisorPin('123')).toBe(false);
    expect(isValidSupervisorPin('12345')).toBe(false);
    expect(isValidSupervisorPin('abcd')).toBe(false);

    const techSess = await createSession('Turno Técnico', 'Luis');
    const supSess = await createSession('Auditoría Supervisor', 'Ana');

    await setActiveSession(techSess.id);
    await saveSettings({ techSessionId: techSess.id, supervisorSessionId: supSess.id });

    // Switch to supervisor and repeat idempotently
    await switchToSupervisorSession();
    expect((await getActiveSession())?.id).toBe(supSess.id);
    await switchToSupervisorSession();
    expect((await getActiveSession())?.id).toBe(supSess.id);

    // Switch back to technician and repeat idempotently
    await switchToTechnicianSession();
    expect((await getActiveSession())?.id).toBe(techSess.id);
    await switchToTechnicianSession();
    expect((await getActiveSession())?.id).toBe(techSess.id);
  });

  describe('dom.ts helpers hardening', () => {
    let prevDoc: any;
    let prevNode: any;
    let bodyChildren: any[];

    beforeEach(() => {
      prevDoc = (globalThis as any).document;
      prevNode = (globalThis as any).Node;
      bodyChildren = [];

      class FakeNode {
        childNodes: FakeNode[] = [];
        parentNode: FakeNode | null = null;
        isConnected = true;
        appendChild(c: FakeNode) {
          c.parentNode = this;
          this.childNodes.push(c);
          return c;
        }
        remove() {
          if (this.parentNode) {
            const idx = this.parentNode.childNodes.indexOf(this);
            if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
          } else {
            const idx = bodyChildren.indexOf(this);
            if (idx >= 0) bodyChildren.splice(idx, 1);
          }
        }
      }
      (globalThis as any).Node = FakeNode;

      class FakeEl extends FakeNode {
        tagName: string;
        className = '';
        attributes: Record<string, string> = {};
        listeners: Record<string, Array<(e?: any) => any>> = {};
        disabled = false;
        open = false;
        private _val = '';
        private _valAssignedWithChildrenCount = -1;

        constructor(tag: string) {
          super();
          this.tagName = tag.toUpperCase();
        }
        get value() {
          return this._val;
        }
        set value(v: string) {
          this._val = v;
          this._valAssignedWithChildrenCount = this.childNodes.length;
        }
        get valSetAfterChildren() {
          return this._valAssignedWithChildrenCount > 0;
        }
        setAttribute(k: string, v: string) {
          this.attributes[k] = String(v);
        }
        addEventListener(type: string, fn: (e?: any) => any) {
          (this.listeners[type] ??= []).push(fn);
        }
        click() {
          const fns = this.listeners.click ?? [];
          return Promise.all(fns.map((fn) => fn()));
        }
        showModal() {
          this.open = true;
        }
        close() {
          this.open = false;
          for (const fn of this.listeners.close ?? []) fn();
        }
        focus() {}
      }

      const body = new FakeEl('body');
      body.appendChild = (c: any) => {
        c.parentNode = body;
        body.childNodes.push(c);
        bodyChildren.push(c);
        return c;
      };

      (globalThis as any).document = {
        activeElement: null,
        body,
        createElement: (tag: string) => new FakeEl(tag),
        createTextNode: (text: string) => Object.assign(new FakeNode(), { textContent: text }),
      };
    });

    afterEach(() => {
      (globalThis as any).document = prevDoc;
      (globalThis as any).Node = prevNode;
    });

    it('fmtMoney handles NaN, Infinity, null, and undefined safely', () => {
      expect(fmtMoney(undefined)).toBe('—');
      expect(fmtMoney(null as any)).toBe('—');
      expect(fmtMoney(Number.NaN)).toBe('—');
      expect(fmtMoney(Number.POSITIVE_INFINITY)).toBe('—');
      expect(fmtMoney(42.5)).not.toBe('—');
    });

    it('h() applies value attribute after children are appended for select elements', () => {
      const sel = h(
        'select',
        { value: 'opt-b' },
        h('option', { value: 'opt-a' }, 'A'),
        h('option', { value: 'opt-b' }, 'B'),
      ) as any;
      expect(sel.value).toBe('opt-b');
      expect(sel.valSetAfterChildren).toBe(true);
    });

    it('openDialog guards async actions against duplicate clicks and omits empty actions', async () => {
      const noActionDlg = openDialog('Info', h('p', null, 'Mensaje'), []) as any;
      const hasActionsDiv = noActionDlg.childNodes.some((c: any) => c.className === 'dlg-actions');
      expect(hasActionsDiv).toBe(false);
      noActionDlg.close();

      let calls = 0;
      let release!: () => void;
      const pending = new Promise<void>((r) => {
        release = r;
      });

      const dlg = openDialog('Confirmar', h('p', null, 'Seguro?'), [
        {
          label: 'Enviar',
          kind: 'primary',
          onClick: async () => {
            calls++;
            await pending;
          },
        },
      ]) as any;

      expect(dlg.attributes['aria-labelledby']).toMatch(/^dlg-title-/);
      const actionsWrap = dlg.childNodes.find((c: any) => c.className === 'dlg-actions');
      const btn = actionsWrap.childNodes[0];

      const p1 = btn.click();
      const p2 = btn.click();
      expect(btn.disabled).toBe(true);
      expect(calls).toBe(1);

      release();
      await Promise.all([p1, p2]);
      expect(dlg.open).toBe(false);
    });
  });
});
