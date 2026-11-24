import { describe, expect, it } from 'vitest';
import { setBounded, touch } from '../../src/shared/bounded-map';

describe('setBounded', () => {
  it('keeps at most max entries and drops the one set longest ago', () => {
    const map = new Map<string, number>();
    for (let i = 0; i < 5; i++) setBounded(map, `k${i}`, i, 3);
    expect([...map.keys()]).toEqual(['k2', 'k3', 'k4']);
  });

  it('setting a key again makes it the newest and does not grow the map', () => {
    const map = new Map<string, number>();
    setBounded(map, 'a', 1, 3);
    setBounded(map, 'b', 2, 3);
    setBounded(map, 'a', 10, 3);
    expect([...map.entries()]).toEqual([['b', 2], ['a', 10]]);
  });

  it('a max of zero keeps nothing', () => {
    const map = new Map<string, number>();
    setBounded(map, 'a', 1, 0);
    expect(map.size).toBe(0);
  });
});

describe('touch', () => {
  it('moves a key to the newest place with its value, and ignores an unknown key', () => {
    const map = new Map([['a', 1], ['b', 2]]);
    touch(map, 'a');
    touch(map, 'zzz');
    expect([...map.entries()]).toEqual([['b', 2], ['a', 1]]);
  });
});
