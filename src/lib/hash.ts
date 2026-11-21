/**
 * Compare text by its visible content, not by the bytes used for line endings.
 * A CRLF note and an LF note with the same words are the SAME note: treating
 * them as different makes sync report a false "both sides edited" conflict.
 * Shared by content hashing and the history diff so both use one definition.
 * Vault paths / file names contain no line breaks, so this is a no-op for them.
 */
export function normalizeEol(input: string): string {
  return String(input ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/**
 * FNV-1a 64-bit-ish content fingerprint, implemented identically on the
 * client (lib/hash.ts) and the sync server (server/index.mjs).
 * Used for three-way conflict detection: the client sends the hash of the
 * content it started editing from, the server compares it with what is
 * currently on disk. A server restart therefore never causes a false conflict.
 * Stored version content is never rewritten — normalization is hash-only.
 */
export function fnv1a(input: string): string {
  const s = normalizeEol(input)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= s.charCodeAt(i)
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}
