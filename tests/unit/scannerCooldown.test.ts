import { describe, expect, it } from 'vitest';
import { createDebouncer } from '../../src/scanner/scanner';

describe('createDebouncer y control de escaneo', () => {
  it('rebota lecturas repetidas dentro del intervalo', () => {
    const debouncer = createDebouncer(1000);
    expect(debouncer('123456')).toBe(true);
    // lectura inmediata del mismo código debe ser rechazada
    expect(debouncer('123456')).toBe(false);
  });

  it('permite códigos distintos', () => {
    const debouncer = createDebouncer(1000);
    expect(debouncer('AAA')).toBe(true);
    expect(debouncer('BBB')).toBe(true);
  });

  it('permite reiniciar el estado con reset()', () => {
    const debouncer = createDebouncer(5000);
    expect(debouncer('CODE1')).toBe(true);
    expect(debouncer('CODE1')).toBe(false);
    debouncer.reset();
    expect(debouncer('CODE1')).toBe(true);
  });
});
