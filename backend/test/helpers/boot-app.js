/*************************************************
 * The child-process side of app-process.js: runs
 * app.js the way the server does, with two
 * differences a test needs.
 *
 * Lives under helpers/ so mocha, which loads every
 * .js file directly inside test/, never runs it as
 * a spec in its own process.
 ************************************************/
const http = require('http');
const path = require('path');

const BACKEND = path.join(__dirname, '..', '..');

// V8 writes coverage on a normal exit, which a signal skips. Without this, a test run
// that stops the server with SIGTERM would leave app.js reading as untested.
process.on('SIGTERM', () => process.exit(0));
// Do not outlive the test run that started us.
process.on('disconnect', () => process.exit(0));

// Checking for a newer yt-dlp is the one thing startup does over the network.
require(path.join(BACKEND, 'youtube-dl')).checkForYoutubeDLUpdate = async () => {};

// app.js keeps its server to itself, so catch it as it is created and report the port
// the OS assigned. It is created last, so the message also means startup has finished.
const createServer = http.createServer;
http.createServer = function (...args) {
    http.createServer = createServer;
    const server = createServer.apply(this, args);
    server.once('listening', () => process.send({port: server.address().port}));
    return server;
};

require(path.join(BACKEND, 'app.js'));
