/**
 * Fixed-capacity ring buffer backed by a Float64Array.
 *
 * Designed to replace `number[].push() + .shift()` patterns in PPG hot paths,
 * eliminating the O(N) cost of `Array.shift()` and reducing GC pressure.
 *
 * Semantics:
 *   - `push(v)` is O(1); when the buffer is full, the oldest value is overwritten.
 *   - Logical index `0` = oldest sample, `size - 1` = newest.
 *   - Numeric output of `toLastNArray(n)` matches `arr.slice(-n)` on the
 *     historical `number[]` it replaces.
 *
 * For zero-allocation hot paths, prefer `copyLastN(n, scratch)` with a
 * pre-allocated scratch `number[]` cached on the caller.
 */
export class NumericRingBuffer {
  private readonly data: Float64Array;
  private readonly capacity: number;
  private head = 0; // index of the oldest valid sample
  private _size = 0;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error("NumericRingBuffer capacity must be > 0");
    this.capacity = capacity;
    this.data = new Float64Array(capacity);
  }

  get size(): number {
    return this._size;
  }

  /** O(1) push. When full, oldest sample is overwritten. */
  push(v: number): void {
    if (this._size < this.capacity) {
      const writeIdx = (this.head + this._size) % this.capacity;
      this.data[writeIdx] = v;
      this._size++;
    } else {
      this.data[this.head] = v;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Logical access: 0 = oldest, size-1 = newest. */
  at(i: number): number {
    return this.data[(this.head + i) % this.capacity];
  }

  /** Returns the newest sample, or 0 if empty. */
  last(): number {
    return this._size === 0 ? 0 : this.data[(this.head + this._size - 1) % this.capacity];
  }

  /** Materializes the last `n` samples (oldest -> newest) as a fresh number[]. */
  toLastNArray(n: number): number[] {
    const len = Math.min(n, this._size);
    const out = new Array<number>(len);
    const start = this._size - len;
    for (let i = 0; i < len; i++) {
      out[i] = this.data[(this.head + start + i) % this.capacity];
    }
    return out;
  }

  /**
   * Copies the last `n` samples into `scratch` (resizing it to that length)
   * and returns it. Avoids per-call allocation if `scratch` is reused.
   */
  copyLastN(n: number, scratch: number[]): number[] {
    const len = Math.min(n, this._size);
    if (scratch.length !== len) scratch.length = len;
    const start = this._size - len;
    for (let i = 0; i < len; i++) {
      scratch[i] = this.data[(this.head + start + i) % this.capacity];
    }
    return scratch;
  }

  /** O(1) reset; does not deallocate the underlying typed array. */
  clear(): void {
    this.head = 0;
    this._size = 0;
    // Optional: zero-fill for deterministic dumps; not required for correctness.
    this.data.fill(0);
  }
}
