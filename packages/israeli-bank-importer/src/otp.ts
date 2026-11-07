import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const DEFAULT_OTP_TIMEOUT_MS = 5 * 60_000;
const MAX_REQUEST_BODY_BYTES = 1_024;

type PendingOtp = {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export class OtpCoordinator {
  private pending: PendingOtp | undefined;

  isWaiting(): boolean {
    return this.pending !== undefined;
  }

  async waitForCode(timeoutMs = DEFAULT_OTP_TIMEOUT_MS): Promise<string> {
    if (this.pending) {
      throw new Error('An OTP request is already active');
    }

    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'hapoalim_otp_required',
        message: 'Submit the SMS code to POST /otp',
        timeoutSeconds: timeoutMs / 1_000,
      }),
    );

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = undefined;
        reject(new Error('Timed out waiting for the Hapoalim SMS code'));
      }, timeoutMs);
      this.pending = { resolve, reject, timeout };
    });
  }

  submit(code: string): boolean {
    if (!this.pending) {
      return false;
    }

    const { resolve, timeout } = this.pending;
    clearTimeout(timeout);
    this.pending = undefined;
    resolve(code);
    return true;
  }

  cancel(): void {
    if (!this.pending) {
      return;
    }

    const { reject, timeout } = this.pending;
    clearTimeout(timeout);
    this.pending = undefined;
    reject(new Error('OTP submission service stopped'));
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    return false;
  }

  const supplied = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BODY_BYTES) {
      throw new Error('Request body is too large');
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function parseCode(request: IncomingMessage, body: string): string | undefined {
  if (request.headers['content-type']?.startsWith('application/json')) {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || !('code' in parsed)) {
      return undefined;
    }
    return typeof parsed.code === 'string' ? parsed.code : undefined;
  }

  return new URLSearchParams(body).get('code') ?? undefined;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  coordinator: OtpCoordinator,
  token: string,
): Promise<void> {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, {
      status: 'ok',
      otpRequested: coordinator.isWaiting(),
    });
    return;
  }

  if (request.method !== 'POST' || request.url !== '/otp') {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  if (!isAuthorized(request, token)) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    const code = parseCode(request, await readBody(request));
    if (!code || !/^\d{4,8}$/.test(code)) {
      sendJson(response, 400, { error: 'Code must contain 4 to 8 digits' });
      return;
    }

    if (!coordinator.submit(code)) {
      sendJson(response, 409, { error: 'No OTP code is currently requested' });
      return;
    }

    sendJson(response, 202, { accepted: true });
  } catch {
    sendJson(response, 400, { error: 'Invalid request body' });
  }
}

export async function startOtpServer(
  coordinator: OtpCoordinator,
  token: string,
  port: number,
): Promise<Server> {
  if (token.length < 32) {
    throw new Error('OTP_SUBMISSION_TOKEN must contain at least 32 characters');
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, coordinator, token);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'otp_server_started',
      port,
    }),
  );
  return server;
}

export async function stopOtpServer(
  server: Server,
  coordinator: OtpCoordinator,
): Promise<void> {
  coordinator.cancel();
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
