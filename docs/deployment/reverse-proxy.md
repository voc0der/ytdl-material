# Reverse proxy and HTTPS

Serve the app at a dedicated hostname such as `https://media.example.com`. The frontend, `/api/` endpoints, authentication callbacks, and media streaming must all reach the same backend.

## Nginx example

Inside an existing TLS-enabled `server` block, proxy to the app. This example assumes Nginx runs on the Docker host and the app publishes its port on loopback:

```nginx
location / {
    proxy_pass http://127.0.0.1:17442;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
}
```

If Nginx runs in a container on the app's network, use `http://ytdl-material:17442` instead. Keep the proxy's upload-size limit large enough for the files you intend to upload. Media seeking uses HTTP Range requests; preserve those requests and the backend's partial-content responses. See the [Nginx proxy module reference](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) when adapting the example.

## Trust and access restrictions

`ytdl_reverse_proxy_whitelist` is a comma-separated list of **proxy IPs or CIDR ranges allowed to connect directly**. It also supplies trusted proxies unless `ytdl_trust_proxy` overrides that behavior. Do not fill it with client subnets when your intended peer is a proxy.

```yaml
environment:
  ytdl_reverse_proxy_whitelist: '172.28.0.10/32'
```

Use the actual address your app sees. Docker gateways and proxy container addresses can differ from host LAN addresses. An incorrect whitelist can reject every request, including local health checks or direct LAN access.

`ytdl_trust_proxy` supports a boolean, hop count, address, or comma-separated list. Trust only the proxies in your deployment; rate limiting uses the resulting client IP.

## Public URLs and OIDC

Set the app's URL to the address people use, and set the OIDC callback explicitly to:

```text
https://media.example.com/api/auth/oidc/callback
```

There is a current limitation: some generated RSS and notification links concatenate the configured host URL and backend port. If your external HTTPS port differs from the backend's port, inspect the generated link and replace its origin with the public origin when needed. Setting the host URL alone does not consistently solve this, and changing the backend port solely to fix a link also changes where the server listens.

Test sign-in, playback, seeking, downloads, and a shared link after installing the proxy. See [authentication](authentication.md) for identity-provider settings.

## Direct HTTPS and subpaths

For direct TLS, mount a certificate and private key, set `ytdl_ssl_cert_path` and `ytdl_ssl_key_path`, and restart. Both paths must be readable inside the app container.

Prefer a dedicated hostname over a path such as `/media/`. The app uses root-level API and callback paths, and historical wiki subpath snippets do not establish complete support for the current frontend and integrations.
