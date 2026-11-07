import process from 'node:process';

import cron from 'node-cron';

import { loadConfig } from './config.js';
import { runImport } from './importer.js';
import { OtpCoordinator, startOtpServer, stopOtpServer } from './otp.js';

const config = loadConfig();
const otpCoordinator = new OtpCoordinator();
const otpSubmissionToken = process.env.OTP_SUBMISSION_TOKEN;
let isRunning = false;

async function retrieveOtpCode(): Promise<string> {
  if (!otpSubmissionToken) {
    throw new Error(
      'Hapoalim requested SMS approval, but OTP_SUBMISSION_TOKEN is not configured',
    );
  }
  return otpCoordinator.waitForCode();
}

async function safeRun(): Promise<void> {
  if (isRunning) {
    console.warn(
      'Skipping importer run because the previous run is still active',
    );
    return;
  }

  isRunning = true;
  try {
    await runImport(config, retrieveOtpCode);
  } catch (error) {
    console.error('Israeli bank import failed', error);
  } finally {
    isRunning = false;
  }
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be a valid TCP port');
  }
  const otpServer = otpSubmissionToken
    ? await startOtpServer(otpCoordinator, otpSubmissionToken, port)
    : undefined;

  await safeRun();

  if (config.schedule) {
    if (!cron.validate(config.schedule)) {
      throw new Error(`Invalid SCHEDULE: ${config.schedule}`);
    }
    cron.schedule(config.schedule, safeRun, {
      timezone: config.timezone,
      noOverlap: true,
    });
    console.log(
      `Israeli bank importer scheduled with "${config.schedule}" in ${config.timezone}`,
    );
  } else {
    if (otpServer) {
      await stopOtpServer(otpServer, otpCoordinator);
    }
    process.exitCode = 0;
  }
}

void main();
