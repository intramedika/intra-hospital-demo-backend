import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { authenticator } = require("@otplib/preset-default");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USERS_FILE = path.join(__dirname, "../data/users.json");
const AUTH_SECRET = process.env.AUTH_SECRET || "intrahospital-demo-secret-2026";
const SESSION_TOKEN_TTL_SECONDS = Number(process.env.SESSION_TOKEN_TTL_SECONDS || 43200); // 12 hours
const MFA_TOKEN_TTL_SECONDS = Number(process.env.MFA_TOKEN_TTL_SECONDS || 300); // 5 minutes

export interface User {
  id: string;
  username: string;
  name: string;
  role: string;
  unit: string;
  demoScope: string;
  salt: string;
  passwordHash: string;
  active: boolean;
  mfaEnabled: boolean;
  mfaEnrolled: boolean;
  mfaType: string;
  totpSecret: string;
  pendingTotpSecret: string;
}

export function getUsers(): User[] {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const data = fs.readFileSync(USERS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    console.error("Error reading users file:", err);
    return [];
  }
}

export function saveUsers(users: User[]) {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf-8");
}

export function hashPassword(password: string, salt: string): string {
  const iterations = 100000;
  const keylen = 64;
  const digest = "sha256";
  return crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString("hex");
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  return hashPassword(password, salt) === hash;
}

export function createToken(userId: string, type: "session" | "mfa" | "enrollment"): string {
  const timestamp = Date.now();
  const payload = `${userId}:${timestamp}:${type}`;
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}:${signature}`).toString("base64");
}

export function verifyToken(token: string, expectedType: "session" | "mfa" | "enrollment"): string | null {
  try {
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const [userId, timestampStr, tokenType, signature] = decoded.split(":");
    const timestamp = parseInt(timestampStr, 10);
    
    let ttlMs = SESSION_TOKEN_TTL_SECONDS * 1000;
    if (expectedType === "mfa" || expectedType === "enrollment") {
      ttlMs = MFA_TOKEN_TTL_SECONDS * 1000;
    }

    if (isNaN(timestamp) || Date.now() - timestamp > ttlMs || tokenType !== expectedType) {
      return null;
    }

    const payload = `${userId}:${timestamp}:${tokenType}`;
    const expectedSignature = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");

    if (signature === expectedSignature) {
      return userId;
    }
  } catch (err) {
    // Ignore decoding errors
  }
  return null;
}

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function getOtpauthUrl(username: string, secret: string): string {
  return authenticator.keyuri(username, "IntraHospital SOAP Assistant", secret);
}

export function verifyTOTP(secret: string, code: string): boolean {
  if (!secret || !code) return false;
  
  // Support bypass for demo if enabled
  if (process.env.MFA_DEMO_BYPASS_ENABLED === "true" && code === process.env.MFA_DEMO_OTP) {
    return true;
  }

  return authenticator.check(code, secret);
}
