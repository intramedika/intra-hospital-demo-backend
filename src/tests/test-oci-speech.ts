import fs from "fs";
import path from "path";
import { transcribeAudio } from "../oci/speech.js";

async function main() {
  // ganti dengan file audio asli hasil record widget
  const audioPath = path.resolve(__dirname, "sample.webm");
  const buffer = fs.readFileSync(audioPath);

  const text = await transcribeAudio(buffer, { format: "WEBM" });
  console.log("=== TRANSCRIPTION RESULT ===");
  console.log(text);
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
