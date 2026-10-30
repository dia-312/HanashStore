// The PIN unlocks the app offline, so a salted hash of it lives on the device (SPEC section 13).
// It is PBKDF2 from WebCrypto; the server keeps its own argon2id hash of the same PIN.

const ITERATIONS = 310_000

export interface PinRecord {
  salt: string
  hash: string
  iterations: number
  length: number
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  )
  return toB64(new Uint8Array(bits))
}

export const isValidPin = (pin: string) => /^\d{4,6}$/.test(pin)

export async function createPinRecord(pin: string, iterations = ITERATIONS): Promise<PinRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return {
    salt: toB64(salt),
    hash: await derive(pin, salt, iterations),
    iterations,
    length: pin.length,
  }
}

export async function verifyPin(record: PinRecord, pin: string): Promise<boolean> {
  const candidate = await derive(pin, fromB64(record.salt), record.iterations)
  // Same length strings of a fixed-size hash; a plain compare leaks nothing useful here.
  return candidate === record.hash
}
