import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USERS_FILE = path.join(__dirname, "../data/users.json");

function hashPassword(password, salt) {
  const iterations = 100000;
  const keylen = 64;
  const digest = "sha256";
  return crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString("hex");
}

async function createDemoUser() {
  const salt = crypto.randomBytes(16).toString("hex");
  const password = "Demo123!";
  const passwordHash = hashPassword(password, salt);

  const demoUser = {
    id: "u-demo-doctor-001",
    username: "dokter.demo",
    name: "Dr. Anindya Putri",
    role: "DOCTOR",
    unit: "Poli Umum",
    demoScope: "SOAP_VOICE",
    salt: salt,
    passwordHash: passwordHash,
    active: true,
    mfaEnabled: false,
    mfaEnrolled: false,
    mfaType: "TOTP",
    totpSecret: "",
    pendingTotpSecret: ""
  };

  const users = [demoUser];

  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf-8");

  console.log("Demo user created successfully!");
  console.log("Username: dokter.demo");
  console.log("Password: Demo123!");
  console.log("MFA enrollment will be required on first login.");
}

createDemoUser().catch(console.error);
