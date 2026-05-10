import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USERS_FILE = path.join(__dirname, "../data/users.json");

const doctors = [
  { username: "dokter.demo", name: "Dr. Anindya Putri", unit: "Poli Umum" },
  { username: "dokter.demo2", name: "Dr. Bima Santoso", unit: "Poli Umum" },
  { username: "dokter.demo3", name: "Dr. Citra Lestari", unit: "Poli Penyakit Dalam" },
  { username: "dokter.demo4", name: "Dr. Dimas Pratama", unit: "Poli Anak" },
  { username: "dokter.demo5", name: "Dr. Elina Maharani", unit: "Poli Kandungan" },
  { username: "dokter.demo6", name: "Dr. Farhan Wijaya", unit: "Poli Bedah" },
  { username: "dokter.demo7", name: "Dr. Gita Anggraini", unit: "Poli Gigi" },
  { username: "dokter.demo8", name: "Dr. Haris Nugroho", unit: "IGD" },
  { username: "dokter.demo9", name: "Dr. Intan Permata", unit: "Poli Saraf" },
  { username: "dokter.demo10", name: "Dr. Jovan Ardiansyah", unit: "Poli Jantung" },
];

function hashPassword(password, salt) {
  const iterations = 100000;
  const keylen = 64;
  const digest = "sha256";
  return crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString("hex");
}

const password = "Demo123!";
const users = doctors.map((doc, index) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const idNum = (index + 1).toString().padStart(3, "0");
  return {
    id: `u-demo-doctor-${idNum}`,
    username: doc.username,
    name: doc.name,
    role: "DOCTOR",
    unit: doc.unit,
    demoScope: "SOAP_VOICE",
    salt: salt,
    passwordHash: hashPassword(password, salt),
    active: true,
    mfaEnabled: false,
    mfaEnrolled: false,
    mfaType: "TOTP",
    totpSecret: "",
    pendingTotpSecret: "",
  };
});

fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf-8");
console.log(`Successfully generated ${users.length} demo users in ${USERS_FILE}`);
