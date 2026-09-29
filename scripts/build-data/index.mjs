// Build-time data pipeline entry point. Each dataset runs in isolation: a
// failing upstream never blocks the others, and a failed step leaves the last
// committed file in place so the map keeps serving the previous good data.
//
//   node scripts/build-data/index.mjs            # every step
//   node scripts/build-data/index.mjs acs crime  # selected steps

import { step, writeJSON, readJSON, log } from './lib.mjs';
import { buildACS } from './acs.mjs';
import { buildAmenities } from './amenities.mjs';
import { buildTransit } from './transit.mjs';
import { buildCrime } from './crime.mjs';
import { buildBoundaries } from './boundaries.mjs';

const OUT = new URL('../../data', import.meta.url).pathname;

const STEPS = {
  acs: () => buildACS(OUT),
  boundaries: () => buildBoundaries(OUT),
  amenities: () => buildAmenities(OUT),
  transit: () => buildTransit(OUT),
  crime: () => buildCrime(OUT) // after acs: places sheriffs on the county points it writes
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(STEPS);
const previous = await readJSON(`${OUT}/manifest.json`, { steps: {} });
const manifest = { built: new Date().toISOString(), steps: { ...previous.steps } };

for (const name of wanted) {
  if (!STEPS[name]) { log(`unknown step ${name}`); continue; }
  await step(name, STEPS[name], manifest);
}
await writeJSON(`${OUT}/manifest.json`, manifest);

const failed = wanted.filter(n => manifest.steps[n] && !manifest.steps[n].ok);
log(failed.length ? `finished with failures: ${failed.join(', ')}` : 'all steps succeeded');
// Failures are reported but do not fail the job: partial fresh data is still
// worth committing, and the manifest records exactly what failed.
