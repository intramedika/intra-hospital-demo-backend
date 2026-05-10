import crypto from "crypto";

const password = "Demo123!";
const salt = crypto.randomBytes(16).toString("hex");
const iterations = 100000;
const keylen = 64;
const digest = "sha256";

const hash = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString("hex");

console.log("Salt:", salt);
console.log("Hash:", hash);
console.log("Iterations:", iterations);
