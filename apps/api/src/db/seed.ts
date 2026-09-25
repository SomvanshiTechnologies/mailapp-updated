import { fileURLToPath } from "node:url";
import path from "node:path";
import { getConfig } from "../config.js";
import { createDb } from "./client.js";
import { instructionDocs, users } from "./schema.js";
import { hashPassword } from "../modules/auth/password.js";

export const DEFAULT_INSTRUCTIONS = [
  {
    kind: "tone" as const,
    title: "Default tone",
    content: `Warm, direct and specific. Write like a thoughtful peer, not a salesperson.
- Lead with something true about them, not about us.
- Short sentences. No hype words (revolutionary, game-changing, cutting-edge, synergy).
- No exclamation marks. No emojis.
- One idea per paragraph.`,
  },
  {
    kind: "format" as const,
    title: "Default format",
    content: `- Greeting on its own line using the first name ("Hi Priya,").
- 2-4 short paragraphs, 60-140 words in total.
- Exactly one call to action, phrased as a low-effort question.
- No bullet points, no bold, no links unless the rules allow one.
- Do not include a signature; it is added automatically.`,
  },
  {
    kind: "rules" as const,
    title: "Default rules",
    content: `- Never invent facts, numbers, customer names or quotes.
- Never mention pricing or discounts.
- Never claim we have worked with the recipient's competitors unless a proof point says so explicitly.
- Do not reference private or sensitive information about the person.
- Follow-ups must add something new (a proof point, a different angle) rather than repeating the first email.`,
  },
  {
    kind: "signature" as const,
    title: "Default signature",
    content: `Best regards,
Outreach Team`,
  },
];

export async function seed(connectionString: string, opts: { adminEmail?: string; adminPassword?: string; log?: (m: string) => void } = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const handle = createDb(connectionString, { max: 2 });
  try {
    const existingUsers = await handle.db.select({ id: users.id }).from(users).limit(1);
    if (existingUsers.length === 0) {
      if (!opts.adminEmail || !opts.adminPassword) {
        log("No users exist and SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD not set; skipping admin creation");
      } else {
        await handle.db.insert(users).values({
          email: opts.adminEmail.toLowerCase(),
          name: "Administrator",
          passwordHash: await hashPassword(opts.adminPassword),
          role: "admin",
        });
        log(`Created admin user ${opts.adminEmail}`);
      }
    } else {
      log("Users already exist; skipping admin creation");
    }
    const docs = await handle.db.select({ id: instructionDocs.id }).from(instructionDocs).limit(1);
    if (docs.length === 0) {
      await handle.db.insert(instructionDocs).values(DEFAULT_INSTRUCTIONS.map((d) => ({ ...d, version: 1, isActive: true })));
      log(`Seeded ${DEFAULT_INSTRUCTIONS.length} default instruction documents`);
    }
  } finally {
    await handle.close();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const cfg = getConfig();
  seed(cfg.DATABASE_URL, { adminEmail: cfg.SEED_ADMIN_EMAIL, adminPassword: cfg.SEED_ADMIN_PASSWORD })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
