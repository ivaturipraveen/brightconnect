/**
 * Wipe the operating history before a demo.
 *
 * Run with `npm run clear`. Deletes every mission and everything that hangs off
 * one - agent runs, the event trail, approvals, artifacts, inbound events - plus
 * the documents, uploads and workspaces on disk. Leaves the simulated
 * environment and the saved settings alone, so the incident demo still has
 * something to find and the platform keeps the model it was set to.
 *
 * The dashboard and the EC2 box share one database, so this clears both.
 */
import { initDatabase } from '../dashboard/server/db/index.ts';
import { clearHistory, markOpenIntakeAsSeen } from '../dashboard/server/seed.ts';

const driver = await initDatabase();
console.log(`\n  Clearing history from ${driver.describe()}\n`);

const counts = await clearHistory();
for (const [what, n] of Object.entries(counts)) {
  console.log(`    ${String(n).padStart(5)}  ${what}`);
}

const marked = await markOpenIntakeAsSeen();
if (marked > 0) {
  console.log(`\n  Marked ${marked} already-open ticket${marked === 1 ? '' : 's'} as handled, so the`);
  console.log('  poller does not restart work the fleet has already done.');
}

console.log('\n  Done. The simulated alerts and your model setting are untouched.\n');
await driver.close();
