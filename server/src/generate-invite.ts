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
console.log("\n╔═══════════════════════════════════════════════════════════════╗");
console.log("║  🔑 Invite Token Generated                                   ║");
console.log("║                                                               ║");
console.log(`║     ${token}                                ║`);
console.log("║                                                               ║");
console.log(`║  Expires: ${expiresAt.substring(0, 10)}    Max uses: ${String(maxUses).padEnd(25)}║`);
console.log(`║  Label:   ${label.substring(0, 47).padEnd(47)}║`);
console.log("╚═══════════════════════════════════════════════════════════════╝\n");
