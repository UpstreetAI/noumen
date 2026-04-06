/**
 * Per-file async lock to serialize read-modify-write operations.
 *
 * Prevents TOCTOU races where concurrent edits to the same file read the
 * same content and silently overwrite each other's changes.
 */

const fileLocks = new Map<string, Promise<void>>();

/**
 * Execute `fn` while holding an exclusive lock on `filePath`. Concurrent
 * calls for the same path are serialized; different paths run in parallel.
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = fileLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  fileLocks.set(filePath, lock);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(filePath) === lock) {
      fileLocks.delete(filePath);
    }
  }
}
