// Size-bounded LRU (Map insertion order = recency).

export class Lru<K, V> {
  private readonly map = new Map<K, { v: V; size: number }>();
  private used = 0;
  readonly budget: number;
  private readonly sizeOf: (v: V) => number;

  constructor(budget: number, sizeOf: (v: V) => number = () => 1) {
    this.budget = budget;
    this.sizeOf = sizeOf;
  }

  get(k: K): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }

  set(k: K, v: V): void {
    const size = this.sizeOf(v);
    if (size > this.budget / 4) return; // never let one entry flush the cache
    const old = this.map.get(k);
    if (old) {
      this.used -= old.size;
      this.map.delete(k);
    }
    this.map.set(k, { v, size });
    this.used += size;
    while (this.used > this.budget) {
      const first = this.map.keys().next();
      if (first.done) break;
      const e = this.map.get(first.value)!;
      this.used -= e.size;
      this.map.delete(first.value);
    }
  }

  clear(): void {
    this.map.clear();
    this.used = 0;
  }

  get bytes(): number {
    return this.used;
  }
}
