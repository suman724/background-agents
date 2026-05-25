/**
 * Secure-context-safe UUIDv4 generator.
 *
 * `crypto.randomUUID()` is only exposed on `window.crypto` in **secure contexts**
 * (HTTPS, or `localhost` over plain HTTP). The dev server bound to a LAN IP and
 * accessed via `http://192.168.x.y:3000` is NOT a secure context, so the page
 * crashes with `TypeError: crypto.randomUUID is not a function`.
 *
 * `crypto.getRandomValues()` IS available in insecure contexts, so we use it
 * to assemble a UUIDv4 ourselves when `randomUUID` is missing.
 *
 * Tracked: GitHub issue #31.
 */
export function randomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // UUIDv4 layout
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
