// Tiny buffer-shape helpers. Uint8Array ↔ ArrayBuffer conversions show up
// at every IPC boundary; doing them inline breeds `as ArrayBuffer` casts
// and off-by-one mistakes when the underlying buffer has a non-zero
// byteOffset (common when slicing views). Always route through these.

/**
 * Uint8Array (or a view over a SharedArrayBuffer / ArrayBuffer subset) →
 * a standalone transferable ArrayBuffer. Copies. Always produces a buffer
 * whose byteLength === u.byteLength.
 */
export function u8ToAb(u: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u.byteLength);
  new Uint8Array(ab).set(u);
  return ab;
}

/** ArrayBuffer → Uint8Array. No copy. */
export function abToU8(ab: ArrayBuffer): Uint8Array {
  return new Uint8Array(ab);
}

/** Uint8Array → Blob for <img>/canvas/URL.createObjectURL consumption. */
export function bytesToBlob(u: Uint8Array, mime: string): Blob {
  // The `new Uint8Array(bytes) as unknown as ArrayBuffer` dance is here
  // once, not 15 times, so the Blob overload resolves cleanly.
  return new Blob([u8ToAb(u)], { type: mime });
}
