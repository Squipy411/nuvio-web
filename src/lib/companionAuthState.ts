type Authorization = { csrf: string; expires: number };
let current: Authorization | null = null;
let flight: Promise<Authorization> | null = null;
let epoch = 0;

/** Only the opaque companion CSRF nonce is held here, never Nuvio credentials. */
export function clearCompanionAuthorization() {
  epoch++;
  current = null;
  flight = null;
}

export function peekCompanionAuthorization() { return current; }

export function companionAuthorization(exchange: () => Promise<Authorization>) {
  if (current && current.expires > Date.now() + 60_000) return Promise.resolve(current);
  if (flight) return flight;
  const version = epoch;
  const pending = exchange().then((value) => {
    if (version !== epoch) throw new Error("The signed-in account changed. Open the source again.");
    current = value;
    return value;
  }).finally(() => { if (flight === pending) flight = null; });
  flight = pending;
  return pending;
}
