# Deploying the tunnel config

`config.yml` here is the source. The running copy lives at
`C:\Windows\System32\config\systemprofile\.cloudflared\config.yml`, because the
`cloudflared` service runs as LOCAL SYSTEM and its `ImagePath` names that path.
Editing the copy in `%USERPROFILE%\.cloudflared\` changes nothing — that one is
left over from `cloudflared tunnel login` and the service never reads it.

## Deploy

From an **elevated** PowerShell, in the repo root:

```powershell
Copy-Item deploy\cloudflared\config.yml `
  'C:\Windows\System32\config\systemprofile\.cloudflared\config.yml' -Force
cloudflared tunnel ingress validate
Restart-Service cloudflared
```

`ingress validate` reads the file the service will read and refuses a config with
no terminating catch-all, so run it before the restart rather than after.

## Order matters with the loopback bind

`config.yml` names `http://127.0.0.1:8787`. The API binds loopback only
(`HOST` in `server/src/index.js`, default `127.0.0.1`). On Windows `localhost`
resolves to `::1` before `127.0.0.1`, so the old `http://localhost:8787` ingress
and a loopback-bound origin do not agree.

**Deploy this config before or in the same window as the server change.** The
other order gives a window where cloudflared dials a name nothing answers on.

## Verifying

```powershell
# the origin is loopback-only — expect 127.0.0.1, never 0.0.0.0 or ::
Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 8787

# the site is up through the tunnel
(Invoke-WebRequest https://www.footyboard.me/ -UseBasicParsing).StatusCode

# staging rejects an unauthenticated caller, once Access is enabled below
curl.exe -s -o NUL -w "%{http_code}`n" `
  -H "Cf-Access-Jwt-Assertion: not-a-token" https://tunnel.footyboard.me/
```

The last one must print `403`. If it prints `200`, the connector is not
enforcing and only the edge is — which means anything that reaches the origin by
another route is unauthenticated.

## Enabling Access on the staging hostname

The `access:` block in `config.yml` is commented because `required: true` with a
placeholder `audTag` rejects every request to that hostname. Fill it in only
after the application exists:

1. Zero Trust → Access → Applications → Add an application → Self-hosted.
2. Subdomain `tunnel`, domain `footyboard.me`.
3. Policy: action **Allow**, Include → **Emails** → your address. Do not add a
   **Bypass** policy — Bypass wins over Allow and logs nothing.
4. Copy the **Application Audience (AUD) Tag** from the application's overview.
5. Team name is at Zero Trust → Settings (`<team-name>.cloudflareaccess.com`).
6. Uncomment the block in `config.yml`, fill both in, and deploy as above.

Enabling `access` makes the connector call out to
`<team-name>.cloudflareaccess.com` on 443 to fetch signing keys, in addition to
the 7844 it already uses. If egress is filtered by port, that host needs to be
reachable or the connector will fail every request to the protected hostname.

## What is deliberately not here

- **`cert.pem`.** It is account-wide, lasts about ten years, and grants
  create/delete/DNS across every tunnel on the account. `tunnel run` does not
  need it — only `tunnel create` / `delete` / `route dns` do. Keep it in a
  password manager, restore it when you need to manage tunnels, delete it again.
- **The credentials JSON.** It is a secret and belongs on the host only.
- **`noTLSVerify` / `originServerName`.** There is no TLS on the origin hop to
  not-verify; the tunnel encrypts it. Setting either would be cargo cult.
- **`warp-routing`.** Off. Turning it on and routing a CIDR publishes the LAN.
