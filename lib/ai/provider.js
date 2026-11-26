// Phase 9 line 5: the one door to a language model. SERVER-ONLY (console routes
// and the copilot; never a storefront import).
//
//   complete({ system, user, maxTokens, schema?, model?, task? })
//     -> { text, tokensIn, tokensOut, provider, model }
//   aiProvider()   -> { provider, model, configured, reason }
//
// AI_PROVIDER picks it: anthropic (the default), openai, gemini, or stub.
//   anthropic  POST /v1/messages (raw HTTP, as lib/ai/insights.js always did:
//              no SDK dependency). Model claude-sonnet-5-5 unless AI_MODEL
//              says otherwise. maxTokens is max_tokens, which on current
//              models covers thinking AND the visible reply, so a caller that
//              reserves maxTokens has reserved the whole output. With a
//              schema, the reply is constrained by output_config.format
//              (json_schema) and the default model gets the server-side
//              refusal fallback. Docs read 2026-11-26 (claude-api skill).
//   openai     Chat Completions; AI_MODEL is required (no guessed model id).
//   gemini     generateContent; AI_MODEL is required.
//   stub       tests and drills only: answers from a responder (tests) or a
//              fixture file AI_STUB_DIR/<task>.json (drills), records every
//              outgoing body, and REFUSES in production.
// No key -> configured false and the honest "not set up" words; never a mock.
// A failure to reach the provider is AI_UNAVAILABLE (DOC-04: never mistaken
// for a database failure); a model refusal is AI_REFUSED.
import { slog } from "../log.js";

export const PROVIDERS = Object.freeze(["anthropic", "openai", "gemini", "stub"]);
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
const KEYS = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" };

export const AI_UNAVAILABLE_MESSAGE = "We couldn't reach the AI service just now, so no ideas were made and nothing was stored. Try again in a minute.";

export class AiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const env = (k) => (process.env[k] == null ? "" : String(process.env[k]).trim());
export const isProduction = () => env("NODE_ENV") === "production" || env("VERCEL_ENV") === "production";
export const providerName = () => env("AI_PROVIDER").toLowerCase() || "anthropic";

// -> { provider, model, configured, reason }
export function aiProvider() {
  const provider = providerName();
  if (!PROVIDERS.includes(provider)) return { provider, model: null, configured: false, reason: `AI_PROVIDER "${provider.slice(0, 20)}" isn't one we know (anthropic, openai or gemini).` };
  if (provider === "stub") {
    if (isProduction()) return { provider, model: "stub", configured: false, reason: "The test AI provider can't run in production." };
    return { provider, model: "stub", configured: true, reason: null };
  }
  const model = env("AI_MODEL") || (provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : null);
  if (!env(KEYS[provider])) return { provider, model, configured: false, reason: `The AI service isn't set up: ${KEYS[provider]} is missing.` };
  if (!model) return { provider, model: null, configured: false, reason: `The AI service isn't set up: ${provider} needs AI_MODEL (we don't guess model names).` };
  return { provider, model, configured: true, reason: null };
}

// ---- test seams ----------------------------------------------------------------

let fetchImpl = (...a) => globalThis.fetch(...a);
export const __setFetch = (fn) => {
  fetchImpl = fn || ((...a) => globalThis.fetch(...a));
};
let stubResponder = null;
const stubLog = [];
// fn({ system, user, maxTokens, schema, task }) -> { text, tokensIn?, tokensOut? } | throws
export const __setStubResponder = (fn) => {
  stubResponder = fn || null;
};
// every body the stub was sent, in order (the zero-PII test scans them)
export const stubCalls = () => stubLog.slice();
export const __clearStubCalls = () => {
  stubLog.length = 0;
};

// ---- the call ------------------------------------------------------------------

const unavailable = (e) => {
  slog("ai_provider_unreachable", { error: String(e?.cause?.code || e?.message || e).slice(0, 120) });
  return new AiError("AI_UNAVAILABLE", AI_UNAVAILABLE_MESSAGE);
};

async function post(url, headers, body) {
  let res;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  } catch (e) {
    throw unavailable(e);
  }
  if (!res.ok) {
    // the words insights always gave (its route answers them as before)
    slog("ai_provider_failed", { status: res.status });
    throw new AiError("AI_FAILED", `model call failed (${res.status})`);
  }
  return res.json();
}

// The request body /v1/messages gets. Without a schema it is exactly what
// lib/ai/insights.js always sent (model, max_tokens, system, messages).
export function anthropicBody({ system, user, maxTokens, schema, model }) {
  const body = { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] };
  if (schema) {
    body.output_config = { effort: "medium", format: { type: "json_schema", schema } };
    if (model === DEFAULT_ANTHROPIC_MODEL) body.fallbacks = "default";
  }
  return body;
}

async function anthropic({ system, user, maxTokens, schema, model }) {
  const body = anthropicBody({ system, user, maxTokens, schema, model });
  const headers = { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" };
  if (body.fallbacks) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  const json = await post("https://api.anthropic.com/v1/messages", headers, body);
  if (json?.stop_reason === "refusal") throw new AiError("AI_REFUSED", "The AI service declined this request, so nothing was made. Try again with different products.");
  const text = (json?.content || []).filter((c) => c?.type === "text").map((c) => c.text || "").join("");
  return { text, tokensIn: Number(json?.usage?.input_tokens) || 0, tokensOut: Number(json?.usage?.output_tokens) || 0 };
}

async function openai({ system, user, maxTokens, schema, model }) {
  const body = {
    model,
    max_completion_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } } } : {}),
  };
  const json = await post("https://api.openai.com/v1/chat/completions", { authorization: `Bearer ${env("OPENAI_API_KEY")}` }, body);
  return { text: String(json?.choices?.[0]?.message?.content || ""), tokensIn: Number(json?.usage?.prompt_tokens) || 0, tokensOut: Number(json?.usage?.completion_tokens) || 0 };
}

async function gemini({ system, user, maxTokens, schema, model }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, ...(schema ? { responseMimeType: "application/json" } : {}) },
  };
  const json = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": env("GEMINI_API_KEY") }, body);
  const u = json?.usageMetadata || {};
  const text = (json?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || "").join("");
  return { text, tokensIn: Number(u.promptTokenCount) || 0, tokensOut: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0) };
}

async function stub(req) {
  if (isProduction()) throw new AiError("AI_UNCONFIGURED", "The test AI provider can't run in production.");
  stubLog.push({ system: req.system, user: req.user, maxTokens: req.maxTokens, task: req.task });
  if (stubResponder) {
    const r = await stubResponder(req);
    return { text: String(r?.text ?? ""), tokensIn: Number(r?.tokensIn) || 0, tokensOut: Number(r?.tokensOut) || 0 };
  }
  const dir = env("AI_STUB_DIR");
  if (!dir || !/^[a-z_]{1,40}$/.test(String(req.task || ""))) throw new AiError("AI_UNAVAILABLE", AI_UNAVAILABLE_MESSAGE);
  const [{ readFile }, { join }] = await Promise.all([import("node:fs/promises"), import("node:path")]);
  const fixture = JSON.parse(await readFile(join(dir, `${req.task}.json`), "utf8"));
  return { text: typeof fixture.text === "string" ? fixture.text : JSON.stringify(fixture.output), tokensIn: Number(fixture.tokensIn) || 0, tokensOut: Number(fixture.tokensOut) || 0 };
}

const CALLS = { anthropic, openai, gemini, stub };

export async function complete({ system, user, maxTokens, schema = null, model = null, task = null } = {}) {
  const p = aiProvider();
  if (!p.configured) throw new AiError("AI_UNCONFIGURED", p.reason);
  if (!(Number.isInteger(maxTokens) && maxTokens > 0)) throw new Error("complete: maxTokens must be a positive integer");
  const useModel = p.provider === "stub" ? "stub" : model || p.model;
  const out = await CALLS[p.provider]({ system: String(system), user: String(user), maxTokens, schema, model: useModel, task });
  // the provider's own counts: what it billed
  return { text: out.text, tokensIn: out.tokensIn, tokensOut: out.tokensOut, provider: p.provider, model: useModel };
}
