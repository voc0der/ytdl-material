const assert = require('assert');
const { EventEmitter } = require('events');
const { createAppHarness } = require('./app-harness');

// Capture the handlers registered by the complete app. These tests control external
// failures at the handler boundary; app-process.js tests cover real middleware/auth.
function createRouteHarness(options = {}) {
    const routes = new Map();
    const app = { disable() {}, use() {}, set() {} };
    for (const method of ['get', 'post', 'put', 'delete', 'patch', 'options']) {
        app[method] = (route, ...handlers) => routes.set(`${method} ${route}`, handlers.at(-1));
    }
    const express = Object.assign(() => app, { json() {}, urlencoded() {}, static() {} });
    const harness = createAppHarness({ ...options, dependencies: { ...options.dependencies, express } });
    return {
        ...harness,
        async request(method, route, { body = {}, query = {}, user = null, ...fields } = {}, response = {}) {
            const handler = routes.get(`${method} ${route}`);
            assert(handler, `Missing route: ${method} ${route}`);
            const req = Object.assign(new EventEmitter(), {
                body, query, user, params: {}, headers: {}, isAuthenticated: () => !!user, ...fields
            });
            const res = Object.assign(new EventEmitter(), {
                statusCode: 200, headers: {},
                status(code) { this.statusCode = code; return this; },
                type(value) { this.headers['Content-Type'] = value; return this; },
                set(name, value) { this.headers[name] = value; return this; },
                setHeader(name, value) { this.headers[name] = value; },
                send(data) { this.body = data; return this; },
                sendStatus(code) { this.statusCode = code; return this; },
                redirect(url) { this.statusCode = 302; this.location = url; },
                ...response
            });
            await handler(req, res);
            return { req, res };
        }
    };
}

module.exports = { createRouteHarness };
