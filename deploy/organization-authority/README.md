# Single-origin authority deployment

This is the pilot deployment for one organization. One public HTTPS origin
serves employee enrollment/access routes and the `/admin` console. Caddy strips
external proxy-identity headers, authenticates its loopback hop, and supplies
the bounded client identity expected by the authority.

Set a public DNS name and initialize the persistent state once:

```sh
cd deploy/organization-authority
export ECHO_AUTHORITY_HOST=authority.example.com
export ECHO_AUTHORITY_UID="$(id -u)"
export ECHO_AUTHORITY_GID="$(id -g)"
install -d -m 0700 data
docker compose build authority
docker compose run --rm authority \
  init-development \
  --config /echo/authority.json \
  --state-dir /echo/state \
  --organization-name "Example Company"
docker compose up -d
```

Open `https://$ECHO_AUTHORITY_HOST/admin`. The generated administrator token is
`data/state/credentials/admin-token`; treat the whole `data` directory as
private state and back it up accordingly. The path is excluded from Git and
from the Docker build context.

The authority runs with the host UID/GID supplied above instead of root. Caddy
is the trusted TLS proxy that injects the bounded authenticated client headers.
Of the authority's private state, Caddy's filesystem mounts expose only the
trusted-proxy token, not the administrator token, database, or authority
signing key. The private runtime-status route is not forwarded by the public
proxy.

Check a running authority from inside its existing container:

```sh
docker compose exec --no-tty authority \
  node services/organization-authority/dist/main.js \
  status --config /echo/authority.json
```

Use `docker compose run` only for the one-time initialization while the stack
is stopped. `run` creates another container; it is not the live authority.
The authority's singleton guard is a private authenticated Unix socket in the
shared `authority_runtime` Docker volume, so any second container using this
compose service must prove the existing owner and is refused while it remains
active. Durable keys and database state remain in the host-mounted `data`
directory; the coordination volume contains no organization content and may be
recreated only while the whole authority stack is stopped.

The volume has the deployment-stable Docker name
`echo-organization-authority-runtime`, so changing Compose project names does
not create a second coordination island. If one Docker host runs more than one
organization authority, set a different, durable
`ECHO_AUTHORITY_RUNTIME_VOLUME` value for each organization and never change it
while that authority state is in use.

Because this portable compose file deliberately puts Caddy in the authority
container's network namespace, restart the stack as one unit:

```sh
docker compose restart
```

Restarting only `authority` replaces that namespace and strands the existing
proxy process until `proxy` is also restarted.

For `localhost`, Caddy uses its local CA. Export its public root after the stack
starts, then supply it during product enrollment:

```sh
docker compose exec --no-tty proxy \
  cat /data/caddy/pki/authorities/local/root.crt \
  > data/caddy-local-root.crt
chmod 0600 data/caddy-local-root.crt

echo-brain organization enroll \
  --config /absolute/path/runtime.json \
  --invitation /absolute/path/echo-organization-invitation.json \
  --authority-pin sha256:PIN_FROM_A_SEPARATE_TRUSTED_CHANNEL \
  --authority-ca /absolute/path/to/data/caddy-local-root.crt \
  --allow-exportable-software-key
```

The product persists this public CA with the verified authority connection so
background lease renewal uses the same TLS trust after restart. For a public
DNS name, ports 80 and 443 must reach this machine so Caddy can obtain and
renew the certificate; `--authority-ca` is then normally unnecessary.

The default proxy client ID intentionally represents this one pilot proxy, not
individual employees. Replace `ECHO_PROXY_CLIENT_ID` with a stable canonical
`cid_` digest when the ingress authenticates distinct client identities.
