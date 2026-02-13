/**
 * Browser Setup Server
 *
 * Runs a local HTTP server on the client machine to facilitate secure browser authentication.
 * Instead of saving the bearer token to filesystem (where prompt injection could read it),
 * we issue device-scoped session cookies directly to the browser.
 */

import express, { Request, Response } from 'express';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { createComponentLogger } from './logging.js';

let _log: ReturnType<typeof createComponentLogger> | null = null;
function log() {
  if (!_log) _log = createComponentLogger('setup-server');
  return _log;
}

// Encryption key for session cookies (ephemeral, generated on agent start)
const SESSION_KEY = randomBytes(32);
const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypt device credentials for session cookie
 */
function encryptSession(deviceId: string, deviceSecret: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, SESSION_KEY, iv);

  const payload = JSON.stringify({ deviceId, deviceSecret });
  let encrypted = cipher.update(payload, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt session cookie back to device credentials
 */
export function decryptSession(encryptedSession: string): { deviceId: string; deviceSecret: string } | null {
  try {
    const [ivHex, authTagHex, encrypted] = encryptedSession.split(':');
    if (!ivHex || !authTagHex || !encrypted) return null;

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, SESSION_KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

/**
 * Start local HTTP server for browser setup
 */
export function startSetupServer(
  deviceId: string,
  deviceSecret: string,
  serverUrl: string
): { port: number; setupCode: string } {
  const app = express();
  const port = findAvailablePort();
  const setupCode = randomBytes(8).toString('hex');

  // Setup endpoint - validates code and redirects to server for session creation
  app.get('/setup', (req: Request, res: Response) => {
    // Validate one-time setup code
    if (req.query.code !== setupCode) {
      log().warn('Invalid setup code attempt', { ip: req.ip });
      return res.status(403).send(`
        <html>
          <head><title>Setup Failed</title></head>
          <body style="font-family: system-ui; max-width: 600px; margin: 100px auto; text-align: center;">
            <h1>❌ Invalid Setup Code</h1>
            <p>Please use the setup link provided by the agent.</p>
          </body>
        </html>
      `);
    }

    log().info('Setup code validated, submitting credentials to server via POST');

    // Auto-submit POST form to avoid exposing device secret in URL query params
    // (GET redirects would log the secret in web server access logs and browser history)
    const authUrl = `${serverUrl}/auth/device-session`;
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authenticating...</title>
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              max-width: 600px;
              margin: 100px auto;
              text-align: center;
              color: #333;
            }
            .spinner {
              border: 4px solid #f3f3f3;
              border-top: 4px solid #3498db;
              border-radius: 50%;
              width: 40px;
              height: 40px;
              animation: spin 1s linear infinite;
              margin: 20px auto;
            }
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
          </style>
        </head>
        <body>
          <div class="spinner"></div>
          <h2>Authenticating device...</h2>
          <p>You will be redirected shortly.</p>
          <form id="authForm" method="POST" action="${authUrl}">
            <input type="hidden" name="deviceId" value="${deviceId}" />
            <input type="hidden" name="secret" value="${deviceSecret}" />
            <input type="hidden" name="redirect" value="/credentials/session" />
          </form>
          <script>
            // Auto-submit after a brief delay to show the loading screen
            setTimeout(() => document.getElementById('authForm').submit(), 500);
          </script>
        </body>
      </html>
    `);
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', deviceId });
  });

  // Start server
  const server = app.listen(port, 'localhost', () => {
    log().info(`Setup server started on http://localhost:${port}`);
  });

  // Handle errors
  server.on('error', (err: Error) => {
    log().error('Setup server error', { error: err });
  });

  return { port, setupCode };
}

/**
 * Find an available port for the setup server
 */
function findAvailablePort(): number {
  // Use a random port in the ephemeral range
  return 49152 + Math.floor(Math.random() * (65535 - 49152));
}
