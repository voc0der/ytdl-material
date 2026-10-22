/*************************************************
 * Runs the fuzz tests' fast-check properties.
 *
 * With the regular tests, each property checks its
 * recorded examples and then a fixed set of
 * generated inputs: the seed never changes, so a
 * pull request can't fail on an input that an
 * earlier run happened not to draw. Under
 * dev/fuzz/run.sh, FUZZTIME (a duration such as 10s
 * or 2m) runs each property for that long instead,
 * from a fresh seed.
 *
 * A failure reports the smallest input fast-check
 * could shrink it to, with the seed and path that
 * replay it: FUZZ_SEED=<seed> FUZZ_PATH=<path>. Add
 * the input to the property's examples with the
 * fix, and it runs with the regular tests from then
 * on. When FUZZ_FAILURES names a directory, each
 * report is also written there, for CI to keep.
 ************************************************/
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');

const REGULAR_SEED = 20261022;
const REGULAR_RUNS = 200;

function parseDuration(text) {
    const match = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/.exec(String(text).trim());
    if (!match || !match.slice(1).some(Boolean)) {
        throw new Error(`FUZZTIME must be a duration such as 30s or 2m, not ${JSON.stringify(text)}`);
    }
    const [, hours, minutes, seconds, milliseconds] = match.map(part => Number(part || 0));
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

const fuzz_time = process.env.FUZZTIME ? parseDuration(process.env.FUZZTIME) : null;

exports.fuzzing = fuzz_time !== null;

// For a describe block: generous for the regular runs, unlimited while fuzzing.
exports.timeout = () => (exports.fuzzing ? 0 : 60000);

// Silences the backend's logger for a describe block. The checks log each input they
// refuse, which while fuzzing is thousands of lines a second.
exports.quietLogger = () => {
    const logger = require('../../logger');
    let was_silent;
    before(function() {
        was_silent = logger.silent;
        logger.silent = true;
    });
    after(function() {
        logger.silent = was_silent;
    });
};

function parameters(examples) {
    const params = {examples: examples};
    if (exports.fuzzing) {
        params.numRuns = Number.MAX_SAFE_INTEGER;
        params.interruptAfterTimeLimit = fuzz_time;
        params.markInterruptAsFailure = false;
    } else {
        params.numRuns = REGULAR_RUNS;
        params.seed = REGULAR_SEED;
    }
    if (process.env.FUZZ_SEED) {
        params.seed = Number(process.env.FUZZ_SEED);
        if (process.env.FUZZ_PATH) params.path = process.env.FUZZ_PATH;
    }
    return params;
}

function record(test, error) {
    const directory = process.env.FUZZ_FAILURES;
    if (!directory) return;
    fs.mkdirSync(directory, {recursive: true});
    const name = test.fullTitle().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
    fs.writeFileSync(path.join(directory, `${name}.txt`), `${test.fullTitle()}\n\n${error.message}\n`);
}

/*************************************************
 * Checks a property inside a mocha test:
 *
 *   it('...', async function() {
 *       await check(this, fc.property(...), [examples]);
 *   });
 *
 * Works for fc.property and fc.asyncProperty alike.
 ************************************************/
exports.check = async (context, property, examples = []) => {
    try {
        await fc.assert(property, parameters(examples));
    } catch (error) {
        record(context.test, error);
        throw error;
    }
};
