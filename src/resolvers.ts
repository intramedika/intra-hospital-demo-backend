// src/resolvers.ts
// GraphQL Resolvers — Intramedika Assistive AI (Production Ready)
// ✅ Uses src/mockData.ts (patients + dashboard + encounters + labs)
// ✅ assistiveChat auto-injects patient + labs context so AI "knows"
// ✅ labSummary returns mock labs (not empty)
// ✅ dashboard returns FULL shape (safe defaults) to match FE "Ultimate" dashboard

import { GraphQLError } from "graphql";
import callOciGenAI from "./oci/genai.js";
import { transcribeAudio } from "./oci/speech.js";
import {
  MOCK_PATIENTS,
  MOCK_DASHBOARD,
  MOCK_ENCOUNTERS,
  MOCK_LABS_BY_ENCOUNTER,
} from "./mockData.js";

/* ======================================================
 * CONTEXT TYPE
 * ====================================================== */
type Context = {
  auth: string | null;
  origin: string | null;
  tenant: string | null;
  requestId: string;
};

/* ======================================================
 * ENV CONFIG
 * ====================================================== */
const SPEECH_LANGUAGE = String(process.env.OCI_SPEECH_LANGUAGE || "id-ID").trim();

const MAX_AUDIO_BYTES =
  Number(process.env.ASK_MAX_AUDIO_BYTES) > 0
    ? Number(process.env.ASK_MAX_AUDIO_BYTES)
    : 8 * 1024 * 1024;

const GENAI_MAX_TOKENS =
  Number(process.env.ASK_GENAI_MAX_TOKENS) > 0 ? Number(process.env.ASK_GENAI_MAX_TOKENS) : 900;

const GENAI_TEMPERATURE = Number.isFinite(Number(process.env.ASK_GENAI_TEMPERATURE))
  ? Number(process.env.ASK_GENAI_TEMPERATURE)
  : 0.2;

const GENAI_TOP_P = Number.isFinite(Number(process.env.ASK_GENAI_TOP_P))
  ? Number(process.env.ASK_GENAI_TOP_P)
  : 0.75;

const GENAI_TIMEOUT_MS =
  Number(process.env.ASK_GENAI_TIMEOUT_MS) > 0 ? Number(process.env.ASK_GENAI_TIMEOUT_MS) : 20_000;

/* ======================================================
 * ERROR HELPERS
 * ====================================================== */
function badInput(message: string, extra?: Record<string, any>) {
  return new GraphQLError(message, {
    extensions: { code: "BAD_USER_INPUT", ...extra },
  });
}

function gqlError(message: string, code: string, extra?: Record<string, any>) {
  return new GraphQLError(message, {
    extensions: { code, ...extra },
  });
}

function assertNonEmptyString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw badInput(`${field} is required`);
}

function safeString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function newEncounterId() {
  return `ENC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ======================================================
 * SMALL COERCERS (safe defaults)
 * ====================================================== */
function asStr(v: any, fallback = ""): string {
  const s = safeString(v);
  return s || fallback;
}
function asNumber(v: any, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function asInt(v: any, fallback = 0): number {
  return Math.floor(asNumber(v, fallback));
}
function asArr<T = any>(v: any): T[] {
  return Array.isArray(v) ? v : [];
}

/* ======================================================
 * ENUM NORMALIZERS (FE friendly)
 * ====================================================== */
function normalizeExternalStatus(v: any): "ONLINE" | "LATENCY" | "OFFLINE" {
  const s = asStr(v).toUpperCase();
  if (s === "ONLINE") return "ONLINE";
  if (s === "LATENCY") return "LATENCY";
  return "OFFLINE";
}
function normalizeTrend(v: any): "STABLE" | "RISING" | "FALLING" {
  const s = asStr(v).toUpperCase();
  if (s === "RISING") return "RISING";
  if (s === "FALLING") return "FALLING";
  return "STABLE";
}
function normalizeResourceCategory(v: any): "BEDS" | "DEVICE" | "MEDS" | "CONSUMABLE" | "OTHER" {
  const s = asStr(v).toUpperCase();
  if (s === "BEDS") return "BEDS";
  if (s === "DEVICE") return "DEVICE";
  if (s === "MEDS") return "MEDS";
  if (s === "CONSUMABLE") return "CONSUMABLE";
  return "OTHER";
}
function normalizeResourceStatus(v: any): "OK" | "WARNING" | "CRITICAL" {
  const s = asStr(v).toUpperCase();
  if (s === "CRITICAL") return "CRITICAL";
  if (s === "WARNING") return "WARNING";
  return "OK";
}
function normalizeQueueTrend(v: any): "STABLE" | "INCREASING" | "DECREASING" {
  const s = asStr(v).toUpperCase();
  if (s === "INCREASING") return "INCREASING";
  if (s === "DECREASING") return "DECREASING";
  return "STABLE";
}
function normalizeRiskLevel(v: any): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  const s = asStr(v).toUpperCase();
  if (s === "CRITICAL") return "CRITICAL";
  if (s === "HIGH") return "HIGH";
  if (s === "LOW") return "LOW";
  return "MEDIUM";
}

/* ======================================================
 * MOCK ACCESS HELPERS
 * ====================================================== */
function getPatientById(patientId?: string) {
  const id = safeString(patientId);
  return id ? (MOCK_PATIENTS as any)?.[id] ?? null : null;
}

function getLatestEncounterIdForPatient(patientId: string): string | null {
  const pid = safeString(patientId);
  if (!pid) return null;

  const list = (MOCK_ENCOUNTERS || []).filter((e) => e.patientId === pid);
  if (!list.length) return null;

  const latest = list
    .slice()
    .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0];

  return latest?.id ?? null;
}

function getLabsByEncounter(encounterId?: string) {
  const eid = safeString(encounterId);
  const arr = eid ? (MOCK_LABS_BY_ENCOUNTER as any)?.[eid] : null;
  return Array.isArray(arr) ? arr : [];
}

function buildPatientContext(patient: any | null) {
  if (!patient) return "";
  return [
    "Identitas pasien:",
    `- Nama: ${asStr(patient?.name, "-")}`,
    `- MRN: ${asStr(patient?.mrn, "-")}`,
    `- Unit: ${asStr(patient?.careUnit, "-")}`,
    `- DPJP: ${asStr(patient?.attendingDoctor, "-")}`,
  ].join("\n");
}

function buildLabContext(labs: any[]) {
  if (!Array.isArray(labs) || labs.length === 0) return "";

  const lines = labs.slice(0, 25).map((l: any) => {
    const name = asStr(l?.testName, "Lab");
    const value = asStr(l?.value, "-");
    const unit = asStr(l?.unit) ? ` ${asStr(l?.unit)}` : "";
    const flag = asStr(l?.flag) ? ` [${asStr(l?.flag)}]` : "";
    const rr = asStr(l?.refRange) ? ` (RR: ${asStr(l?.refRange)})` : "";
    const date = asStr(l?.date) ? ` (${asStr(l?.date)})` : "";
    return `- ${name}: ${value}${unit}${flag}${rr}${date}`.trim();
  });

  return `Ringkasan Lab:\n${lines.join("\n")}`;
}

/* ======================================================
 * DASHBOARD HELPERS
 * ====================================================== */
function buildFallbackDashboardPatientsFromMockPatients(): any[] {
  const entries = Object.values(MOCK_PATIENTS || {});
  return entries.map((p: any, idx: number) => ({
    id: asStr(p?.id, `PAT-${idx + 1}`),
    name: asStr(p?.name, "Pasien"),
    mrn: asStr(p?.mrn) || null,
    room: null,
    riskScore: 0,
    riskLevel: "MEDIUM",
    aiPrediction: null,
    aiAction: null,
    diagnosis: null,
  }));
}

/* ======================================================
 * AUDIO HELPERS
 * ====================================================== */
type AudioFormat = "WEBM" | "WAV" | "M4A" | "MP3" | "OGG";

function normalizeAudioInput(input: string): { base64: string; detectedMime?: string } {
  const s = String(input || "").trim();
  const m = s.match(/^data:(audio\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,(.+)$/i);
  if (m) return { detectedMime: m[1], base64: m[2] };
  return { base64: s };
}

function looksLikeBase64(s: string): boolean {
  const t = s.replace(/\s+/g, "");
  if (!t) return false;
  // strict-ish base64 charset
  return /^[A-Za-z0-9+/=]+$/.test(t);
}

function padBase64(s: string): string {
  const t = s.replace(/\s+/g, "");
  const pad = t.length % 4;
  return pad === 0 ? t : t + "=".repeat(4 - pad);
}

function normalizeFormat(format?: string | null, detectedMime?: string): AudioFormat {
  const f = String(format || "").toLowerCase();
  if (f.includes("wav")) return "WAV";
  if (f.includes("ogg")) return "OGG";
  if (f.includes("mp3") || f.includes("mpeg")) return "MP3";
  if (f.includes("m4a") || f.includes("mp4")) return "M4A";
  if (f.includes("webm")) return "WEBM";

  const m = String(detectedMime || "").toLowerCase();
  if (m.includes("wav")) return "WAV";
  if (m.includes("ogg")) return "OGG";
  if (m.includes("mp3") || m.includes("mpeg")) return "MP3";
  if (m.includes("m4a") || m.includes("mp4")) return "M4A";
  if (m.includes("webm")) return "WEBM";

  return "WEBM";
}

/* ======================================================
 * PROMPTS
 * ====================================================== */
function buildSoapPrompt(patient: any, transcript: string) {
  return `
Anda adalah asisten klinis INTERNAL rumah sakit.
Susun SOAP dari transkrip berikut.

ATURAN WAJIB:
- Bahasa Indonesia medis profesional
- Jangan menambah asumsi di luar transkrip
- Output HARUS JSON VALID
- TIDAK BOLEH ada teks sebelum atau sesudah JSON

KONTEKS PASIEN:
Nama: ${asStr(patient?.name, "-")}
MRN: ${asStr(patient?.mrn, "-")}
Unit: ${asStr(patient?.careUnit, "-")}
DPJP: ${asStr(patient?.attendingDoctor, "-")}

TRANSKRIP:
"""
${String(transcript || "").trim()}
"""

OUTPUT (JSON SAJA):
{
  "subjective": "...",
  "objective": "...",
  "assessment": "...",
  "plan": "..."
}
`.trim();
}

/**
 * ✅ AI tidak boleh minta ulang data yang sudah ada di konteks.
 */
function buildAssistivePrompt(prompt: string, effectiveContext: string) {
  const ctx = safeString(effectiveContext);

  return `
Anda adalah ASSISTIVE AI INTERNAL RS.
Jawaban singkat, klinis, dan actionable.

ATURAN WAJIB:
- Jika "Konteks" berisi data pasien/lab, gunakan itu dan JANGAN meminta ulang data yang sudah tertulis.
- Jika konteks kosong/tidak relevan, ajukan maksimal 1–2 pertanyaan klarifikasi.
- Jangan menyebut bahwa Anda AI/sistem.

Konteks:
${ctx || "(tidak ada konteks tambahan)"}

Pertanyaan:
${String(prompt || "").trim()}

Jawaban:
`.trim();
}

/* ======================================================
 * SOAP PARSER
 * ====================================================== */
function extractFirstJsonObject(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || s;

  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;

  const start = candidate.indexOf("{");
  if (start === -1) return candidate;

  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return candidate.slice(start, i + 1).trim();
  }

  return candidate.slice(start).trim();
}

function parseSoapJson(raw: string) {
  const jsonText = extractFirstJsonObject(raw);

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw gqlError("AI response is not valid JSON", "GENAI_INVALID_JSON");
  }

  const subjective = safeString(parsed?.subjective);
  const objective = safeString(parsed?.objective);
  const assessment = safeString(parsed?.assessment);
  const plan = safeString(parsed?.plan);

  if (!subjective || !objective || !assessment || !plan) {
    throw gqlError("AI response JSON missing SOAP fields", "GENAI_INVALID_SOAP");
  }

  return { subjective, objective, assessment, plan };
}

/* ======================================================
 * RESOLVERS
 * ====================================================== */
export const resolvers = {
  Query: {
    _health: () => "ok",

    patient: async (_: any, { id }: any) => {
      assertNonEmptyString(id, "id");
      const p = getPatientById(String(id));
      if (!p) throw gqlError("Patient not found", "NOT_FOUND", { id });
      return p;
    },

    labSummary: async (_: any, { encounterId }: any) => {
      assertNonEmptyString(encounterId, "encounterId");
      return getLabsByEncounter(String(encounterId)).map((l: any) => ({
        id: l.id,
        testName: l.testName,
        value: l.value ?? null,
        unit: l.unit ?? null,
        flag: l.flag ?? null,
        date: l.date ?? null,
      }));
    },

    /**
     * ✅ FULL DASHBOARD SHAPE
     * Agar FE Dashboard "Ultimate" tidak crash ketika backend mock minimal.
     */
    dashboard: async (_: any, { unitId }: any) => {
      const base: any = (MOCK_DASHBOARD as any) || {};
      const u = safeString(unitId);

      const patientsRaw = asArr(base.patients);
      const patients =
        patientsRaw.length > 0
          ? patientsRaw.map((p: any) => ({
              id: asStr(p?.id),
              name: asStr(p?.name, "Pasien"),
              mrn: asStr(p?.mrn) || null,
              room: asStr(p?.room) || null,
              riskScore: asInt(p?.riskScore, 0),
              riskLevel: normalizeRiskLevel(p?.riskLevel),
              aiPrediction: asStr(p?.aiPrediction) || null,
              aiAction: asStr(p?.aiAction) || null,
              diagnosis: asStr(p?.diagnosis) || null,
            }))
          : buildFallbackDashboardPatientsFromMockPatients();

      return {
        unitId: u || asStr(base.unitId, "UNIT"),
        unitName: asStr(base.unitName, "Unit"),

        kpis: {
          occupancyRate: asNumber(base?.kpis?.occupancyRate, 0),
          losAverage: asNumber(base?.kpis?.losAverage, 0),
          staffAvailability: asNumber(base?.kpis?.staffAvailability, 0),
          activeAlerts: asInt(base?.kpis?.activeAlerts, 0),
        },

        growthInsights: asArr(base.growthInsights).map((x: any) => asStr(x)).filter(Boolean),

        externalServices: asArr(base.externalServices).map((svc: any) => ({
          name: asStr(svc?.name, "Service"),
          status: normalizeExternalStatus(svc?.status),
          latencyMs: asInt(svc?.latencyMs, 0),
          trend: normalizeTrend(svc?.trend),
        })),

        resources: asArr(base.resources).map((r: any) => ({
          name: asStr(r?.name, "Resource"),
          category: normalizeResourceCategory(r?.category),
          currentStock: asInt(r?.currentStock, 0),
          totalCapacity: asInt(r?.totalCapacity, 0),
          unit: asStr(r?.unit, "unit"),
          status: normalizeResourceStatus(r?.status),
        })),

        queues: asArr(base.queues).map((q: any) => ({
          location: asStr(q?.location, "Lokasi"),
          currentQueueLength: asInt(q?.currentQueueLength, 0),
          estimatedWaitTimeMinutes: asInt(q?.estimatedWaitTimeMinutes, 0),
          predictionTrend: normalizeQueueTrend(q?.predictionTrend),
        })),

        patients,
      };
    },
  },

  Mutation: {
    /* ---------- ASSISTIVE CHAT ---------- */
    async assistiveChat(_: any, { prompt, patientId, contextText }: any, ctx: Context) {
      assertNonEmptyString(prompt, "prompt");

      const patient = safeString(patientId) ? getPatientById(String(patientId)) : null;

      // Backend injects clinical context
      const latestEncounterId = patient ? getLatestEncounterIdForPatient(patient.id) : null;
      const labs = latestEncounterId ? getLabsByEncounter(latestEncounterId) : [];

      const feCtx = safeString(contextText);
      const patientCtx = buildPatientContext(patient);
      const labCtx = buildLabContext(labs);

      const effectiveContext = [feCtx, patientCtx, labCtx].filter(Boolean).join("\n\n");
      const fullPrompt = buildAssistivePrompt(String(prompt), effectiveContext);

      try {
        const out = await callOciGenAI(fullPrompt, {
          maxTokens: GENAI_MAX_TOKENS,
          temperature: GENAI_TEMPERATURE,
          topP: GENAI_TOP_P,
          timeoutMs: GENAI_TIMEOUT_MS,
        });
        return safeString(out) || "Maaf, saya belum bisa menjawab saat ini.";
      } catch (err: any) {
        console.error("[ASSISTIVE_ERROR]", {
          requestId: ctx.requestId,
          tenant: ctx.tenant,
          status: err?.status,
          opcRequestId: err?.opcRequestId,
          message: err?.message,
        });
        return "Maaf, layanan AI sedang tidak tersedia.";
      }
    },

    /* ---------- TEXT → SOAP ---------- */
    async formSOAPTranscript(_: any, { voiceInput, patientId }: any, ctx: Context) {
      assertNonEmptyString(voiceInput, "voiceInput");
      assertNonEmptyString(patientId, "patientId");

      const patient = getPatientById(String(patientId));
      if (!patient) throw gqlError("Patient not found", "NOT_FOUND", { patientId });

      const encounterId = newEncounterId();

      try {
        const raw = await callOciGenAI(buildSoapPrompt(patient, voiceInput), {
          maxTokens: GENAI_MAX_TOKENS,
          temperature: GENAI_TEMPERATURE,
          topP: GENAI_TOP_P,
          timeoutMs: GENAI_TIMEOUT_MS,
        });

        const soap = parseSoapJson(raw);
        return { encounterId, ...soap, source: "GENAI" };
      } catch (err: any) {
        console.error("[SOAP_TEXT_ERROR]", {
          requestId: ctx.requestId,
          tenant: ctx.tenant,
          encounterId,
          status: err?.status,
          opcRequestId: err?.opcRequestId,
          message: err?.message,
        });
        throw gqlError("Gagal memproses SOAP dari teks.", "SOAP_TEXT_ERROR", { encounterId });
      }
    },

    /* ---------- AUDIO → SPEECH → SOAP ---------- */
    async formSOAPFromAudio(_: any, { audioBase64, format, patientId }: any, ctx: Context) {
      assertNonEmptyString(audioBase64, "audioBase64");
      assertNonEmptyString(patientId, "patientId");

      const patient = getPatientById(String(patientId));
      if (!patient) throw gqlError("Patient not found", "NOT_FOUND", { patientId });

      const encounterId = newEncounterId();

      const normalized = normalizeAudioInput(audioBase64);
      if (!looksLikeBase64(normalized.base64)) {
        throw badInput("Format audio tidak valid (base64).", { encounterId });
      }

      let audioBuf: Buffer;
      try {
        audioBuf = Buffer.from(padBase64(normalized.base64), "base64");
      } catch {
        throw badInput("Audio tidak dapat didekode (base64).", { encounterId });
      }

      if (!audioBuf?.length) throw badInput("Audio kosong atau tidak valid.", { encounterId });

      if (audioBuf.length > MAX_AUDIO_BYTES) {
        throw gqlError("Audio terlalu besar.", "PAYLOAD_TOO_LARGE", {
          encounterId,
          maxBytes: MAX_AUDIO_BYTES,
        });
      }

      const fmt = normalizeFormat(format, normalized.detectedMime);
      
      let transcript: string;
      try {
        const out = await transcribeAudio(audioBuf, { format: fmt, languageCode: SPEECH_LANGUAGE });
        transcript = typeof out === "string" ? out : String(out?.transcript || "");
      } catch (err: any) {  
        
        console.error("[SPEECH_ERROR]", {
          requestId: ctx.requestId,
          tenant: ctx.tenant,
          encounterId,
          status: err?.status,
          opcRequestId: err?.opcRequestId,
          message: err?.message,
        });
        throw gqlError(
          "Gagal memproses suara. Anda bisa mengisi SOAP manual.",
          "SPEECH_ERROR",
          { encounterId }
        );
      }

      const t = safeString(transcript);
      if (!t) throw gqlError("Transkrip kosong.", "SPEECH_EMPTY_TRANSCRIPT", { encounterId });

      try {
        const raw = await callOciGenAI(buildSoapPrompt(patient, t), {
          maxTokens: GENAI_MAX_TOKENS,
          temperature: GENAI_TEMPERATURE,
          topP: GENAI_TOP_P,
          timeoutMs: GENAI_TIMEOUT_MS,
        });

        const soap = parseSoapJson(raw);
        return { encounterId, ...soap, source: "SPEECH+GENAI" };
      } catch (err: any) {
        console.error("[SOAP_AUDIO_ERROR]", {
          requestId: ctx.requestId,
          tenant: ctx.tenant,
          encounterId,
          status: err?.status,
          opcRequestId: err?.opcRequestId,
          message: err?.message,
        });
        throw gqlError(
          "Gagal membuat SOAP dari hasil transkripsi.",
          "SOAP_AUDIO_ERROR",
          { encounterId }
        );
      }
    },
  },
};
