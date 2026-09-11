/** Orders writes without keeping credentials or replaying them into a new login. */
export function createSessionWriteQueue<Session>(current: () => Session | null) {
  const tails = new Map<string, Promise<unknown>>();
  let pending = 0;
  let revision = 0;
  return {
    state: () => ({ pending, revision }),
    run<T>(key: string, work: (assertCurrent: () => void) => Promise<T>): Promise<T> {
      const session = current();
      const assertCurrent = () => {
        if (!session || current() !== session)
          throw new Error("The Nuvio session changed while saving. Please try again.");
      };
      pending += 1;
      revision += 1;
      const run = (tails.get(key) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          assertCurrent();
          const value = await work(assertCurrent);
          assertCurrent();
          return value;
        });
      const settled = run.finally(() => {
        pending -= 1;
        revision += 1;
        if (tails.get(key) === settled) tails.delete(key);
      });
      tails.set(key, settled);
      return settled;
    },
  };
}
