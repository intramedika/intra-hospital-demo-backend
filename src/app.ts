import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express4";
import type { Request, Response, NextFunction } from "express";

import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers.js";
import { transcribeAudio, type DiarSegment } from "./oci/speech.js";
import { getUsers, verifyPassword, createToken, verifyToken, verifyTOTP, generateTotpSecret, getOtpauthUrl, saveUsers } from "./auth.local.js";

type Context = {
  auth: string;
  origin: string;
  tenant: string;
  requestId: string;
};

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:8088",
  "http://demo.intrahospital.intramedika.co.id",
  "https://demo.intrahospital.intramedika.co.id",
];
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_ALLOWED_ORIGINS)
);

const SPEECH_MODE = (process.env.SPEECH_MODE || "OCI").toUpperCase() as "OCI" | "MOCK";
const SPEECH_LANGUAGE = String(process.env.OCI_SPEECH_LANGUAGE || "id").trim();
const MIN_AUDIO_BYTES = Number(process.env.MIN_AUDIO_BYTES || 2000);
const SPEECH_TIMEOUT_MS = Number(process.env.SPEECH_TIMEOUT_MS || 60_000);

function requireEnv(name: string) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
}
function validateOciEnvIfNeeded() {
  if (SPEECH_MODE !== "OCI") return;
  requireEnv("OCI_REGION");
  requireEnv("OCI_TENANCY_OCID");
  requireEnv("OCI_USER_OCID");
  requireEnv("OCI_FINGERPRINT");
  requireEnv("OCI_PRIVATE_KEY_BASE64");
  requireEnv("OCI_COMPARTMENT_OCID");
  requireEnv("OCI_OS_NAMESPACE");
  requireEnv("OCI_OS_BUCKET");
}

function buildCorsOptions(): cors.CorsOptions {
  return {
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Intramedika-Mode"],
    maxAge: 86400,
  };
}

function preflightAll(corsOptions: cors.CorsOptions) {
  const corsMw = cors(corsOptions);
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "OPTIONS") return next();
    corsMw(req, res, () => res.sendStatus(204));
  };
}

function mapMimeToFormat(mimeRaw: string): "WEBM" | "WAV" | "M4A" | "MP3" | "OGG" {
  const mime = String(mimeRaw || "").toLowerCase();
  if (mime.includes("wav")) return "WAV";
  if (mime.includes("mp3") || mime.includes("mpeg")) return "MP3";
  if (mime.includes("m4a") || mime.includes("mp4")) return "M4A";
  if (mime.includes("ogg")) return "OGG";
  return "WEBM";
}

function mkRequestId(req: Request) {
  return (
    String(req.headers["x-request-id"] || "").trim() ||
    `req_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`
  );
}

async function withTimeout<T>(p: Promise<T>, ms: number, code = "timeout"): Promise<T> {
  let t: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        t = setTimeout(() => {
          const e: any = new Error(code);
          e.code = code;
          reject(e);
        }, ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

type SpeechSegment = DiarSegment;

function pseudoDiarize(transcript: string): SpeechSegment[] {
  const raw = String(transcript || "").trim();
  if (!raw) return [];

  const lines = raw
    .split(/\r?\n+/g)
    .map((l) => l.trim())
    .filter(Boolean);

  const labeled: SpeechSegment[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(dokter|doctor|pasien|patient)\s*:\s*(.+)$/i);
    if (!m) continue;

    const who = String(m[1] || "").toLowerCase();
    const text = String(m[2] || "").trim();
    if (!text) continue;

    const isDoc = who === "dokter" || who === "doctor";
    labeled.push({
      speakerLabel: isDoc ? "SPEAKER_1" : "SPEAKER_2",
      role: isDoc ? "DOKTER" : "PASIEN",
      text,
    });
  }
  if (labeled.length) return labeled.slice(0, 200);

  const sentences =
    raw.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) || [raw];

  const segs: SpeechSegment[] = [];
  for (let i = 0; i < sentences.length && segs.length < 200; i++) {
    const text = sentences[i];
    if (!text) continue;
    const speakerLabel = i % 2 === 0 ? "SPEAKER_1" : "SPEAKER_2";
    segs.push({ speakerLabel, role: "UNKNOWN", text });
  }
  return segs;
}

// Apollo (serverless-safe)
const apollo = new ApolloServer<Context>({
  typeDefs,
  resolvers: resolvers as any,
});

let apolloStartPromise: Promise<void> | null = null;
async function ensureApolloStarted() {
  if (!apolloStartPromise) apolloStartPromise = apollo.start();
  await apolloStartPromise;
}

async function buildContext(req: Request): Promise<Context> {
  const requestId = mkRequestId(req);
  const origin = String(req.headers.origin || "").trim();

  const tenant =
    String((req.headers["x-tenant"] || req.headers["x-intramedika-tenant"] || "") as string).trim() || "default";

  const authHeader = String(req.headers.authorization || "").trim();
  const auth = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  return { auth, origin, tenant, requestId };
}

// Express app
export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    speechMode: SPEECH_MODE,
    speechLanguage: SPEECH_LANGUAGE,
  })
);

app.post("/api/auth/login", express.json(), (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Username dan password wajib diisi" });
  }

  const users = getUsers();
  const user = users.find((u) => u.username === username && u.active);

  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    return res.status(401).json({ ok: false, error: "Username atau password salah" });
  }

  // Check if MFA setup is required
  if (!user.mfaEnrolled || !user.totpSecret) {
    const enrollmentToken = createToken(user.id, "enrollment");
    return res.json({
      ok: true,
      mfaEnrollmentRequired: true,
      enrollmentToken,
      message: "Setup Authenticator diperlukan"
    });
  }

  // MFA is already enrolled
  const mfaToken = createToken(user.id, "mfa");
  return res.json({
    ok: true,
    mfaRequired: true,
    mfaType: "TOTP",
    mfaToken,
    message: "Masukkan kode dari Authenticator App"
  });
});

app.post("/api/auth/mfa/setup", express.json(), (req, res) => {
  const { enrollmentToken } = req.body;
  if (!enrollmentToken) {
    return res.status(400).json({ ok: false, error: "Enrollment token wajib diisi" });
  }

  const userId = verifyToken(enrollmentToken, "enrollment");
  if (!userId) {
    return res.status(401).json({ ok: false, error: "Token setup tidak valid atau kadaluarsa" });
  }

  const users = getUsers();
  const userIdx = users.findIndex((u) => u.id === userId && u.active);
  if (userIdx === -1) {
    return res.status(401).json({ ok: false, error: "User tidak ditemukan" });
  }

  const user = users[userIdx];
  const secret = generateTotpSecret();
  
  // Save as pending secret
  user.pendingTotpSecret = secret;
  saveUsers(users);

  const otpauthUrl = getOtpauthUrl(user.username, secret);

  return res.json({
    ok: true,
    otpauthUrl,
    issuer: "IntraHospital SOAP Assistant",
    account: user.username,
    message: "Scan QR dengan Authenticator App"
  });
});

app.post("/api/auth/mfa/confirm", express.json(), (req, res) => {
  const { enrollmentToken, otp } = req.body;
  if (!enrollmentToken || !otp) {
    return res.status(400).json({ ok: false, error: "Token dan kode OTP wajib diisi" });
  }

  const userId = verifyToken(enrollmentToken, "enrollment");
  if (!userId) {
    return res.status(401).json({ ok: false, error: "Token setup tidak valid atau kadaluarsa" });
  }

  const users = getUsers();
  const userIdx = users.findIndex((u) => u.id === userId && u.active);
  if (userIdx === -1) {
    return res.status(401).json({ ok: false, error: "User tidak ditemukan" });
  }

  const user = users[userIdx];
  if (!user.pendingTotpSecret) {
    return res.status(400).json({ ok: false, error: "Sesi setup tidak ditemukan. Silakan login ulang dan scan QR baru." });
  }

  if (!verifyTOTP(user.pendingTotpSecret, otp)) {
    return res.status(401).json({ ok: false, error: "Kode Authenticator salah atau sudah kedaluwarsa. Masukkan kode terbaru." });
  }

  // Finalize MFA
  user.totpSecret = user.pendingTotpSecret;
  user.pendingTotpSecret = "";
  user.mfaEnabled = true;
  user.mfaEnrolled = true;
  saveUsers(users);

  const token = createToken(user.id, "session");
  const { salt: _, passwordHash: __, totpSecret: ___, pendingTotpSecret: ____, ...userPublic } = user;

  return res.json({
    ok: true,
    token,
    user: userPublic,
  });
});

app.post("/api/auth/verify-mfa", express.json(), (req, res) => {
  const { mfaToken, otp } = req.body;
  if (!mfaToken || !otp) {
    return res.status(400).json({ ok: false, error: "Token dan kode MFA wajib diisi" });
  }

  const userId = verifyToken(mfaToken, "mfa");
  if (!userId) {
    return res.status(401).json({ ok: false, error: "Sesi verifikasi kadaluarsa. Silakan login ulang." });
  }

  const users = getUsers();
  const user = users.find((u) => u.id === userId && u.active);

  if (!user || !user.totpSecret) {
    return res.status(401).json({ ok: false, error: "MFA belum dikonfigurasi" });
  }

  if (!verifyTOTP(user.totpSecret, otp)) {
    return res.status(401).json({ ok: false, error: "Kode Authenticator salah atau sudah kedaluwarsa. Masukkan kode terbaru." });
  }

  const token = createToken(user.id, "session");
  const { salt: _, passwordHash: __, totpSecret: ___, pendingTotpSecret: ____, ...userPublic } = user;

  return res.json({
    ok: true,
    token,
    user: userPublic,
  });
});

app.post("/api/admin/users/:username/reset-mfa", express.json(), (req, res) => {
  const { username } = req.params;

  // 1. Check if feature is enabled
  if (process.env.DEMO_ADMIN_RESET_ENABLED !== "true") {
    return res.status(404).json({ ok: false, error: "Not found" });
  }

  // 2. Validate Admin Key Configuration
  const adminKey = process.env.DEMO_ADMIN_KEY;
  if (!adminKey) {
    return res.status(500).json({ ok: false, error: "DEMO_ADMIN_KEY belum dikonfigurasi" });
  }

  // 3. Validate Request Header
  const requestKey = req.headers["x-demo-admin-key"];
  if (!requestKey || requestKey !== adminKey) {
    return res.status(401).json({ ok: false, error: "Admin key tidak valid" });
  }

  // 4. Restricted to demo accounts only
  const demoUsers = [
    "dokter.demo", "dokter.demo2", "dokter.demo3", "dokter.demo4", "dokter.demo5",
    "dokter.demo6", "dokter.demo7", "dokter.demo8", "dokter.demo9", "dokter.demo10"
  ];
  if (!demoUsers.includes(username)) {
    return res.status(403).json({ ok: false, error: "Reset MFA hanya tersedia untuk akun demo" });
  }

  // 5. Find and update user
  const users = getUsers();
  const userIdx = users.findIndex((u) => u.username === username && u.active);
  
  if (userIdx === -1) {
    return res.status(404).json({ ok: false, error: "User tidak ditemukan" });
  }

  const user = users[userIdx];
  
  // Reset MFA fields
  user.mfaEnabled = false;
  user.mfaEnrolled = false;
  user.mfaType = "TOTP";
  user.totpSecret = "";
  user.pendingTotpSecret = "";

  saveUsers(users);

  // Success response
  const { salt: _, passwordHash: __, totpSecret: ___, pendingTotpSecret: ____, ...userPublic } = user;

  return res.json({
    ok: true,
    message: "MFA reset berhasil",
    user: userPublic
  });
});

app.get("/api/auth/me", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Session tidak valid" });
  }

  const token = authHeader.slice(7);
  const userId = verifyToken(token, "session");

  if (!userId) {
    return res.status(401).json({ ok: false, error: "Session tidak valid" });
  }

  const users = getUsers();
  const user = users.find((u) => u.id === userId && u.active);

  if (!user) {
    return res.status(401).json({ ok: false, error: "User tidak ditemukan" });
  }

  const { salt: _, passwordHash: __, totpSecret: ___, pendingTotpSecret: ____, ...userPublic } = user;
  return res.json({
    ok: true,
    user: userPublic,
  });
});

const corsOptions = buildCorsOptions();
app.use(cors(corsOptions));
app.use(preflightAll(corsOptions));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.post("/api/speech", upload.single("audio"), async (req, res) => {
  const requestId = mkRequestId(req);
  res.setHeader("x-request-id", requestId);

  try {
    validateOciEnvIfNeeded();

    const file = (req as any).file as Express.Multer.File | undefined;
    const buf = file?.buffer;
    if (!buf) return res.status(400).json({ requestId, error: "audio is required" });

    if (buf.length < MIN_AUDIO_BYTES) {
      return res.status(400).json({ requestId, error: "audio too small", audioBytes: buf.length });
    }

    const format = mapMimeToFormat(file?.mimetype || "audio/webm");

    if (SPEECH_MODE === "MOCK") {
      const transcript = "Audio diterima (MOCK). Transkrip real tersedia pada mode OCI.";
      return res.json({
        requestId,
        engine: "MOCK_SPEECH",
        transcript,
        segments: pseudoDiarize(transcript),
      });
    }

    const { transcript, segments } = await withTimeout(
      transcribeAudio(buf, {
        format,
        languageCode: SPEECH_LANGUAGE,
        diarization: true,
        numberOfSpeakers: 2,
      }),
      SPEECH_TIMEOUT_MS,
      "speech_timeout"
    );

    const cleaned = String(transcript || "").trim();
    if (!cleaned) return res.status(502).json({ requestId, error: "Empty transcript from OCI Speech" });

    const finalSegments = Array.isArray(segments) && segments.length ? segments : pseudoDiarize(cleaned);

    return res.json({
      requestId,
      engine: "OCI_SPEECH",
      transcript: cleaned,
      segments: finalSegments,
    });
  } catch (err: any) {
    console.error("[SPEECH_ERROR]", err);
    return res.status(500).json({
      requestId,
      error: "Speech processing failed",
      message: String(err?.message || "Unknown error").slice(0, 300),
    });
  }
});

app.use("/graphql", express.json(), async (req, res, next) => {
  try {
    await ensureApolloStarted();
    return expressMiddleware<Context>(apollo, {
      context: async () => buildContext(req),
    })(req, res, next);
  } catch (e) {
    next(e);
  }
});

app.use("/api/graphql", express.json(), async (req, res, next) => {
  try {
    await ensureApolloStarted();
    return expressMiddleware<Context>(apollo, {
      context: async () => buildContext(req),
    })(req, res, next);
  } catch (e) {
    next(e);
  }
});

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("[SERVER_ERROR]", err);
  res.status(500).json({ error: err?.message || "Internal error" });
});
