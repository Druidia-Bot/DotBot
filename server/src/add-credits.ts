/**
 * Standalone credit grant script — runs without starting the server.
 * Adds credits to ALL users who have a balance record in the database.
 *
 * Usage:
 *   node server/dist/add-credits.js --amount 100
 *   node server/dist/add-credits.js --amount 50 --reason "Monthly bonus"
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "../../.env") });

import { initDatabase, getDatabase } from "./db/index.js";
import { initBotEnvironment } from "./init.js";
import { addCredits, getBalance } from "./credits/service.js";

initDatabase();
initBotEnvironment();

// ── Parse CLI args ──────────────────────────────────────────
const amountIdx = process.argv.indexOf("--amount");
const amount = amountIdx !== -1 ? parseInt(process.argv[amountIdx + 1]) : NaN;

if (!amount || amount <= 0) {
  console.error("\nUsage: node server/dist/add-credits.js --amount <number> [--reason \"...\"]");
  console.error("  --amount   Number of credits to add (required, positive integer)");
  console.error("  --reason   Reason for the grant (optional, default: \"Admin grant\")\n");
  process.exit(1);
}

const reasonIdx = process.argv.indexOf("--reason");
const reason = reasonIdx !== -1 && process.argv[reasonIdx + 1] ? process.argv[reasonIdx + 1] : "Admin grant";

// ── Seed credit records for registered devices ──────────────
const db = getDatabase();

const devices = db.prepare("SELECT id FROM devices WHERE status = 'active'").all() as { id: string }[];
let seeded = 0;
for (const { id } of devices) {
  const existing = db.prepare("SELECT 1 FROM user_credits WHERE user_id = ?").get(id);
  if (!existing) {
    getBalance(id); // initializes with default balance
    seeded++;
  }
}
if (seeded > 0) {
  console.log(`Initialized credit records for ${seeded} new device(s).`);
}

// ── Fetch all users ─────────────────────────────────────────
const users = db.prepare("SELECT user_id FROM user_credits").all() as { user_id: string }[];

if (users.length === 0) {
  console.log("\nNo registered devices or users found in the database.\n");
  process.exit(0);
}

// ── Grant credits ───────────────────────────────────────────
console.log(`\nGranting ${amount} credits to ${users.length} user(s)  —  reason: "${reason}"\n`);

const results: { userId: string; before: number; after: number }[] = [];

for (const { user_id } of users) {
  const before = getBalance(user_id);
  const after = addCredits(user_id, amount, reason);
  results.push({ userId: user_id, before, after });
}

// ── Summary ─────────────────────────────────────────────────
const col1 = Math.max(9, ...results.map(r => r.userId.length)) + 2;
const header = "  User ID".padEnd(col1) + "Before".padStart(8) + "  ->  " + "After".padStart(8);
const hr = "─".repeat(header.length);

console.log(hr);
console.log(header);
console.log(hr);
for (const r of results) {
  console.log(`  ${r.userId.padEnd(col1 - 2)}${String(r.before).padStart(8)}  ->  ${String(r.after).padStart(8)}`);
}
console.log(hr);
console.log(`\nDone. ${results.length} user(s) each received ${amount} credits.\n`);
