const { assert, youtubedl_api } = require('./test-shared');
const { spawn } = require('child_process');
const fs = require('fs-extra');

// Regression coverage for #395: killYoutubeDLProcess must not resolve until the child is
// actually dead and reaped. tree-kill on Linux shells out to `ps` to walk the process tree
// before it delivers a single signal, so a killYoutubeDLProcess that only calls kill() and
// returns hands control back to its caller before the child has even been signalled.

// State char out of /proc/<pid>/stat. 'Z' is the zombie condition from the issue: exited,
// but nobody has called waitpid() on it yet.
function getProcessState(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // Fields after comm are positional, but comm itself is '(name)' and may contain
        // spaces, so anchor on the last ')' rather than splitting the whole line.
        return stat.charAt(stat.lastIndexOf(')') + 2);
    } catch {
        // No /proc entry at all means the process is fully gone, which is the good case.
        return 'gone';
    }
}

const proc_available = fs.existsSync('/proc/self/stat');

function spawnLongLivedChild() {
    return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: ['ignore', 'pipe', 'pipe']});
}

function spawnImmediatelyExitingChild() {
    return spawn(process.execPath, ['-e', ''], {stdio: ['ignore', 'pipe', 'pipe']});
}

function onceClose(child_process) {
    return new Promise(resolve => child_process.once('close', resolve));
}

// Resolves to false if the promise is still pending after the timeout, so a
// killYoutubeDLProcess that never settles fails as an assertion instead of as a mocha timeout.
function settledWithin(promise, timeout_ms) {
    let timeout_handle = null;
    const timed_out = new Promise(resolve => {
        timeout_handle = setTimeout(() => resolve(false), timeout_ms);
    });
    return Promise.race([promise.then(() => true), timed_out]).finally(() => clearTimeout(timeout_handle));
}

describe('killYoutubeDLProcess', function() {
    const spawned_children = [];

    function track(child_process) {
        spawned_children.push(child_process);
        return child_process;
    }

    afterEach(function() {
        // Nothing here should outlive its test, but a failed assertion can leave a child behind.
        while (spawned_children.length) {
            const child_process = spawned_children.pop();
            if (child_process.exitCode === null && child_process.signalCode === null) {
                try { child_process.kill('SIGKILL'); } catch { /* already gone */ }
            }
        }
    });

    it('Does not resolve until the child has actually exited and been reaped', async function() {
        this.timeout(15000);

        const child_process = track(spawnLongLivedChild());
        await new Promise(resolve => child_process.once('spawn', resolve));
        assert.strictEqual(child_process.exitCode, null, 'child should still be running before the kill');

        await youtubedl_api.killYoutubeDLProcess(child_process);

        // Node only fills these in once libuv has reaped the child, so a non-null value here
        // is proof that the wait happened rather than that the signal was merely queued.
        assert(child_process.exitCode !== null || child_process.signalCode !== null,
            `killYoutubeDLProcess returned while pid ${child_process.pid} was still unreaped `
            + `(exitCode=${child_process.exitCode}, signalCode=${child_process.signalCode})`);

        if (proc_available) {
            const state = getProcessState(child_process.pid);
            assert.notStrictEqual(state, 'Z', `pid ${child_process.pid} was left as a zombie`);
        }
    });

    it('Resolves when the child has already exited before the kill', async function() {
        this.timeout(15000);

        const child_process = track(spawnImmediatelyExitingChild());
        await onceClose(child_process);

        // A cancel that races a subscription check finishing on its own lands here. Waiting on
        // a 'close' that has already fired would never resolve, which would strand every caller
        // that awaits this.
        const resolved = await settledWithin(youtubedl_api.killYoutubeDLProcess(child_process), 3000);
        assert(resolved, 'killYoutubeDLProcess never resolved for a child that had already exited');
    });

    it('Resolves without throwing when the record has no usable pid', async function() {
        this.timeout(15000);

        // A cancel can land between spawn() and the ENOENT that a missing binary reports, and
        // pid is undefined in that window. tree-kill throws on a NaN pid.
        const resolved = await settledWithin(youtubedl_api.killYoutubeDLProcess({pid: undefined}), 3000);
        assert(resolved, 'killYoutubeDLProcess did not settle for a record with no pid');
    });

    it('Gives up after the timeout rather than waiting on a child that never closes', async function() {
        this.timeout(15000);

        const child_process = track(spawnLongLivedChild());
        await new Promise(resolve => child_process.once('spawn', resolve));

        // Stands in for a child stuck in uninterruptible I/O: signalled, but its 'close' never
        // arrives. Without a bounded wait an awaiting cancel request would never return.
        const stuck_handle = {pid: child_process.pid, exitCode: null, signalCode: null, once: () => {}};

        const started_at = Date.now();
        const resolved = await settledWithin(youtubedl_api.killYoutubeDLProcess(stuck_handle, 500), 5000);
        assert(resolved, 'killYoutubeDLProcess never gave up on a child that would not close');
        assert(Date.now() - started_at >= 500, 'killYoutubeDLProcess returned before the timeout elapsed');
    });

    it('Kills a child that is only referenced by a serialized {pid} record', async function() {
        this.timeout(15000);

        const child_process = track(spawnLongLivedChild());
        await new Promise(resolve => child_process.once('spawn', resolve));

        // Subscriptions persist child_process onto the record, so on a remote db it comes back
        // as a plain object rather than a live ChildProcess.
        const resolved = await settledWithin(youtubedl_api.killYoutubeDLProcess({pid: child_process.pid}), 3000);
        assert(resolved, 'killYoutubeDLProcess never resolved for a serialized child_process record');

        const died = await settledWithin(onceClose(child_process), 5000);
        assert(died, `pid ${child_process.pid} was not killed`);
    });
});
