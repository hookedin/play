/** Bound independent reads and wait for every in-flight read before returning. */
export async function mapBounded<T, R>(values: Iterable<T>, fn: (value: T) => R | Promise<R>): Promise<R[]> {
  const rows = [...values],
    result = new Array<R>(rows.length);
  let cursor = 0,
    failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(8, rows.length) }, async () => {
      while (!failure && cursor < rows.length) {
        const index = cursor++;
        try {
          result[index] = await fn(rows[index]);
        } catch (error) {
          failure = error;
        }
      }
    }),
  );
  if (failure) throw failure;
  return result;
}
