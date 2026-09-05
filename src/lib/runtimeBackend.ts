let current: { backendUrl: string; publishableKey: string } | null = null;
export function runtimeBackend() { return current; }
export async function loadRuntimeBackend() {
  try {
    const response = await fetch("/api/companion/config", { signal: AbortSignal.timeout(1500), cache: "no-store" });
    if (!response.ok) return;
    const value = await response.json() as { backendUrl?: string; publishableKey?: string };
    if (value.backendUrl?.startsWith("https://") && value.publishableKey) current = { backendUrl: value.backendUrl, publishableKey: value.publishableKey };
  } catch { /* Static hosting keeps the compiled upstream defaults. */ }
}
