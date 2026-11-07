import { describe, expect, it } from 'vitest';

import { OtpCoordinator, startOtpServer, stopOtpServer } from './otp.js';

describe('OtpCoordinator', () => {
  it('delivers a submitted code to the active request', async () => {
    const coordinator = new OtpCoordinator();
    const code = coordinator.waitForCode();

    expect(coordinator.isWaiting()).toBe(true);
    expect(coordinator.submit('123456')).toBe(true);
    await expect(code).resolves.toBe('123456');
    expect(coordinator.isWaiting()).toBe(false);
  });

  it('rejects a code when there is no active request', () => {
    const coordinator = new OtpCoordinator();

    expect(coordinator.submit('123456')).toBe(false);
  });

  it('times out and permits a later request', async () => {
    const coordinator = new OtpCoordinator();

    await expect(coordinator.waitForCode(1)).rejects.toThrow(
      'Timed out waiting for the Hapoalim SMS code',
    );
    expect(coordinator.isWaiting()).toBe(false);

    const laterCode = coordinator.waitForCode();
    coordinator.submit('654321');
    await expect(laterCode).resolves.toBe('654321');
  });
});

describe('OTP submission server', () => {
  it('accepts an authenticated code for the active request', async () => {
    const coordinator = new OtpCoordinator();
    const token = 'a'.repeat(32);
    const server = await startOtpServer(coordinator, token, 0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('OTP server did not bind to a TCP port');
    }

    const pendingCode = coordinator.waitForCode();
    const response = await fetch(`http://127.0.0.1:${address.port}/otp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'code=123456',
    });

    expect(response.status).toBe(202);
    await expect(pendingCode).resolves.toBe('123456');
    await stopOtpServer(server, coordinator);
  });
});
