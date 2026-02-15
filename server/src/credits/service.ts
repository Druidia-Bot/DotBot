/**
 * Credit Service
 * 
 * Manages user credit balances for premium tool access.
 * New users start with 50 credits. Premium tools deduct credits per use.
 */

import { getDatabase } from "../db/index.js";
import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("credits");

const INITIAL_BALANCE = 50;

// ============================================
// BALANCE OPERATIONS
// ============================================

/**
 * Get or initialize a user's credit balance.
 * Creates the record with INITIAL_BALANCE if it doesn't exist.
 */
export function getBalance(userId: string): number {
  const db = getDatabase();
  
  const row = db.prepare("SELECT balance FROM user_credits WHERE user_id = ?").get(userId) as any;
  if (row) return row.balance;

  // New user — initialize with default balance
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_credits (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `).run(userId, INITIAL_BALANCE, INITIAL_BALANCE, now, now);

  log.info("Initialized credits for new user", { userId, balance: INITIAL_BALANCE });
  return INITIAL_BALANCE;
}

/**
 * Check if a user has enough credits for a tool call.
 */
export function hasCredits(userId: string, cost: number): boolean {
  return getBalance(userId) >= cost;
}

/**
 * Deduct credits for a premium tool call.
 * Returns the new balance, or throws if insufficient.
 */
export function deductCredits(
  userId: string,
  cost: number,
  toolId: string,
  reason: string,
  metadata?: Record<string, any>
): number {
  const db = getDatabase();
  const balance = getBalance(userId);

  if (balance < cost) {
    throw new InsufficientCreditsError(balance, cost);
  }

  const newBalance = balance - cost;
  const now = new Date().toISOString();
  const txId = `tx_${nanoid(12)}`;

  // Update balance
  db.prepare(`
    UPDATE user_credits 
    SET balance = ?, lifetime_spent = lifetime_spent + ?, updated_at = ?
    WHERE user_id = ?
  `).run(newBalance, cost, now, userId);

  // Log transaction
  db.prepare(`
    INSERT INTO credit_transactions (id, user_id, amount, balance_after, reason, tool_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(txId, userId, -cost, newBalance, reason, toolId, metadata ? JSON.stringify(metadata) : null, now);

  log.info("Credits deducted", { userId, cost, newBalance, toolId, reason });
  return newBalance;
}

/**
 * Add credits to a user's balance (grants, purchases, etc.).
 */
export function addCredits(
  userId: string,
  amount: number,
  reason: string
): number {
  const db = getDatabase();
  const balance = getBalance(userId);
  const newBalance = balance + amount;
  const now = new Date().toISOString();
  const txId = `tx_${nanoid(12)}`;

  db.prepare(`
    UPDATE user_credits 
    SET balance = ?, lifetime_earned = lifetime_earned + ?, updated_at = ?
    WHERE user_id = ?
  `).run(newBalance, amount, now, userId);

  db.prepare(`
    INSERT INTO credit_transactions (id, user_id, amount, balance_after, reason, tool_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
  `).run(txId, userId, amount, newBalance, reason, now);

  log.info("Credits added", { userId, amount, newBalance, reason });
  return newBalance;
}

/**
 * Get recent transactions for a user.
 */
export function getTransactions(userId: string, limit = 20): CreditTransaction[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM credit_transactions 
    WHERE user_id = ? 
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(userId, limit) as any[];

  return rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    amount: row.amount,
    balanceAfter: row.balance_after,
    reason: row.reason,
    toolId: row.tool_id,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
  }));
}

// ============================================
// TYPES
// ============================================

export interface CreditTransaction {
  id: string;
  userId: string;
  amount: number;
  balanceAfter: number;
  reason: string;
  toolId: string | null;
  metadata: Record<string, any> | null;
  createdAt: string;
}

export class InsufficientCreditsError extends Error {
  public balance: number;
  public cost: number;

  constructor(balance: number, cost: number) {
    super(`Insufficient credits: have ${balance}, need ${cost}`);
    this.name = "InsufficientCreditsError";
    this.balance = balance;
    this.cost = cost;
  }
}
