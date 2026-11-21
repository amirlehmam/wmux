/**
 * Set `key` in `map` and keep at most `max` entries: the one set longest ago goes first.
 *
 * A Map iterates in insertion order, so deleting before setting moves a re-set key to the
 * newest place; `touch` does the same for a key that was only read.
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/** Mark `key` as the newest entry without changing its value (a read that should keep it). */
export function touch<K, V>(map: Map<K, V>, key: K): void {
  if (!map.has(key)) return;
  const value = map.get(key) as V;
  map.delete(key);
  map.set(key, value);
}
