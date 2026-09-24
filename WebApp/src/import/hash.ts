/**
 * Deterministic task uuids for imported rows/events, identical on Android so re-importing the
 * same file on either device updates instead of duplicating:
 *
 *   uuid = prefix + first 24 lowercase hex chars of SHA-256( UTF-8( parts.join("\u001f") ) )
 *
 * "\u001f" is the ASCII Unit Separator (0x1F); it never occurs in normal text, so
 * ("ab", "c") and ("a", "bc") hash differently.
 */
export const UUID_FIELD_SEPARATOR = '\u001f';
const UUID_HEX_LENGTH = 24;

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function deterministicUuid(prefix: string, parts: string[]): Promise<string> {
  const hex = await sha256Hex(parts.join(UUID_FIELD_SEPARATOR));
  return prefix + hex.slice(0, UUID_HEX_LENGTH);
}
