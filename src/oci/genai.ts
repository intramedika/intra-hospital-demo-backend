// OCI GenAI Chat Caller — Production Ready (PHI-safe)
//
// Features:
// - Automatic API format fallback (COHERE <-> GENERIC)
// - Correct payload builder for each format
// - Timeout + AbortController
// - Safe logging (NO prompt leakage)
// - Optional strict JSON mode with 1x repair (for SOAP/recommendations)
// - Backward compatible exports

import { ociSignedRequest } from "./signer.js";

/* ────────────────────────────── TYPES ────────────────────────────── */

type GenAIOptions = {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
  strictJson?: boolean;
  jsonSchemaName?: string;
};

type ChatApiFormat = "COHERE" | "GENERIC";

/* ────────────────────────────── ENV HELPERS ────────────────────────────── */

function mustEnv(name: string): string {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function optionalEnv(name: string, fallback: string): string {
  const v = String(process.env[name] ?? "").trim();
  return v || fallback;
}

/* ────────────────────────────── ENDPOINT ────────────────────────────── */

function buildChatEndpoint(region: string): string {
  return `https://inference.generativeai.${region}.oci.oraclecloud.com/20231130/actions/chat`;
}

/* ────────────────────────────── UTILS ────────────────────────────── */

function safeJsonParse(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extract assistant text from known OCI GenAI response shapes (COHERE/GENERIC)
 */
function extractText(json: any): string {
  if (!json || typeof json !== "object") return "";

  const direct =
    json?.chatResponse?.text ??
    json?.chat_response?.text ??
    json?.text ??
    json?.message ??
    "";

  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const choices =
    json?.chatResponse?.choices ??
    json?.chat_response?.choices ??
    json?.choices ??
    json?.response?.choices ??
    null;

  if (Array.isArray(choices)) {
    for (const c of choices) {
      const msg = c?.message ?? c?.chatMessage ?? null;
      const content = msg?.content ?? c?.content ?? null;

      if (typeof content === "string" && content.trim()) return content.trim();

      if (Array.isArray(content)) {
        const joined = content
          .map((x: any) => (typeof x?.text === "string" ? x.text : ""))
          .filter(Boolean)
          .join("\n")
          .trim();
        if (joined) return joined;
      }

      if (typeof c?.text === "string" && c.text.trim()) return c.text.trim();
    }
  }

  return "";
}

function summarizeOciError(rawText: string, maxLen = 900): string {
  const raw = String(rawText || "");
  const j = safeJsonParse(raw);
  if (!j) return raw.slice(0, maxLen);

  return JSON.stringify(
    {
      code: j?.code || j?.errorCode || undefined,
      message: j?.message || j?.details || undefined,
      requestId: j?.opcRequestId || j?.opc_request_id || undefined,
    },
    null,
    0
  ).slice(0, maxLen);
}

function isChatTypeMismatch(err: any): boolean {
  const m = String(err?.message || "").toLowerCase();
  return m.includes("chat request type does not match serving model");
}

/* ────────────────────────────── STRICT JSON HELPERS ────────────────────────────── */

function stripCodeFences(s: string): string {
  return String(s || "")
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractFirstJsonObject(text: string): string | null {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }

    if (ch === '"') {
      inStr = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      return s.slice(start, i + 1);
    }
  }

  return null;
}

function removeTrailingCommas(jsonStr: string): string {
  return String(jsonStr || "").replace(/,\s*([}\]])/g, "$1");
}

/**
 * 1x repair attempt if strictJson requested
 */
function repairJsonOnce(text: string): string {
  const stripped = stripCodeFences(text);
  const extracted = extractFirstJsonObject(stripped) ?? stripped;
  return removeTrailingCommas(extracted).trim();
}

function buildJsonGuardrailPrompt(schemaName: string): string {
  const tag = schemaName ? ` (${schemaName})` : "";
  return `
PENTING${tag}:
- Output HARUS JSON VALID dan hanya JSON saja.
- Jangan sertakan penjelasan, markdown, atau teks lain.
- Jangan gunakan \`\`\` code fence.
`.trim();
}

/* ────────────────────────────── PAYLOAD BUILDER ────────────────────────────── */

function buildChatBody(params: {
  apiFormat: ChatApiFormat;
  compartmentId: string;
  modelId: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  topP: number;
}): any {
  const { apiFormat, compartmentId, modelId, prompt, maxTokens, temperature, topP } = params;

  if (apiFormat === "GENERIC") {
    return {
      compartmentId,
      servingMode: {
        servingType: "ON_DEMAND",
        modelId,
      },
      chatRequest: {
        apiFormat: "GENERIC",
        messages: [
          {
            role: "USER",
            content: [{ type: "TEXT", text: String(prompt) }],
          },
        ],
        maxTokens,
        temperature,
        topP,
        isStream: false,
        numGenerations: 1,
      },
    };
  }

  return {
    compartmentId,
    servingMode: {
      servingType: "ON_DEMAND",
      modelId,
    },
    chatRequest: {
      apiFormat: "COHERE",
      message: String(prompt),
      maxTokens,
      temperature,
      topP,
      isStream: false,
    },
  };
}

/* ────────────────────────────── CORE CALL ────────────────────────────── */

async function ociChatOnce(
  prompt: string,
  apiFormat: ChatApiFormat,
  opts: GenAIOptions = {}
): Promise<string> {
  const region = mustEnv("OCI_REGION");
  const compartmentId = mustEnv("OCI_COMPARTMENT_OCID");
  const modelId = mustEnv("OCI_GENAI_MODEL_ID");

  const maxTokens = Number.isFinite(opts.maxTokens) ? opts.maxTokens! : 900;
  const temperature = Number.isFinite(opts.temperature) ? opts.temperature! : 0.2;
  const topP = Number.isFinite(opts.topP) ? opts.topP! : 0.75;

  const timeoutMs = Number(
    Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : optionalEnv("OCI_GENAI_TIMEOUT_MS", "20000")
  );

  const strictJson = !!opts.strictJson;
  const jsonSchemaName = String(opts.jsonSchemaName || "").trim();

  const finalPrompt = strictJson
    ? `${buildJsonGuardrailPrompt(jsonSchemaName)}\n\n${String(prompt)}`
    : String(prompt);

  const body = buildChatBody({
    apiFormat,
    compartmentId,
    modelId,
    prompt: finalPrompt,
    maxTokens,
    temperature,
    topP,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await ociSignedRequest(buildChatEndpoint(region), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await res.text();
    const opc = res.headers.get("opc-request-id") || "";

    if (!res.ok) {
      const err: any = new Error(
        `OCI GenAI HTTP ${res.status}${opc ? ` (opc-request-id: ${opc})` : ""}: ${summarizeOciError(raw)}`
      );
      err.status = res.status;
      err.opcRequestId = opc;
      err.raw = raw;
      throw err;
    }

    const json = safeJsonParse(raw);
    if (!json) throw new Error("OCI GenAI invalid JSON response");

    const text = extractText(json);
    if (!text) throw new Error("OCI GenAI response missing text");

    if (strictJson) {
      const try1 = stripCodeFences(text);
      if (safeJsonParse(try1)) return try1.trim();

      const repaired = repairJsonOnce(text);
      if (safeJsonParse(repaired)) return repaired;

      const e: any = new Error("OCI GenAI strictJson: model did not return valid JSON");
      e.raw = text;
      throw e;
    }

    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────────── PUBLIC API ────────────────────────────── */

async function ociChat(prompt: string, opts: GenAIOptions = {}): Promise<string> {
  const preferred = optionalEnv("OCI_GENAI_API_FORMAT", "COHERE").toUpperCase() as ChatApiFormat;
  const alternate: ChatApiFormat = preferred === "GENERIC" ? "COHERE" : "GENERIC";

  try {
    return await ociChatOnce(prompt, preferred, opts);
  } catch (err: any) {
    if (isChatTypeMismatch(err)) {
      try {
        return await ociChatOnce(prompt, alternate, opts);
      } catch (err2) {
        err = err2;
      }
    }

    console.error("[OCI_GENAI_ERROR]", {
      apiFormat: preferred,
      strictJson: !!opts.strictJson,
      jsonSchemaName: String(opts.jsonSchemaName || ""),
      promptChars: String(prompt || "").length,
      status: err?.status,
      opcRequestId: err?.opcRequestId,
      message: String(err?.message || "").slice(0, 500),
    });

    throw err;
  }
}

/* ────────────────────────────── EXPORTS ────────────────────────────── */

export async function callOciGenAI(prompt: string, opts: GenAIOptions = {}): Promise<string> {
  return ociChat(prompt, opts);
}

export const callGenAI = callOciGenAI;
export default callOciGenAI;
