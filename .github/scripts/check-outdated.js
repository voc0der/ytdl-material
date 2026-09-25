// Reads `npm outdated --json` output from outdated.json in the working directory and exits 1
// when a package is behind what its declared range wants.
//
// Renovate holds every release back for 3 days (minimumReleaseAge in .github/renovate.json5),
// so a version younger than that is not drift yet: flagging it would turn main red for the
// days Renovate is deliberately waiting.
const { execFileSync } = require('child_process');
const fs = require('fs');

const MINIMUM_RELEASE_AGE_DAYS = 3;
const MINIMUM_RELEASE_AGE_MS = MINIMUM_RELEASE_AGE_DAYS * 24 * 60 * 60 * 1000;

function npmView(spec, field) {
  const raw = execFileSync('npm', ['view', spec, field, '--json'], { encoding: 'utf8' }).trim();
  // Depending on the npm version and how many versions match, this is a value or an array.
  return raw ? [].concat(JSON.parse(raw)) : [];
}

// The releases after the installed one, up to the wanted one, that have been out long enough.
function releasesPastMinimumAge(name, current, wanted) {
  const versions = npmView(`${name}@>${current} <=${wanted}`, 'version');
  const [published] = npmView(name, 'time');
  return versions.filter((version) => Date.now() - Date.parse(published[version]) >= MINIMUM_RELEASE_AGE_MS);
}

const raw = fs.readFileSync('outdated.json', 'utf8').trim();
const packages = raw ? JSON.parse(raw) : {};
let behind = 0;

for (const [name, details] of Object.entries(packages)) {
  if (details.current === details.wanted) {
    continue;
  }

  // A missing install, or a lookup that fails, is reported rather than waved through.
  let held = false;
  if (details.current) {
    try {
      held = releasesPastMinimumAge(name, details.current, details.wanted).length === 0;
    } catch (error) {
      console.log(`${name}: could not check release ages (${error.message.split('\n')[0]})`);
    }
  }

  if (held) {
    console.log(`${name}: wanted ${details.wanted} is under ${MINIMUM_RELEASE_AGE_DAYS} days old, not flagged yet`);
    continue;
  }

  console.log(`${name}: current ${details.current}, wanted ${details.wanted}, latest ${details.latest}`);
  behind++;
}

process.exit(behind === 0 ? 0 : 1);
