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

For `localhost`, Caddy uses its local CA and the client machine must trust that
CA. For a public DNS name, ports 80 and 443 must reach this machine so Caddy can
obtain and renew the certificate.

The default proxy client ID intentionally represents this one pilot proxy, not
individual employees. Replace `ECHO_PROXY_CLIENT_ID` with a stable canonical
`cid_` digest when the ingress authenticates distinct client identities.
