/** Clipboard API needs HTTPS; the local dashboard is also useful on plain LAN HTTP. */
export async function copyText(value: string): Promise<boolean> {
  try { if (navigator.clipboard) { await navigator.clipboard.writeText(value); return true; } } catch { /* Try the user-gesture fallback below. */ }
  const previous = document.activeElement;
  const input = document.createElement("textarea"); input.value = value; input.readOnly = true;
  input.style.position = "fixed"; input.style.opacity = "0"; input.style.pointerEvents = "none";
  document.body.append(input); input.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { /* The visible diagnostics remain selectable. */ }
  input.remove(); if (previous instanceof HTMLElement) previous.focus(); return copied;
}
