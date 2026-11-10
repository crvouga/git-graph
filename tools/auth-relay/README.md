# Auth relay registration

Lanes signs people in through the shared auth relay (Google, OpenID Connect, public PKCE client).
Each deployment is a **registered client** of the relay. The registration files here are public;
the registration credential is not, and never reaches the app.

| File | Relay | Credential (Vault) | Lease |
| --- | --- | --- | --- |
| `registration.production.json` | `https://auth.chrisvouga.dev` | `secret/auth-relay-agents/lanes-prd/prd` | up to 366 days |
| `registration.localhost.json` | `https://auth-dev.chrisvouga.dev` | `secret/auth-relay-agents/lanes-dev/dev` | up to 7 days |

The credentials are created by `crvouga/personal` (OpenTofu) and approved by a relay operator
(the `[hosting] lanes` request covers it). Then:

```sh
pnpm relay:fingerprint:production     # public SHA-256, for the operator's approval
pnpm relay:register:production        # prints OIDC_ISSUER / OIDC_CLIENT_ID (public settings)
pnpm relay:register:local             # same for http://localhost:8787 (re-run weekly)
```

Registering again renews the lease and keeps the client id. Put the printed `OIDC_ISSUER` and
`OIDC_CLIENT_ID` in the service's plain env (production) or your shell (local). `agent.ts` is
vendored from `crvouga/personal` at a reviewed commit; update it deliberately.
