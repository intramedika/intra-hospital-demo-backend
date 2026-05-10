// src/oci/speech.ts
import speech from "oci-ai-speech";
import { getOciAuthProvider, getOciRegion, getOciCompartmentId } from "./auth";

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 60_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type AudioFormat = "WEBM" | "WAV" | "MP3" | "M4A" | "OGG";

function extractTranscriptionText(job: any): string {
  const t1 =
    job?.transcriptionResults?.transcriptions?.[0]?.transcription ??
    job?.transcriptionResults?.transcriptions?.[0]?.text ??
    null;

  if (typeof t1 === "string" && t1.trim()) return t1.trim();

  const t2 = job?.transcription ?? job?.transcribedText ?? null;
  if (typeof t2 === "string" && t2.trim()) return t2.trim();

  return "";
}

/**
 * REAL MODE ONLY — OCI Speech transcription (Bahasa Indonesia)
 * Inline audio (base64) — no object storage required.
 */
export async function transcribeAudio(
  buffer: Buffer,
  opts?: {
    format?: AudioFormat;
    languageCode?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }
): Promise<string> {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("audio buffer is required");
  }

  const region = getOciRegion();
  const compartmentId = getOciCompartmentId();
  const provider = getOciAuthProvider();

  const client = new speech.AIServiceSpeechClient({
    authenticationDetailsProvider: provider,
  });
  client.region = region;

  const format = (opts?.format ?? "WEBM").toUpperCase() as AudioFormat;
  const languageCode = opts?.languageCode ?? "id-ID";
  const timeoutMs = Math.max(10_000, Number(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const pollIntervalMs = Math.max(
    800,
    Number(opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  );

  const audioBase64 = buffer.toString("base64");

  // NOTE: beberapa tenancy/SDK version beda nama inputLocation.
  // Di sini pakai bentuk yang paling umum di SDK terbaru.
  const createReq: speech.requests.CreateTranscriptionJobRequest = {
    createTranscriptionJobDetails: {
      compartmentId,
      displayName: `soap-transcription-${Date.now()}`,
      languageCode,
      modelDetails: { modelType: "ORACLE_SPEECH_MODEL" },
      audioFormatDetails: { format },
      inputLocation: {
        locationType: "INLINE_INPUT_LOCATION",
        content: audioBase64,
      } as any,
    } as any,
  };

  const created = await client.createTranscriptionJob(createReq);
  const jobId = created.transcriptionJob?.id;
  if (!jobId) {
    throw new Error("OCI Speech: failed to create transcription job (missing job id)");
  }

  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (Date.now() > deadline) {
      throw new Error(`OCI Speech timeout after ${timeoutMs}ms`);
    }

    const got = await client.getTranscriptionJob({ transcriptionJobId: jobId });
    const job = got.transcriptionJob;
    const state = job?.lifecycleState;

    if (state === "SUCCEEDED") {
      const text = extractTranscriptionText(job);
      if (!text) {
        console.error("[OCI_SPEECH_EMPTY_RESULT]", { jobId, state });
        throw new Error("OCI Speech succeeded but returned empty transcription");
      }
      return text;
    }

    if (state === "FAILED" || state === "CANCELED") {
      console.error("[OCI_SPEECH_FAILED]", { jobId, state });
      throw new Error(`OCI Speech failed: ${state}`);
    }

    await sleep(pollIntervalMs);
  }
}
