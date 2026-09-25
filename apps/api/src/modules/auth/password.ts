import { hash, verify } from "@node-rs/argon2";

const OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 }; // OWASP argon2id baseline

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}
