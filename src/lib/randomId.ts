/** getRandomValues is available on plain LAN HTTP as well as HTTPS.
 * This identifier is for worker coordination, never an authentication token.
 */
export function randomId(source: Pick<Crypto, "getRandomValues"> = globalThis.crypto): string {
  return Array.from(source.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
