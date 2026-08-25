# Phase 2 Golden Standard Runtime Inspection

**Inspection type:** local source, read-only  
**Authorization:** Gate P0  
**External resources modified:** none

## Determination

The current Golden Standard is **A — browser-direct**:

```text
Customer browser → Google Places API
```

It is not server-proxied through a Lead Finder API route.

## Redacted source evidence

| Source | Evidence |
|---|---|
| repository root `index.html:307` | `API_URL` targets `https://places.googleapis.com/v1/places:searchText` |
| repository root `index.html:308` | a browser-visible embedded key variable exists; value deliberately omitted from this record |
| repository root `index.html:636` | browser `fetch(API_URL, ...)` sends `X-Goog-Api-Key` and the Places field mask directly |
| repository root `api/usage.js` | server-side Google access is for Monitoring telemetry only; it does not proxy Places search |

## Approved credential model resulting from the inspection

For the current browser-direct runtime:

- A customer Places API key may be visible in that customer's browser runtime.
- It must be dedicated per customer/project and restricted to the exact customer origin, for example `https://test.leadfinder.business/*` for the sandbox.
- It must be API-restricted to only the required Places API.
- The raw key must not enter Control Dashboard forms, shared Supabase tables, audit logs, screenshots, or review artifacts.
- The Control Dashboard stores only project metadata, exact restriction, a masked fingerprint and verification status.
- Shared Monitoring Access remains the default monitoring mode. A dedicated monitoring credential is optional and privileged/server-side only.

## What this inspection does not prove

Local source proves the runtime request path, but it cannot prove the current Google Console key restrictions, billing link, API enablement or propagation state. Those require tenant-scoped authenticated provider verification behind the applicable unapproved gates. No such verification or mutation was performed under P0.

## Production protection

No source, key, ENV, project, restriction, domain or deployment belonging to `leadfinder.business`, `hma.leadfinder.business`, `login.leadfinder.business`, or any customer was modified during this inspection.
