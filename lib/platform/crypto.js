// Secret encryption for the control plane (Session 20; key-versioned S28).
// AES-256-GCM via crypto.subtle — edge- and node-safe. We hold merchants'
// Shopify/Razorpay credentials, so they never sit in plaintext at rest.
//
// Envelope (S28 / BE13): `k1:<keyfp>:<base64(iv[12] || ciphertext+tag)>` where
// keyfp = first 8 hex of SHA-256("storeasy-keyid|" + secret) — identifies WHICH
// platform secret encrypted the blob without revealing anything about it.
// Legacy blobs (bare base64, pre-S28) stay readable.
//
// Rotation (dual-read / single-write — nothing is ever orphaned):
//   1. set PLATFORM_SECRET_NEXT=<new secret> and deploy
//      → reads accept BOTH keys; every new write uses NEXT
//   2. run `pnpm rotate:secrets` — re-encrypts all stored blobs under NEXT
//   3. move NEXT into PLATFORM_SECRET, unset PLATFORM_SECRET_NEXT, deploy

const te = new TextEncoder();
const td = new TextDecoder();

const keyCache = new Map(); // secret string → { key: CryptoKey, fp }

async function materialize(secret) {
  const hit = keyCache.get(secret);
  if (hit) return hit;
  const digest = await crypto.subtle.digest("SHA-256", te.encode(secret));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
  const fpDigest = await crypto.subtle.digest("SHA-256", te.encode(`storeasy-keyid|${secret}`));
  const fp = Array.from(new Uint8Array(fpDigest))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const entry = { key, fp };
  keyCache.set(secret, entry);
  return entry;
}

// All configured secrets, WRITE key first (NEXT wins while a rotation is open).
function configuredSecrets() {
  const current = process.env.PLATFORM_SECRET;
  if (!current) throw new Error("PLATFORM_SECRET is not set");
  const next = process.env.PLATFORM_SECRET_NEXT;
  return next && next !== current ? [next, current] : [current];
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptSecret(plaintext) {
  if (plaintext == null) return null;
  const { key, fp } = await materialize(configuredSecrets()[0]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(String(plaintext)));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return `k1:${fp}:${b64(out.buffer)}`;
}

async function decryptWith(secret, blobB64) {
  const { key } = await materialize(secret);
  const raw = unb64(blobB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
  return td.decode(pt);
}

export async function decryptSecret(encoded) {
  if (!encoded) return null;
  const secrets = configuredSecrets();
  let blob = String(encoded);
  let preferredFp = null;
  if (blob.startsWith("k1:")) {
    const [, fp, rest] = blob.split(":");
    preferredFp = fp;
    blob = rest;
  }
  // try the fingerprint's key first, then every other configured key
  // (dual-read: pre-rotation blobs keep working while NEXT is live)
  const ordered = [...secrets];
  if (preferredFp) {
    for (const s of secrets) {
      if ((await materialize(s)).fp === preferredFp) {
        ordered.splice(ordered.indexOf(s), 1);
        ordered.unshift(s);
        break;
      }
    }
  }
  let lastErr;
  for (const s of ordered) {
    try {
      return await decryptWith(s, blob);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("decryption failed");
}

// Diagnostics only — fingerprints, never key material.
export async function keyIds() {
  const out = [];
  for (const s of configuredSecrets()) out.push((await materialize(s)).fp);
  return out; // [write key, ...read-only keys]
}

export const encryptJson = async (obj) => encryptSecret(JSON.stringify(obj ?? {}));
export async function decryptJson(encoded) {
  const s = await decryptSecret(encoded);
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
