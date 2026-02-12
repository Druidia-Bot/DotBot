/**
 * Lightweight invite token generator — runs without starting the server.
 * 
 * Usage:
 *   node server/dist/generate-invite.js
 *   node server/dist/generate-invite.js --label "For Alice" --expiry-days 14 --max-uses 3
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "../../.env") });

import { initDatabase } from "./db/index.js";
import { initBotEnvironment } from "./init.js";
import { createInviteToken } from "./auth/invite-tokens.js";

initDatabase();
initBotEnvironment();

const labelIdx = process.argv.indexOf("--label");
const label = labelIdx !== -1 && process.argv[labelIdx + 1] ? process.argv[labelIdx + 1] : "CLI-generated token";
const expiryIdx = process.argv.indexOf("--expiry-days");
const expiryDays = expiryIdx !== -1 ? parseInt(process.argv[expiryIdx + 1]) || 7 : 7;
const maxUsesIdx = process.argv.indexOf("--max-uses");
const maxUses = maxUsesIdx !== -1 ? parseInt(process.argv[maxUsesIdx + 1]) || 1 : 1;

const { token, expiresAt } = createInviteToken({ label, expiryDays, maxUses });

const publicUrl = process.env.PUBLIC_URL || "http://localhost:3000";
const inviteUrl = `${publicUrl}/invite/${token}`;

const contentLines = [
  `  🔑 Invite Token Generated`,
  ``,
  `     ${token}`,
  ``,
  `  Expires: ${expiresAt.substring(0, 10)}    Max uses: ${maxUses}`,
  `  Label:   ${label}`,
  ``,
  `  📋 Share this link with the user:`,
  `     ${inviteUrl}`,
];
const innerWidth = Math.max(59, ...contentLines.map(l => l.length + 2));
const hr = "═".repeat(innerWidth);
console.log(`\n╔${hr}╗`);
for (const line of contentLines) {
  console.log(`║${line.padEnd(innerWidth)}║`);
}
console.log(`╚${hr}╝\n`);
