/**
 * The browser's answer to `platform.auth`: a Worker that holds the session.
 *
 * The access token never reaches the page. Sign-in happens inside this Worker,
 * which keeps the token and makes the account calls itself; the Window is told
 * who is signed in and nothing more. A script that manages to run on the page
 * still cannot read a credential it was never given.
 *
 * That is a browser answer to a browser problem. A shell holding the session
 * outside the webview entirely has no page for a token to leak onto, and
 * implements this contract its own way — which is why the four calls below are
 * a capability rather than something `account.ts` reaches for directly.
 */

import type { AuthApi } from "../platform/types.ts";
import type { BackendConfig, Session } from "../types";
import { clearCompanionAuthorization } from "./companionAuthState.ts";

type VaultCommand =
  | { type: "companionSession" }
  | { type: "signIn"; backend: BackendConfig; email: string; password: string }
  | { type: "signOut" }
  | { type: "restore" }
  | {
      type: "request";
      path: string;
      init: { method?: string; body?: string; headers?: Record<string, string> };
    };

type VaultResponse =
  | { type: "sessionLost" }
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

let vaultMessageId = 0;
const vaultPending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
const lostListeners = new Set<() => void>();
function notifySessionLost() {
  clearCompanionAuthorization();
  for (const listener of lostListeners) listener();
}

/**
 * Started on first use rather than at import.
 *
 * Reaching this module no longer implies wanting a session: it is behind the
 * capability layer now, so anything that asks the platform for anything at all
 * would otherwise spawn a Worker — including a test runner, which has no
 * `Worker` to spawn and fails at the import.
 */
let tokenVault: Worker | null = null;
function vault(): Worker {
  if (tokenVault) return tokenVault;
  const worker = new Worker(new URL("../workers/authWorker.ts", import.meta.url), {
    type: "module",
    name: "nuvio-token-vault",
  });

  worker.addEventListener("message", (event: MessageEvent<VaultResponse>) => {
    if ("type" in event.data && event.data.type === "sessionLost") {
      notifySessionLost();
      return;
    }
    if (!("id" in event.data)) return;
    const pending = vaultPending.get(event.data.id);
    if (!pending) return;
    vaultPending.delete(event.data.id);
    if (event.data.ok) pending.resolve(event.data.value);
    else pending.reject(new Error(event.data.error));
  });

  worker.addEventListener("error", () => {
    for (const pending of vaultPending.values())
      pending.reject(new Error("The secure session worker stopped unexpectedly."));
    vaultPending.clear();
    // Announced rather than returned: the vault can fail while nothing is
    // waiting on it, and a session believed to be live is worse than none.
    worker.terminate();
    if (tokenVault === worker) tokenVault = null;
    notifySessionLost();
  });

  tokenVault = worker;
  return worker;
}

function vaultCall<T>(command: VaultCommand): Promise<T> {
  if (["signIn", "signOut", "restore"].includes(command.type)) clearCompanionAuthorization();
  const id = ++vaultMessageId;
  const worker = vault();
  return new Promise<T>((resolve, reject) => {
    vaultPending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    worker.postMessage({ id, ...command });
  });
}

export const authVault: AuthApi = {
  companionSession: () => vaultCall<{ csrf: string; expires: number }>({ type: "companionSession" }),
  signIn: (backend, email, password) =>
    vaultCall<Session>({ type: "signIn", backend, email, password }),
  restore: () => vaultCall<Session>({ type: "restore" }),
  signOut: () => vaultCall<void>({ type: "signOut" }),
  request: <T>(
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ) => vaultCall<T>({ type: "request", path, init }),
  onSessionLost(listener) {
    lostListeners.add(listener);
    return () => lostListeners.delete(listener);
  },
};
