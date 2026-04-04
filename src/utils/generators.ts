interface QueuedGenerator<A> {
  done: boolean | undefined;
  value: A;
  generator: AsyncGenerator<A, void>;
  promise: Promise<QueuedGenerator<A>>;
}

/**
 * Run multiple async generators concurrently up to a concurrency cap,
 * yielding values as they become available. Generators beyond the cap
 * are started as earlier ones finish.
 */
export async function* all<A>(
  generators: AsyncGenerator<A, void>[],
  concurrencyCap = Infinity,
): AsyncGenerator<A, void> {
  const next = (generator: AsyncGenerator<A, void>) => {
    const promise: Promise<QueuedGenerator<A>> = generator
      .next()
      .then(({ done, value }) => ({
        done,
        value: value as A,
        generator,
        promise,
      }));
    return promise;
  };

  const waiting = [...generators];
  const promises = new Set<Promise<QueuedGenerator<A>>>();

  while (promises.size < concurrencyCap && waiting.length > 0) {
    const gen = waiting.shift()!;
    promises.add(next(gen));
  }

  while (promises.size > 0) {
    const { done, value, generator, promise } = await Promise.race(promises);
    promises.delete(promise);

    if (!done) {
      promises.add(next(generator));
      if (value !== undefined) {
        yield value;
      }
    } else if (waiting.length > 0) {
      const nextGen = waiting.shift()!;
      promises.add(next(nextGen));
    }
  }
}
