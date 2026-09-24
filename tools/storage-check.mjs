#!/usr/bin/env node
/**
 * Storage check.
 *
 * Answers the only question that matters after configuring object storage:
 * can this server write a file, read it back, and delete it again — right now,
 * with the credentials in .env?
 *
 * Usage:
 *   npm run storage:check              # uses .env like the server does
 *   AI_STUDIO_STORAGE=s3 npm run storage:check
 *
 * It never prints a key or secret: only the bucket, endpoint, and the outcome.
 * Exit code is 0 when the probe succeeds, 1 when it fails, so it can gate a
 * deploy.
 */
import { config } from '../server/config.js';
import { createStorage } from '../server/storage/index.js';

const label = `AI Studio OS — storage check\n`;

console.log(label);
console.log(`  driver:   ${config.storage.driver}`);
console.log(`  redirects: ${config.storage.redirect ? 'on (reads redirect to signed URLs)' : 'off (reads stream through the API)'}`);

const storage = createStorage({ storage: config.storage, logger: { warn: () => {} } });
const described = storage.describe();
for (const driver of described.drivers) {
  const where = driver.driver === 's3'
    ? `bucket ${driver.bucket} at ${driver.endpoint} (${driver.region}, ${driver.addressing}${driver.prefix ? `, prefix ${driver.prefix}` : ''})`
    : driver.directory;
  const active = driver.driver === described.driver ? '← active' : '';
  console.log(`  ${driver.driver.padEnd(6)} ${where} ${active}`);
}

const started = Date.now();
try {
  const result = await storage.check();
  console.log(`\n  ✓ ${config.storage.driver} storage is working — wrote, read back, and deleted a probe object (${result.bytes} bytes, ${Date.now() - started}ms).\n`);
  process.exit(0);
} catch (error) {
  console.error(`\n  ✗ Storage check failed: ${error.message}`);
  if (error.hint) console.error(`    ${error.hint}`);
  console.error(`    (${Date.now() - started}ms)\n`);
  process.exit(1);
}
