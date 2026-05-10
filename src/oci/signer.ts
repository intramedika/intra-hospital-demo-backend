// src/oci/signer.ts
// Intramedika — OCI RAW Request Signer (PRODUCTION-GRADE)
// - Binary-safe (Buffer/Uint8Array OK)
// - Robust env normalization (% / url-encoded / \n)
// - Extracts PEM block only (ignores garbage after END PRIVATE KEY)
// - OCI Signature v1 RSA-SHA256
//
// Exports:
// - signOciRequestAsync(input) -> signed headers
// - ociSignedRequest(url, init) -> signed fetch wrapper
// - signedRequest alias

import crypto from "crypto";

type BodyLike = string | Buffer | Uint8Array | Record<string, any> | undefined | null;

type SignInput = {
  method: string;
  url: URL;
  headers?: Record<string, string>;
  body?: BodyLike; // body used for signing (MUST match fetch body bytes)
};

type SignedFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyLike; // string | object | Buffer | Uint8Array
  signal?: AbortSignal; // ✅ support abort/timeout
};

function requireEnv(name: string): string {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

/**
 * Normalize base64 from env:
 * - removes whitespace
 * - strips trailing '%' (common copy/paste artifact)
 * - decodes URI-encoded sequences if present
 */
function normalizeBase64(raw: string): string {
  let s = String(raw ?? "").trim();
  while (s.endsWith("%")) s = s.slice(0, -1);

  try {
    if (/%[0-9A-Fa-f]{2}/.test(s)) s = decodeURIComponent(s);
  } catch {
    // ignore
  }

  return s.replace(/\s+/g, "");
}

/**
 * Extract first PEM private key block from decoded text.
 * Accepts both "PRIVATE KEY" and "RSA PRIVATE KEY".
 */
function extractPemPrivateKey(decodedText: string): string {
  const text = String(decodedText ?? "").replace(/\\n/g, "\n");

  const m = text.match(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/m
  );

  if (!m) throw new Error("OCI_PRIVATE_KEY_BASE64 does not contain a valid PEM private key block");
  return m[0].trim();
}

function decodePrivateKeyPemFromBase64(b64: string): string {
  const normalized = normalizeBase64(b64);
  const decoded = Buffer.from(normalized, "base64").toString("utf8");
  return extractPemPrivateKey(decoded);
}

function sha256Base64(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("base64");
}

function rfc1123Date(): string {
  return new Date().toUTCString();
}

/**
 * Normalize incoming headers to lowercase to avoid duplicates like:
 * "Content-Type" + "content-type"
 */
function normalizeHeaders(input?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const [k, v] of Object.entries(input)) {
    const key = String(k).toLowerCase().trim();
    if (!key) continue;
    out[key] = String(v);
  }
  return out;
}

function buildSigningString(params: {
  method: string;
  url: URL;
  headersLower: Record<string, string>;
  signedHeaders: string[];
}): string {
  const { method, url, headersLower, signedHeaders } = params;

  const pathWithQuery = url.pathname + (url.search || "");
  const requestTarget = `(request-target): ${method.toLowerCase()} ${pathWithQuery}`;

  const lines: string[] = [];
  for (const name of signedHeaders) {
    if (name === "(request-target)") {
      lines.push(requestTarget);
      continue;
    }
    const v = headersLower[name];
    if (v === undefined) throw new Error(`Missing required header for signing: ${name}`);
    lines.push(`${name}: ${v}`);
  }

  return lines.join("\n");
}

function signString(signingString: string, privateKeyPem: string): string {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingString);
  signer.end();
  return signer.sign(privateKeyPem).toString("base64");
}

function bodyToBuffer(body: BodyLike): Buffer {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(JSON.stringify(body), "utf8");
}

/**
 * Build signed headers (no fetch)
 * NOTE: returns headers in lowercase to avoid duplicate header variants.
 */
export async function signOciRequestAsync(input: SignInput): Promise<Record<string, string>> {
  const method = String(input.method ?? "").toUpperCase().trim();
  if (!method) throw new Error("signOciRequestAsync: method is required");
  if (!input.url) throw new Error("signOciRequestAsync: url is required");

  const tenancyId = requireEnv("OCI_TENANCY_OCID");
  const userId = requireEnv("OCI_USER_OCID");
  const fingerprint = requireEnv("OCI_FINGERPRINT");
  const privateKeyPem = decodePrivateKeyPemFromBase64(requireEnv("OCI_PRIVATE_KEY_BASE64"));

  const url = input.url;
  const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
  const bodyBuf = hasBody ? bodyToBuffer(input.body) : Buffer.alloc(0);

  // ✅ normalize incoming headers to lowercase (prevents duplicates)
  const headers = normalizeHeaders(input.headers);

  // required
  headers["host"] = url.host;

  // date or x-date (keep whichever caller provides)
  if (!headers["date"] && !headers["x-date"]) {
    headers["date"] = rfc1123Date();
  }

  if (hasBody) {
    // do NOT overwrite caller-provided content-type
    if (!headers["content-type"]) headers["content-type"] = "application/json";
    headers["content-length"] = String(bodyBuf.length);
    headers["x-content-sha256"] = sha256Base64(bodyBuf);
  }

  const signedHeaders: string[] = ["(request-target)", "host"];
  if (headers["date"]) signedHeaders.push("date");
  else if (headers["x-date"]) signedHeaders.push("x-date");

  if (hasBody) {
    signedHeaders.push("x-content-sha256", "content-type", "content-length");
  }

  const signingString = buildSigningString({
    method,
    url,
    headersLower: headers,
    signedHeaders,
  });

  const signature = signString(signingString, privateKeyPem);
  const keyId = `${tenancyId}/${userId}/${fingerprint}`;

  headers["authorization"] =
    `Signature version="1",` +
    `keyId="${keyId}",` +
    `algorithm="rsa-sha256",` +
    `headers="${signedHeaders.join(" ")}",` +
    `signature="${signature}"`;

  return headers;
}

/**
 * Signed fetch wrapper
 * Ensures: bytes used for signing = bytes sent to fetch.
 */
export async function ociSignedRequest(urlStr: string, init: SignedFetchInit = {}) {
  const url = new URL(urlStr);
  const method = String(init.method ?? "GET").toUpperCase();
  const hasBody = method === "POST" || method === "PUT" || method === "PATCH";

  const body = hasBody ? init.body : undefined;

  // ✅ sign using the same body bytes we will send
  const signedHeaders = await signOciRequestAsync({
    method,
    url,
    headers: init.headers ?? {},
    body,
  });

  // IMPORTANT: if body is object (plain), stringify it to match signing bytes
  const bodyToSend =
    body &&
    typeof body === "object" &&
    !Buffer.isBuffer(body) &&
    !(body instanceof Uint8Array)
      ? JSON.stringify(body)
      : (body as any);

  return fetch(url.toString(), {
    method,
    headers: signedHeaders,
    body: hasBody ? bodyToSend : undefined,
    signal: init.signal, // ✅ forward AbortSignal
  });
}

export const signedRequest = ociSignedRequest;
