/*************************************************
 * GET /healthz: says the server is up and nothing
 * else. It is registered ahead of every middleware
 * in app.js, so it reads no body, no session and no
 * database, and the reverse proxy whitelist does not
 * turn away a check from inside the container. It
 * answers only once startup has finished, since the
 * server does not listen before then.
 ************************************************/
exports.handler = (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('text/plain').send('ok');
};
