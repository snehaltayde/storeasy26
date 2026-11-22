// Cloudflare R2 / S3-compatible object storage adapter (Phase 1.2).
// 100% Edge-safe: uses Web Crypto API (crypto.subtle) for AWS SigV4 signing +
// standard fetch. Zero node:* imports.
//
// When R2_* environment variables are unset, isR2Configured() returns false and
// lib/media.js seamlessly falls back to Turso/SQLite BLOB storage.

const MIME_EXT = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/svg+xml": "svg",
});

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function readConfig(env = process.env) {
  const bucket = (env.R2_BUCKET || "").trim();
  const accessKeyId = (env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (env.R2_SECRET_ACCESS_KEY || "").trim();
  const accountId = (env.R2_ACCOUNT_ID || "").trim();
  const rawEndpoint = (env.R2_ENDPOINT || "").trim() || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  const endpoint = rawEndpoint.replace(/\/+$/, "");
  const publicUrl = (env.R2_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  const region = (env.R2_REGION || "auto").trim() || "auto";
  return { bucket, accessKeyId, secretAccessKey, endpoint, publicUrl, region };
}

export function isR2Configured(env = process.env) {
  const c = readConfig(env);
  return Boolean(c.bucket && c.accessKeyId && c.secretAccessKey && c.endpoint);
}

export function r2PublicOrigin(env = process.env) {
  const { publicUrl } = readConfig(env);
  if (!publicUrl) return null;
  try {
    return new URL(publicUrl);
  } catch {
    return null;
  }
}

export function objectKey({ tenantId, sha256, mime }) {
  const safeTenant = String(tenantId || "_default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "_default";
  const safeHash = String(sha256 || "").replace(/[^a-f0-9]/gi, "").toLowerCase();
  if (!safeHash) throw new Error("media-storage: sha256 is required");
  const ext = MIME_EXT[mime] || "bin";
  return `tenants/${safeTenant}/${safeHash}.${ext}`;
}

export function r2KeyFromStorageUrl(storageUrl, env = process.env) {
  if (typeof storageUrl !== "string" || !storageUrl) return null;
  if (storageUrl.startsWith("r2://")) return storageUrl.slice(5);
  const { publicUrl } = readConfig(env);
  if (publicUrl && storageUrl.startsWith(`${publicUrl}/`)) return storageUrl.slice(publicUrl.length + 1);
  return null;
}

const enc = new TextEncoder();

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(hash);
}

async function hmacSha256(keyBytes, message) {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)));
}

function formatAmzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function encodeRfc3986Path(pathname) {
  return pathname
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

// Pure AWS Signature V4 request signer (Edge-safe, deterministic for tests).
export async function signS3Request({
  method,
  url,
  headers = {},
  payloadHash = EMPTY_SHA256,
  accessKeyId,
  secretAccessKey,
  region = "auto",
  service = "s3",
  now = new Date(),
}) {
  const u = new URL(url);
  const { amzDate, dateStamp } = formatAmzDate(now);
  const lowerHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v != null) lowerHeaders[k.toLowerCase()] = String(v).trim();
  }
  lowerHeaders["host"] = u.host;
  lowerHeaders["x-amz-content-sha256"] = payloadHash;
  lowerHeaders["x-amz-date"] = amzDate;

  const sortedKeys = Object.keys(lowerHeaders).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${lowerHeaders[k]}\n`).join("");
  const signedHeaders = sortedKeys.join(";");

  const sortedQuery = [...u.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    method.toUpperCase(),
    encodeRfc3986Path(u.pathname),
    sortedQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmacSha256(enc.encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  return {
    ...lowerHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function objectUrl(cfg, key) {
  return `${cfg.endpoint}/${encodeURIComponent(cfg.bucket)}/${key}`;
}

export async function uploadToR2({ tenantId, sha256, mime, bytes, env = process.env, fetchImpl = fetch }) {
  const cfg = readConfig(env);
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.endpoint) {
    throw new Error("media-storage: R2 is not configured");
  }
  const key = objectKey({ tenantId, sha256, mime });
  const url = objectUrl(cfg, key);
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const payloadHash = sha256 || (await sha256Hex(body));
  const signedHeaders = await signS3Request({
    method: "PUT",
    url,
    headers: {
      "content-type": mime,
      "cache-control": "public, max-age=31536000, immutable",
    },
    payloadHash,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
  });
  // Do not pass synthetic host header to fetch (runtime sets it from URL).
  const { host: _host, ...fetchHeaders } = signedHeaders;
  const res = await fetchImpl(url, { method: "PUT", headers: fetchHeaders, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`media-storage: R2 PUT failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const storageUrl = cfg.publicUrl ? `${cfg.publicUrl}/${key}` : `r2://${key}`;
  return { key, storageUrl };
}

export async function getFromR2({ key, env = process.env, fetchImpl = fetch }) {
  const cfg = readConfig(env);
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.endpoint) {
    throw new Error("media-storage: R2 is not configured");
  }
  const url = objectUrl(cfg, key);
  const signedHeaders = await signS3Request({
    method: "GET",
    url,
    payloadHash: EMPTY_SHA256,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
  });
  const { host: _host, ...fetchHeaders } = signedHeaders;
  const res = await fetchImpl(url, { method: "GET", headers: fetchHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`media-storage: R2 GET failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function deleteFromR2({ key, env = process.env, fetchImpl = fetch }) {
  const cfg = readConfig(env);
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.endpoint) return false;
  const url = objectUrl(cfg, key);
  const signedHeaders = await signS3Request({
    method: "DELETE",
    url,
    payloadHash: EMPTY_SHA256,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
  });
  const { host: _host, ...fetchHeaders } = signedHeaders;
  const res = await fetchImpl(url, { method: "DELETE", headers: fetchHeaders });
  return res.ok || res.status === 404;
}
