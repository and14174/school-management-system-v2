import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, map, mapErr, ok, unwrap } from './result.js';

describe('Result', () => {
  it('ok() creates a success result', () => {
    const r = ok(42);
    expect(r).toEqual({ ok: true, value: 42 });
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
  });

  it('err() creates a failure result', () => {
    const r = err('boom');
    expect(r).toEqual({ ok: false, error: 'boom' });
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
  });

  it('unwrap() returns the value on success', () => {
    expect(unwrap(ok(7))).toBe(7);
  });

  it('unwrap() throws the error on failure', () => {
    expect(() => unwrap(err(new Error('nope')))).toThrow('nope');
  });

  it('unwrap() wraps a non-Error failure in an Error', () => {
    expect(() => unwrap(err('plain string'))).toThrow('plain string');
  });

  it('map() transforms the success value and leaves failure untouched', () => {
    expect(map(ok(2), (n) => n * 10)).toEqual({ ok: true, value: 20 });
    expect(map(err<number, string>('x'), (n) => n * 10)).toEqual({ ok: false, error: 'x' });
  });

  it('mapErr() transforms the error and leaves success untouched', () => {
    expect(mapErr(err('x'), (e) => `${e}!`)).toEqual({ ok: false, error: 'x!' });
    expect(mapErr(ok<number, string>(5), (e) => `${e}!`)).toEqual({ ok: true, value: 5 });
  });
});
