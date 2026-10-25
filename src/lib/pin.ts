const ITERATIONS = 120_000;
const KEY_LENGTH = 256;
const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashPin(pin: string, saltHex?: string): Promise<{ salt: string; hash: string }> {
  if (!globalThis.crypto?.subtle) throw new Error('Le chiffrement sécurisé nécessite HTTPS ou localhost.');
  const saltBytes = saltHex
    ? Uint8Array.from(saltHex.match(/.{1,2}/g) ?? [], (part) => parseInt(part, 16))
    : crypto.getRandomValues(new Uint8Array(16));
  const salt = saltHex ?? toHex(saltBytes);
  const key = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: ITERATIONS, hash: 'SHA-256' }, key, KEY_LENGTH);
  return { salt, hash: toHex(new Uint8Array(bits)) };
}

export async function verifyPin(pin: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = await hashPin(pin, salt);
  if (actual.hash.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.hash.length; i++) diff |= actual.hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  return diff === 0;
}
