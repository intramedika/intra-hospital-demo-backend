// api/voice-to-soap.ts
// Audio → OCI Speech → OCI GenAI → SOAP (+ Recommendations)
// Production-ready, PHI-safe, serverless-safe

import type { IncomingMessage, ServerResponse } from "http";
import { transcribeAudio } from "../src/oci/speech.js";
import callOciGenAI from "../src/oci/genai.js";

export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const HARD_TIMEOUT_MS = 120_000;
const MIN_AUDIO_BYTES = 2_000;

const SPEECH_LANGUAGE = String(process.env.OCI_SPEECH_LANGUAGE || "id").trim();
const POLL_MAX_MS = Number(process.env.OCI_SPEECH_POLL_MAX_MS || 60_000);
const POLL_INTERVAL_MS = Number(process.env.OCI_SPEECH_POLL_INTERVAL_MS || 1_500);

const MAX_TRANSCRIPT_CHARS = Number(process.env.OCI_MAX_TRANSCRIPT_CHARS || 12_000);

function sendJson(res: ServerResponse, status: number, payload: any) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readBodyWithLimit(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    total += buf.length;
    if (total > limit) {
      const e: any = new Error("Payload too large");
      e.code = "PAYLOAD_TOO_LARGE";
      throw e;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseBoundary(contentType: string): string | null {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (m?.[1] || m?.[2] || "").trim() || null;
}

function parseMultipartAudio(body: Buffer, boundary: string): { audio: Buffer; mime: string } {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const headerSep = Buffer.from("\r\n\r\n");

  let offset = 0;

  while (true) {
    const start = body.indexOf(boundaryBuf, offset);
    if (start === -1) break;

    let partStart = start + boundaryBuf.length;
    if (body.slice(partStart, partStart + 2).toString() === "--") break;
    if (body.slice(partStart, partStart + 2).toString() === "\r\n") partStart += 2;

    const headerEnd = body.indexOf(headerSep, partStart);
    if (headerEnd === -1) break;

    const headersRaw = body.slice(partStart, headerEnd).toString("utf8");
    const dataStart = headerEnd + headerSep.length;

    const nextBoundary = body.indexOf(boundaryBuf, dataStart);
    if (nextBoundary === -1) break;

    const isAudio = /name="audio"/i.test(headersRaw) || /name="file"/i.test(headersRaw);
    if (!isAudio) {
      offset = nextBoundary;
      continue;
    }

    const mimeMatch = headersRaw.match(/Content-Type:\s*([^\r\n]+)/i);
    const mime = (mimeMatch?.[1] || "audio/webm").trim();

    let dataEnd = nextBoundary - 2;
    if (dataEnd < dataStart) dataEnd = dataStart;

    const audio = body.slice(dataStart, dataEnd);
    if (audio.length > 0) return { audio, mime };

    offset = nextBoundary;
  }

  throw new Error('Audio not found. Use multipart field name "audio" (recommended) or "file".');
}

function mimeToSpeechFormat(mime: string): "WEBM" | "WAV" | "MP3" | "M4A" | "OGG" {
  const m = mime.toLowerCase();
  if (m.includes("wav")) return "WAV";
  if (m.includes("mp3") || m.includes("mpeg")) return "MP3";
  if (m.includes("m4a") || m.includes("mp4")) return "M4A";
  if (m.includes("ogg")) return "OGG";
  return "WEBM";
}

function normalizeTranscript(t: string): string {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > MAX_TRANSCRIPT_CHARS ? s.slice(0, MAX_TRANSCRIPT_CHARS) : s;
}

function buildSoapPrompt(transcript: string): string {
  const t = normalizeTranscript(transcript);

  return `
Anda adalah asisten klinis INTERNAL RS (assistive-only).

PRINSIP UTAMA:
- Anda WAJIB hanya menggunakan informasi yang BENAR-BENAR ada di TRANSKRIP.
- DILARANG menambah asumsi, angka, durasi, suhu, diagnosis, atau tindakan yang tidak disebutkan.
- Jika suatu detail tidak disebutkan di transkrip, tulis: "tidak disebutkan".

TUGAS:
1) Ekstrak FAKTA dari transkrip.
2) Susun SOAP dari fakta tersebut.

OUTPUT:
- HARUS JSON VALID
- TANPA teks lain di luar JSON

TRANSKRIP:
"""
${t}
"""

SCHEMA OUTPUT:
{
  "facts": {
    "keluhan_utama": "...",
    "durasi": "...",
    "gejala_penyerta": ["..."],
    "riwayat_dahak": "...",
    "temuan_pemeriksaan_fisik": ["..."],
    "tanda_vital": ["..."],
    "terapi_tindakan_disebutkan": ["..."]
  },
  "soap": {
    "subjective": "...",
    "objective": "...",
    "assessment": "...",
    "plan": "..."
  }
}
`.trim();
}

/**
 * Recommendations prompt (NON-PRESCRIPTIVE):
 * - Tidak boleh kasih dosis/obat spesifik.
 * - Hanya “pertimbangkan / evaluasi / red flags / pertanyaan lanjutan”.
 */
function buildRecommendationsPrompt(payload: {
  facts: any;
  soap: any;
  transcript: string;
}) {
  // transcript disertakan untuk konteks, tapi tetap harus refer ke facts/soap.
  const t = normalizeTranscript(payload.transcript);

  return `
Anda adalah asisten klinis INTERNAL RS (assistive-only).

ATURAN KETAT:
- Jangan memberi resep, dosis, atau instruksi terapi spesifik.
- Jangan menambah fakta baru di luar FACTS/SOAP.
- Jika tidak ada data, tulis "tidak disebutkan".
- Output HARUS JSON valid saja.

INPUT:
FACTS:
${JSON.stringify(payload.facts || {}, null, 2)}

SOAP:
${JSON.stringify(payload.soap || {}, null, 2)}

TRANSKRIP (konteks, bukan sumber fakta baru):
"""
${t}
"""

TUGAS:
Buat rekomendasi klinis umum (non-preskriptif) untuk membantu dokter:
- red_flags (kapan harus segera rujuk/UGD)
- pertanyaan_lanjutan (untuk melengkapi anamnesis)
- pemeriksaan_penunjang_opsional (jika relevan)
- diferensial_diagnosis_opsional (jika relevan, berbasis gejala)
- catatan_kualitas_data (bagian mana yang "tidak disebutkan")

SCHEMA OUTPUT:
{
  "recommendations": {
    "red_flags": ["..."],
    "pertanyaan_lanjutan": ["..."],
    "pemeriksaan_penunjang_opsional": ["..."],
    "diferensial_diagnosis_opsional": ["..."],
    "catatan_kualitas_data": ["..."]
  }
}
`.trim();
}

function validateResult(obj: any) {
  return (
    obj &&
    obj.facts &&
    obj.soap &&
    typeof obj.soap.subjective === "string" &&
    typeof obj.soap.objective === "string" &&
    typeof obj.soap.assessment === "string" &&
    typeof obj.soap.plan === "string"
  );
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method Not Allowed" });

  const requestId =
    String(req.headers["x-request-id"] || "").trim() ||
    `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const startedAt = Date.now();
  let timedOut = false;

  const hardTimeout = setTimeout(() => {
    timedOut = true;
    sendJson(res, 504, { requestId, error: "Timeout" });
  }, HARD_TIMEOUT_MS);

  try {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    const body = await readBodyWithLimit(req, MAX_BODY_BYTES);

    let audio: Buffer;
    let mime: string;

    if (contentType.includes("multipart/form-data")) {
      const boundary = parseBoundary(contentType);
      if (!boundary) return sendJson(res, 415, { requestId, error: "Invalid multipart boundary" });
      ({ audio, mime } = parseMultipartAudio(body, boundary));
    } else if (contentType.startsWith("audio/")) {
      audio = body;
      mime = contentType;
    } else if (contentType === "application/octet-stream") {
      audio = body;
      mime = "audio/webm";
    } else {
      return sendJson(res, 415, { requestId, error: "Unsupported Content-Type", contentType });
    }

    if (!audio || audio.length < MIN_AUDIO_BYTES) {
      return sendJson(res, 400, { requestId, error: "Invalid audio payload", audioBytes: audio?.length ?? 0 });
    }

    // 1) Speech
    const { transcript: transcriptRaw, segments } = await transcribeAudio(audio, {
      languageCode: SPEECH_LANGUAGE, // "id"
      format: mimeToSpeechFormat(mime),
      timeoutMs: POLL_MAX_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      diarization: true,
      numberOfSpeakers: 2,
    });

    const transcript = normalizeTranscript(transcriptRaw);
    if (!transcript) return sendJson(res, 502, { requestId, error: "Empty transcript" });

    // 2) SOAP
    const aiRaw = await callOciGenAI(buildSoapPrompt(transcript));

    let parsed: any;
    try {
      parsed = JSON.parse(aiRaw);
    } catch {
      return sendJson(res, 502, { requestId, error: "OCI GenAI returned invalid JSON" });
    }

    if (!validateResult(parsed)) {
      return sendJson(res, 502, { requestId, error: "Invalid SOAP structure from AI" });
    }

    // 3) Recommendations (optional but requested)
    let recommendations: any = null;
    try {
      const recRaw = await callOciGenAI(
        buildRecommendationsPrompt({ facts: parsed.facts, soap: parsed.soap, transcript })
      );
      const recJson = JSON.parse(recRaw);
      recommendations = recJson?.recommendations ?? null;
    } catch {
      // don't fail whole request if recommendation fails
      recommendations = null;
    }

    const soap = parsed.soap;

    return sendJson(res, 200, {
      requestId,
      engine: "OCI_SPEECH+OCI_GENAI",
      transcript,
      segments: Array.isArray(segments) ? segments : [],
      facts: parsed.facts,
      soap: {
        subjective: String(soap.subjective || "").trim(),
        objective: String(soap.objective || "").trim(),
        assessment: String(soap.assessment || "").trim(),
        plan: String(soap.plan || "").trim(),
        source: "OCI_GENAI",
      },
      recommendations,
      durationMs: Date.now() - startedAt,
    });
  } catch (err: any) {
    if (timedOut) return;

    if (err?.code === "PAYLOAD_TOO_LARGE") {
      return sendJson(res, 413, { requestId, error: "Payload too large", maxBytes: MAX_BODY_BYTES });
    }

    return sendJson(res, 500, {
      requestId,
      error: "Voice processing failed",
      message: String(err?.message || "Unknown error").slice(0, 250),
    });
  } finally {
    clearTimeout(hardTimeout);
  }
}
