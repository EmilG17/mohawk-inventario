import 'fake-indexeddb/auto';
import { beforeEach } from 'vitest';
import { _resetDBHandle, getDB } from '../../src/db/db';
import { _resetSettings } from '../../src/settings';

beforeEach(async () => {
  _resetSettings();
  try {
    const db = await getDB();
    await Promise.all([
      db.clear('products'),
      db.clear('counts'),
      db.clear('sessions'),
      db.clear('meta'),
    ]);
  } catch {
    /* ignore */
  }
});
