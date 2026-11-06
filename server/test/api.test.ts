import { describe, expect, it } from 'vitest';
import { corsAllowOrigin, routeFilter } from '../src/api';

describe('routeFilter', () => {
  it('returns null (no filter) when the parameter is absent or empty', () => {
    expect(routeFilter(undefined)).toBeNull();
    expect(routeFilter({})).toBeNull();
    expect(routeFilter({ routes: '' })).toBeNull();
    expect(routeFilter({ routes: ['101'] })).toBeNull();
  });

  it('keeps only values that look like route ids', () => {
    expect([...routeFilter({ routes: ' 101 ,T01,D01' })!]).toEqual(['101', 'T01', 'D01']);
    expect([...routeFilter({ routes: '../etc/passwd,<script>,101' })!]).toEqual(['101']);
    expect(routeFilter({ routes: '<script>' })!.size).toBe(0);
  });

  it('caps the number of ids', () => {
    const many = Array.from({ length: 500 }, (_, i) => `R${i}`).join(',');
    expect(routeFilter({ routes: many })!.size).toBeLessThanOrEqual(200);
  });
});

describe('corsAllowOrigin', () => {
  it('reflects only configured origins', () => {
    expect(corsAllowOrigin('*', 'https://evil.test')).toBe('*');
    expect(corsAllowOrigin('https://a.test, https://b.test', 'https://b.test')).toBe('https://b.test');
    expect(corsAllowOrigin('https://a.test', 'https://evil.test')).toBeNull();
    expect(corsAllowOrigin('https://a.test', undefined)).toBeNull();
  });
});
