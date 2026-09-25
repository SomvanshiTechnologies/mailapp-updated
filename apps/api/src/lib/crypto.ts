import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Symmetric encryption for secrets we must be able to read back (IMAP passwords).
 * AES-256-GCM with a key derived from APP_SECRET; output is "v1.<iv>.<tag>.<ciphertext>" (base64url).
 */
export function encryptSecret(appSecret: string, plaintext: string): string {
  const key = createHash("sha256").update(appSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptSecret(appSecret: string, payload: string): string {
  const [v, ivB, tagB, dataB] = payload.split(".");
  if (v !== "v1" || !ivB || !tagB || !dataB) throw new Error("Unrecognised secret payload");
  const key = createHash("sha256").update(appSecret).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB, "base64url")), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmac(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Unsubscribe token = base64url(leadId) + "." + hmac(secret, leadId).
 * Stateless verification; the lead row also stores the token for lookup.
 */
export function makeUnsubscribeToken(secret: string, leadId: string): string {
  const payload = Buffer.from(leadId).toString("base64url");
  return `${payload}.${hmac(secret, leadId)}`;
}

export function verifyUnsubscribeToken(secret: string, token: string): string | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  let leadId: string;
  try {
    leadId = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!safeEqual(hmac(secret, leadId), sig)) return null;
  return leadId;
}

/** RFC 5322 Message-ID we set ourselves so replies can be threaded even before SES assigns its id. */
export function makeMessageId(domain: string): string {
  return `<${Date.now().toString(36)}.${randomBytes(12).toString("hex")}@${domain}>`;
}
