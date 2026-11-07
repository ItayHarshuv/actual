import process from 'node:process';

import cron from 'node-cron';

import { loadConfig } from './config.js';
import { runImport } from './importer.js';

const config = loadConfig();
let isRunning = false;

async function safeRun(): Promise<void> {
  if (isRunning) {
    console.warn(
      'Skipping importer run because the previous run is still active',
    );
    return;
  }

  isRunning = true;
  try {
    await runImport(config);
  } catch (error) {
    console.error('Israeli bank import failed', error);
  } finally {
    isRunning = false;
  }
}

async function main(): Promise<void> {
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
    process.exitCode = 0;
  }
}

void main();
