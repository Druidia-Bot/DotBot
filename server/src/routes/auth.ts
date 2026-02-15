/**
 * Auth Routes
 *
 * Authentication middleware, device session endpoint,
 * credential routes, and invite routes.
 */

import type { Hono } from "hono";
import { getAdminApiKey } from "../init.js";
import { createDeviceSession, startSessionCleanup as startDeviceSessionCleanup } from "../auth/device-sessions.js";
import { registerCredentialRoutes } from "../credentials/routes.js";
import { initMasterKey } from "../credentials/crypto.js";
import { startSessionCleanup } from "../credentials/sessions.js";
import { registerInviteRoutes } from "../auth/invite-page.js";

// ============================================
// AUTH MIDDLEWARE
// ============================================

export function registerAuthMiddleware(app: Hono): void {
  app.use("/api/*", async (c, next) => {
    // Public routes that don't need auth
    const publicRoutes = [
      "/api/council/config", // Just returns a message (feature disabled message)
    ];

    const path = c.req.path;
    if (publicRoutes.includes(path)) {
      return next();
    }

    // If no admin API key is configured, allow access (dev mode)
    const validToken = getAdminApiKey();
    if (!validToken) {
      console.warn("[API Auth] No ADMIN_API_KEY configured - allowing unauthenticated access");
      return next();
    }

    // Check for Authorization header
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized - Bearer token required" }, 401);
    }

    const token = authHeader.substring(7); // Remove "Bearer " prefix
    if (token !== validToken) {
      return c.json({ error: "Unauthorized - Invalid token" }, 401);
    }

    return next();
  });
}

// ============================================
// AUTH ROUTES
// ============================================

export function registerAuthRoutes(app: Hono, config: { publicUrl: string; wsPort: string }): void {
  // Device authentication endpoint (browser setup flow)
  // POST endpoint - credentials in request body (not logged in access logs)
  app.post("/auth/device-session", async (c) => {
    const body = await c.req.parseBody();
    const deviceId = body.deviceId as string;
    const secret = body.secret as string;
    const redirectPath = (body.redirect as string) || "/credentials/session";

    if (!deviceId || !secret) {
      return c.html(`
        <html>
          <head><title>Authentication Failed</title></head>
          <body style="font-family: system-ui; max-width: 600px; margin: 100px auto; text-align: center;">
            <h1>❌ Authentication Failed</h1>
            <p>Missing device credentials. Please use the setup link provided by your agent.</p>
          </body>
        </html>
      `, 400);
    }

    // L-02 fix: Extract client IP for auth logging
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
               c.req.header("x-real-ip") ||
               "unknown";

    // Validate device credentials and create session
    const session = await createDeviceSession(deviceId, secret, ip);

    if (!session) {
      return c.html(`
        <html>
          <head><title>Authentication Failed</title></head>
          <body style="font-family: system-ui; max-width: 600px; margin: 100px auto; text-align: center;">
            <h1>❌ Invalid Credentials</h1>
            <p>Device authentication failed. Please check your setup link or restart the agent.</p>
          </body>
        </html>
      `, 403);
    }

    // Set session cookie
    c.header("Set-Cookie", `dotbot_device_session=${session.sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`);

    // Redirect to credential page
    return c.redirect(redirectPath);
  });

  // Credential entry routes (secure page for entering API keys)
  initMasterKey();
  startSessionCleanup();
  startDeviceSessionCleanup();
  registerCredentialRoutes(app);

  // Invite page (public — serves install instructions for new users)
  registerInviteRoutes(app, { publicUrl: config.publicUrl, wsPort: config.wsPort });
}
