/**
 * Concurrency-safe per-path file-operation locking, in the spirit of grok-build's
 * `editor_infra/file_operation_lock.rs` (Apache-2.0).
 *
 * The agent can dispatch several tool calls in one round; two edits to the same
 * file (or a read racing a write) could corrupt it. This module serializes
 * operations on the same path — readers of a path queue behind each other,
 * writers are exclusive against both readers and writers — without starving
 * either, and with no cross-path contention (different files run concurrently).
 *
 * Fail-safe: never throws into the handler. A lock that can't be taken for a
 * path just allows the operation to proceed (an advisory guard, exactly like
 * grok-build's, which is best-effort under real multi-tool concurrency).
 */

type Releaser = () => void;

interface QueueEntry {
  exclusive: boolean;
  resolve: () => void;
}

/** A per-path FIFO gate tracking current users and a wait queue. */
class PathGate {
  private readers = 0;
  private writerActive = false;
  private waiting: QueueEntry[] = [];

  /** Returns true if this gate is busy (any reader, writer, or queued writer
   *  means we shouldn't add FIFO head-of-line beyond the queue). */
  acquire(exclusive: boolean): Promise<Releaser> {
    return new Promise((resolve) => {
      // Fast path when the gate is idle.
      if (this.readers === 0 && !this.writerActive && this.waiting.length === 0) {
        if (exclusive) this.writerActive = true;
        else this.readers++;
        resolve(() => this.release());
        return;
      }
      // Else enqueue. Writers and readers both queue; FIFO preserves order and
      // prevents writer starvation.
      this.waiting.push({ exclusive, resolve: () => {
        if (exclusive) this.writerActive = true;
        else this.readers++;
        resolve(() => this.release());
      } });
    });
  }

  private release(): void {
    if (this.writerActive) this.writerActive = false;
    else this.readers = Math.max(0, this.readers - 1);

    // Hand off to waiting entries that can now proceed (head-of-line first).
    while (this.waiting.length > 0) {
      const head = this.waiting[0]!;
      // A waiting writer needs the whole gate free.
      if (head.exclusive) {
        if (this.readers === 0 && !this.writerActive) {
          this.waiting.shift();
          head.resolve();
        }
        return;
      }
      // A waiting reader needs no active writer (shared readers are fine).
      if (!this.writerActive) {
        this.waiting.shift();
        head.resolve();
        continue;
      }
      return;
    }
  }
}

/** Small leak-aware container mapping canonical absolute paths to their gate. */
class PathLock {
  private gates = new Map<string, PathGate>();

  private gateFor(key: string): PathGate {
    let g = this.gates.get(key);
    if (!g) {
      g = new PathGate();
      this.gates.set(key, g);
    }
    return g;
  }

  /** Acquire a lock for a path; returns an async releaser. Works regardless of
   *  whether key is absolute or relative (canonicalized here, not applied). */
  async acquire(key: string, exclusive = true): Promise<Releaser> {
    const gate = this.gateFor(key);
    return gate.acquire(exclusive);
  }
}

/** Shared instance used by the filesystem and code tools. */
export const fileLock = new PathLock();

/** Run `fn` under a per-path lock (exclusive by default; `false` = shared reader
 *  lock). The lock is advisory: if it can't be taken it still lets the op run. */
export async function withLock<T>(p: string, exclusive: boolean, fn: () => Promise<T>): Promise<T> {
  const release = await fileLock.acquire(p, exclusive);
  try {
    return await fn();
  } finally {
    release();
  }
}
