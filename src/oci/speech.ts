// src/oci/speech.ts
// OCI Speech via REST (Object Storage) — WHISPER_MEDIUM (Bahasa Indonesia)
// Production-ready:
// - Signed REST (ociSignedRequest)
// - Object Storage endpoint default: swiftobjectstorage.<region>.oraclecloud.com (fix TLS ALTNAME)
// - PUT audio -> Create transcription job (WHISPER_MEDIUM + languageCode "id")
// - Poll job until SUCCEEDED
// - Fetch transcript from Object Storage using *prefix from job.outputLocation.prefix*
//   (fix: "SUCCEEDED but transcript empty")
// - Robust output discovery + retries (eventual consistency)
// - Best-effort segments extraction + fallback join
// - Optional cleanup input + output

import { ociSignedRequest } from "./signer.js";

export type AudioFormat = "WEBM" | "WAV" | "MP3" | "M4A" | "OGG";

export type DiarSegment = {
  speakerLabel: string; // "SPEAKER_1" / "SPEAKER_2" / etc
  role?: "DOKTER" | "PASIEN" | "UNKNOWN";
  text: string;
  startMs?: number;
  endMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 90_000;

function requireEnv(name: string): string {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function envBool(name: string, def = true): boolean {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (!v) return def;
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureTrailingSlash(p: string): string {
  const s = String(p || "").trim();
  if (!s) return s;
  return s.endsWith("/") ? s : s + "/";
}

function getSpeechEndpoint(region: string): string {
  return `https://speech.aiservice.${region}.oci.oraclecloud.com/20220101`;
}

/**
 * IMPORTANT (TLS fix):
 * Banyak tenant pakai sertifikat untuk swiftobjectstorage.<region>.oraclecloud.com
 * Jadi default kita ke swiftobjectstorage.*.
 * Kalau tenant kamu beda, set OCI_OS_ENDPOINT secara eksplisit.
 */
function getObjectStorageEndpoint(region: string): string {
  const override = String(process.env.OCI_OS_ENDPOINT || "").trim();
  if (override) return override.replace(/\/+$/g, "");
  return `https://swiftobjectstorage.${region}.oraclecloud.com`;
}

function safeJsonParse(text: string): any | null {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function summarizeErrBody(text: string, maxLen = 900) {
  const j = safeJsonParse(text);
  if (j) {
    const code = j?.code ?? j?.status ?? j?.errorCode ?? undefined;
    const msg = j?.message ?? j?.error ?? j?.details ?? undefined;
    return JSON.stringify({ code, message: msg }, null, 0).slice(0, maxLen);
  }
  return String(text || "").slice(0, maxLen);
}

function normalizeFormat(fmt?: string): AudioFormat {
  const f = String(fmt || "").toUpperCase();
  if (f === "WAV" || f === "WEBM" || f === "MP3" || f === "M4A" || f === "OGG") return f;
  return "WEBM";
}

function contentTypeForFormat(fmt: AudioFormat): string {
  switch (fmt) {
    case "WAV":
      return "audio/wav";
    case "MP3":
      return "audio/mpeg";
    case "M4A":
      return "audio/mp4";
    case "OGG":
      return "audio/ogg";
    case "WEBM":
    default:
      return "audio/webm";
  }
}

async function ociFetchJson(url: URL, method: "GET" | "POST", bodyObj?: any, timeoutMs = 30_000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const hasBody = method === "POST";
    const bodyStr = hasBody ? JSON.stringify(bodyObj ?? {}) : undefined;

    const res = await ociSignedRequest(url.toString(), {
      method,
      headers: {
        accept: "application/json",
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      body: bodyStr,
      signal: controller.signal as any,
    } as any);

    const text = await res.text().catch(() => "");
    const opc = res.headers.get("opc-request-id") || "";

    if (!res.ok) {
      const brief = summarizeErrBody(text);
      const err = new Error(
        `OCI Speech REST error HTTP ${res.status}${opc ? ` (opc-request-id: ${opc})` : ""}: ${brief}`
      ) as any;
      err.status = res.status;
      err.opcRequestId = opc;
      err.raw = text;
      throw err;
    }

    return safeJsonParse(text) ?? {};
  } finally {
    clearTimeout(t);
  }
}

async function putObject(params: {
  region: string;
  namespaceName: string;
  bucketName: string;
  objectName: string;
  buffer: Buffer;
  contentType: string;
}) {
  const { region, namespaceName, bucketName, objectName, buffer, contentType } = params;
  const endpoint = getObjectStorageEndpoint(region);

  const url = new URL(
    `${endpoint}/n/${encodeURIComponent(namespaceName)}/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(
      objectName
    )}`
  );

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await ociSignedRequest(url.toString(), {
      method: "PUT",
      headers: {
        "content-type": contentType || "application/octet-stream",
        "content-length": String(buffer.length),
      },
      body: buffer as any,
      signal: controller.signal as any,
    } as any);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const opc = res.headers.get("opc-request-id") || "";
      const brief = summarizeErrBody(text);
      const err = new Error(
        `OCI Object Storage PUT error HTTP ${res.status}${opc ? ` (opc-request-id: ${opc})` : ""}: ${brief}`
      ) as any;
      err.status = res.status;
      err.opcRequestId = opc;
      err.raw = text;
      throw err;
    }
  } finally {
    clearTimeout(t);
  }
}

async function getObjectText(params: {
  region: string;
  namespaceName: string;
  bucketName: string;
  objectName: string;
  timeoutMs?: number;
}) {
  const { region, namespaceName, bucketName, objectName, timeoutMs = 30_000 } = params;
  const endpoint = getObjectStorageEndpoint(region);

  const url = new URL(
    `${endpoint}/n/${encodeURIComponent(namespaceName)}/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(
      objectName
    )}`
  );

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await ociSignedRequest(url.toString(), {
      method: "GET",
      headers: { accept: "application/json, text/plain, */*" },
      signal: controller.signal as any,
    } as any);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const opc = res.headers.get("opc-request-id") || "";
      const brief = summarizeErrBody(text);
      const err = new Error(
        `OCI Object Storage GET error HTTP ${res.status}${opc ? ` (opc-request-id: ${opc})` : ""}: ${brief}`
      ) as any;
      err.status = res.status;
      err.opcRequestId = opc;
      err.raw = text;
      throw err;
    }

    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function listObjects(params: {
  region: string;
  namespaceName: string;
  bucketName: string;
  prefix: string;
  limit?: number;
}) {
  const { region, namespaceName, bucketName, prefix, limit = 200 } = params;
  const endpoint = getObjectStorageEndpoint(region);

  const url = new URL(`${endpoint}/n/${encodeURIComponent(namespaceName)}/b/${encodeURIComponent(bucketName)}/o`);
  url.searchParams.set("prefix", prefix);
  url.searchParams.set("limit", String(limit));

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await ociSignedRequest(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal as any,
    } as any);

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const opc = res.headers.get("opc-request-id") || "";
      const brief = summarizeErrBody(text);
      const err = new Error(
        `OCI Object Storage LIST error HTTP ${res.status}${opc ? ` (opc-request-id: ${opc})` : ""}: ${brief}`
      ) as any;
      err.status = res.status;
      err.opcRequestId = opc;
      err.raw = text;
      throw err;
    }

    const j = safeJsonParse(text) ?? {};
    const objs: Array<{ name: string; size?: number }> = Array.isArray(j?.objects) ? j.objects : [];
    return objs;
  } finally {
    clearTimeout(t);
  }
}

async function deleteObject(params: { region: string; namespaceName: string; bucketName: string; objectName: string }) {
  const { region, namespaceName, bucketName, objectName } = params;
  const endpoint = getObjectStorageEndpoint(region);

  const url = new URL(
    `${endpoint}/n/${encodeURIComponent(namespaceName)}/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(
      objectName
    )}`
  );

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await ociSignedRequest(url.toString(), {
      method: "DELETE",
      headers: { accept: "application/json" },
      signal: controller.signal as any,
    } as any);

    // 204/404 ok
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      const opc = res.headers.get("opc-request-id") || "";
      console.warn("[OCI_OS_DELETE_WARN]", { status: res.status, opcRequestId: opc, brief: summarizeErrBody(text) });
    }
  } finally {
    clearTimeout(t);
  }
}

function parseTranscriptionOutput(raw: any): { transcript: string; segments: DiarSegment[] } {
  // Wider transcript paths (OCI variants)
  const transcript =
    String(
      raw?.transcription ??
        raw?.transcribedText ??
        raw?.text ??
        raw?.results?.text ??
        raw?.result?.text ??
        raw?.transcriptionResults?.text ??
        raw?.transcriptionResults?.transcriptions?.[0]?.transcription ??
        raw?.transcriptionResults?.transcriptions?.[0]?.text ??
        raw?.transcriptions?.[0]?.transcription ??
        raw?.transcriptions?.[0]?.text ??
        raw?.data?.transcription ??
        ""
    ).trim();

  // Wider segment/utterance paths
  const segCandidates =
    raw?.segments ??
    raw?.results?.segments ??
    raw?.result?.segments ??
    raw?.transcriptionResults?.segments ??
    raw?.transcriptionResults?.transcriptions?.[0]?.segments ??
    raw?.transcriptions?.[0]?.segments ??
    raw?.utterances ??
    raw?.results?.utterances ??
    [];

  const segments: DiarSegment[] = Array.isArray(segCandidates)
    ? segCandidates
        .map((s: any, idx: number) => ({
          speakerLabel: String(s?.speakerLabel || s?.speaker || s?.speaker_id || `SPEAKER_${(idx % 2) + 1}`).trim(),
          text: String(s?.text || s?.transcript || s?.utterance || s?.content || "").trim(),
          startMs: Number.isFinite(s?.startMs)
            ? Number(s.startMs)
            : Number.isFinite(s?.start)
              ? Math.round(Number(s.start) * 1000)
              : undefined,
          endMs: Number.isFinite(s?.endMs)
            ? Number(s.endMs)
            : Number.isFinite(s?.end)
              ? Math.round(Number(s.end) * 1000)
              : undefined,
        }))
        .filter((x) => x.text)
    : [];

  // Fallback: transcript empty but segments exist
  const finalTranscript = transcript || segments.map((s) => s.text).join(" ").trim();

  return { transcript: finalTranscript, segments };
}

function pickBestOutputObject(objs: Array<{ name: string; size?: number }>): string | null {
  if (!objs.length) return null;

  const score = (n: string) => {
    const low = n.toLowerCase();
    if (low.endsWith(".json")) return 30;
    if (low.endsWith(".txt")) return 20;
    if (low.endsWith(".srt")) return 10;
    return 0;
  };

  const sorted = [...objs].sort((a, b) => {
    const sa = score(a.name);
    const sb = score(b.name);
    if (sb !== sa) return sb - sa;
    return Number(b.size || 0) - Number(a.size || 0);
  });

  return sorted[0]?.name || null;
}

/**
 * Payload yang sesuai hasil OCI CLI kamu (VALID):
 * inputLocation.objectLocations[].objectNames (array)
 * modelType: WHISPER_MEDIUM
 * languageCode: "id"
 */
function buildCreateJobPayload(params: {
  compartmentId: string;
  displayName: string;
  namespaceName: string;
  bucketName: string;
  objectName: string;
  outputPrefix: string;
  languageCode: string; // "id"
  diarizationEnabled: boolean;
  numberOfSpeakers?: number;
}) {
  const {
    compartmentId,
    displayName,
    namespaceName,
    bucketName,
    objectName,
    outputPrefix,
    languageCode,
    diarizationEnabled,
    numberOfSpeakers,
  } = params;

  return {
    compartmentId,
    displayName,
    inputLocation: {
      locationType: "OBJECT_LIST_INLINE_INPUT_LOCATION",
      objectLocations: [
        {
          namespaceName,
          bucketName,
          objectNames: [objectName],
        },
      ],
    },
    outputLocation: {
      namespaceName,
      bucketName,
      prefix: outputPrefix,
    },
    modelDetails: {
      modelType: "WHISPER_MEDIUM",
      domain: "GENERIC",
      languageCode,
      transcriptionSettings: {
        diarization: {
          isDiarizationEnabled: diarizationEnabled,
          numberOfSpeakers: diarizationEnabled && numberOfSpeakers ? numberOfSpeakers : null,
        },
      },
    },
    normalization: {
      isPunctuationEnabled: true,
      filters: [],
    },
  };
}

/**
 * Robust fetch transcript from output prefix:
 * - Normalize prefix (ensure trailing slash)
 * - listObjects + pick best (.json > .txt > .srt > largest)
 * - Retry (object may appear slightly after SUCCEEDED; object may be empty briefly)
 * - Parse JSON widely + fallback join segments
 */
async function fetchTranscriptFromOutput(params: {
  region: string;
  namespaceName: string;
  bucketName: string;
  outputPrefix: string;
}) {
  const { region, namespaceName, bucketName } = params;
  const outputPrefix = ensureTrailingSlash(params.outputPrefix);

  const maxTries = Number(process.env.OCI_SPEECH_OUTPUT_RETRIES || 12);
  const baseWaitMs = Number(process.env.OCI_SPEECH_OUTPUT_WAIT_MS || 900);

  let lastNames: string[] = [];

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const objs = await listObjects({ region, namespaceName, bucketName, prefix: outputPrefix, limit: 500 });
      lastNames = objs.map((o) => o.name);

      const pick = pickBestOutputObject(objs);

      if (pick) {
        const text = await getObjectText({ region, namespaceName, bucketName, objectName: pick, timeoutMs: 30_000 });

        const j = safeJsonParse(text);
        if (j) {
          const parsed = parseTranscriptionOutput(j);
          if (parsed.transcript) return parsed;
        } else {
          const t = String(text || "").trim();
          if (t) return { transcript: t, segments: [] as DiarSegment[] };
        }
        // If object exists but content empty/not-ready => retry
      }
    } catch {
      // transient failures => retry
    }

    if (attempt < maxTries) {
      const backoff = Math.min(baseWaitMs * attempt, 2500);
      await sleep(backoff);
    }
  }

  console.warn("[OCI_SPEECH_OUTPUT_EMPTY]", { outputPrefix, lastNames: lastNames.slice(0, 25) });
  return { transcript: "", segments: [] as DiarSegment[] };
}

export async function transcribeAudio(
  buffer: Buffer,
  opts?: {
    format?: AudioFormat;
    languageCode?: string; // "id" recommended
    timeoutMs?: number;
    pollIntervalMs?: number;

    diarization?: boolean; // default true
    numberOfSpeakers?: number; // default 2
    cleanupInput?: boolean; // default env OCI_SPEECH_CLEANUP_INPUT
    cleanupOutput?: boolean; // default env OCI_SPEECH_CLEANUP_OUTPUT
  }
): Promise<{ transcript: string; segments: DiarSegment[] }> {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("audio buffer is required");
  }

  const region = requireEnv("OCI_REGION");
  const compartmentId = requireEnv("OCI_COMPARTMENT_OCID");

  const namespaceName = requireEnv("OCI_OS_NAMESPACE");
  const bucketName = requireEnv("OCI_OS_BUCKET");
  const basePrefix = String(process.env.OCI_OS_PREFIX || "tmp-speech").replace(/^\/+|\/+$/g, "");

  const cleanupInput =
    typeof opts?.cleanupInput === "boolean" ? opts.cleanupInput : envBool("OCI_SPEECH_CLEANUP_INPUT", true);
  const cleanupOutput =
    typeof opts?.cleanupOutput === "boolean" ? opts.cleanupOutput : envBool("OCI_SPEECH_CLEANUP_OUTPUT", false);

  const format = normalizeFormat(opts?.format ?? "WEBM");

  // Indonesian: proven working in your CLI is "id"
  const lcRaw = String(opts?.languageCode ?? process.env.OCI_SPEECH_LANGUAGE ?? "id").trim();
  const languageCode = lcRaw.toLowerCase().startsWith("id") ? "id" : lcRaw;

  const timeoutMs = Math.max(10_000, Number(opts?.timeoutMs ?? process.env.OCI_SPEECH_POLL_MAX_MS ?? DEFAULT_TIMEOUT_MS));
  const pollIntervalMs = Math.max(
    800,
    Number(opts?.pollIntervalMs ?? process.env.OCI_SPEECH_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS)
  );

  const diarizationEnabled = typeof opts?.diarization === "boolean" ? opts.diarization : true;
  const numberOfSpeakers = opts?.numberOfSpeakers ?? 2;

  const speechEndpoint = getSpeechEndpoint(region);

  // 1) Upload audio
  const now = Date.now();
  const displayName = `soap-transcription-${now}`;
  const inputObjectName = `${basePrefix}/in/${displayName}.${format.toLowerCase()}`;

  // Requested output prefix (OCI may create subfolders; we will trust job.outputLocation.prefix later)
  const requestedOutputPrefix = ensureTrailingSlash(`${basePrefix}/out/`);

  await putObject({
    region,
    namespaceName,
    bucketName,
    objectName: inputObjectName,
    buffer,
    contentType: contentTypeForFormat(format),
  });

  let jobId: string | null = null;

  try {
    // 2) Create job
    const createUrl = new URL(`${speechEndpoint}/transcriptionJobs`);
    const payload = buildCreateJobPayload({
      compartmentId,
      displayName,
      namespaceName,
      bucketName,
      objectName: inputObjectName,
      outputPrefix: requestedOutputPrefix,
      languageCode,
      diarizationEnabled,
      numberOfSpeakers,
    });

    const created = await ociFetchJson(createUrl, "POST", payload, 25_000);
    jobId = created?.id ?? created?.data?.id ?? created?.transcriptionJob?.id ?? null;

    if (!jobId) {
      console.error("[OCI_SPEECH_CREATE_NO_JOBID]", { keys: Object.keys(created || {}) });
      throw new Error("OCI Speech: create job succeeded but jobId missing");
    }

    // 3) Poll
    const deadline = Date.now() + timeoutMs;

    while (true) {
      if (Date.now() > deadline) throw new Error(`OCI Speech timeout after ${timeoutMs}ms`);

      const getUrl = new URL(`${speechEndpoint}/transcriptionJobs/${jobId}`);
      const got = await ociFetchJson(getUrl, "GET", undefined, 20_000);

      const job = got?.data ?? got?.transcriptionJob ?? got ?? null;
      const state = job?.lifecycleState ?? job?.status ?? job?.state ?? null;

      if (state === "SUCCEEDED") {
        // Grace delay: SUCCEEDED may precede object availability
        await sleep(Number(process.env.OCI_SPEECH_SUCCEEDED_GRACE_MS || 1200));

        // SOURCE OF TRUTH: prefix output dari job response (normalize trailing slash)
        const out = job?.outputLocation ?? job?.output_location ?? null;
        const outPrefixRaw: string = String(out?.prefix || "").trim() || requestedOutputPrefix;
        const outPrefix = ensureTrailingSlash(outPrefixRaw);

        const { transcript, segments } = await fetchTranscriptFromOutput({
          region,
          namespaceName,
          bucketName,
          outputPrefix: outPrefix,
        });

        if (!transcript) {
          const err = new Error("OCI Speech SUCCEEDED but transcript empty (output file not found/empty)") as any;
          err.jobId = jobId;
          err.outputPrefix = outPrefix;
          throw err;
        }

        return { transcript, segments };
      }

      if (state === "FAILED" || state === "CANCELED") {
        console.error("[OCI_SPEECH_JOB_FAILED]", {
          jobId,
          state,
          errorMessage: job?.lifecycleDetails || job?.errorMessage || job?.message || job?.error || undefined,
        });
        throw new Error(`OCI Speech failed: ${state}`);
      }

      await sleep(pollIntervalMs);
    }
  } finally {
    if (cleanupInput) {
      await deleteObject({ region, namespaceName, bucketName, objectName: inputObjectName });
    }

    if (cleanupOutput && jobId) {
      // Best-effort cleanup output prefix (be conservative)
      try {
        const prefix = ensureTrailingSlash(`${basePrefix}/out/`);
        const objs = await listObjects({ region, namespaceName, bucketName, prefix, limit: 500 });
        await Promise.all(objs.map((o) => deleteObject({ region, namespaceName, bucketName, objectName: o.name })));
      } catch (e) {
        console.warn("[OCI_SPEECH_CLEANUP_OUTPUT_WARN]", String((e as any)?.message || e));
      }
    }
  }
}
