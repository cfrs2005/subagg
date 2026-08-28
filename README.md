<div align="center">

# subagg

**Self-hosted proxy subscription aggregator, with optional relay orchestration.**

One link that adapts to whatever client asks for it — and, if you want, dials a
nearby relay entry instead of your provider's landing server.

[中文文档](./README.zh-CN.md) · [Security](./SECURITY.md) · [Contributing](./CONTRIBUTING.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen.svg)](https://nodejs.org)

</div>

---

## What it does

You have several proxy subscriptions. Each gives you a link. Each link works with
some clients and not others. Your laptop runs Clash, your phone runs Shadowrocket,
and the friend you share nodes with runs something else entirely.

subagg merges them into **one link**:

```
several upstream subscriptions
        │
        ▼  fetch, parse into one node model
   filter rules  (region / protocol / regex / manual picks / dedupe / rename)
        │
        ▼  optional: swap the dial-out address for a relay entry (IX)
   https://your-host/sub/<token>
        │
        ├─ Clash asks       → YAML with proxy groups and rules
        ├─ Shadowrocket asks → base64 URI list
        └─ v2rayN asks       → base64 URI list
```

The format is chosen from the client's `User-Agent`. Add `?target=clash.meta`
to force one.

That optional step in the middle is the second half of the product: subagg can
also drive a layer-4 port-forwarding platform, so the link it hands out points
at a nearby relay entry rather than at your provider directly. See
[IX relay orchestration](#ix-relay-orchestration).

## Features

- **Multi-source aggregation** — Clash YAML and base64 URI-list subscriptions,
  auto-detected. Protocols: VMess, VLESS (incl. REALITY), Trojan, Shadowsocks,
  ShadowsocksR, Hysteria2, TUIC.
- **One link, many clients** — Clash / Clash.Meta (mihomo) / Shadowrocket / v2rayN,
  picked automatically by User-Agent.
- **Filter rules decoupled from output format** — the same rule set produces every
  format. Filter by region, protocol, source, regex include/exclude, or hand-pick
  nodes in the UI. Plus dedupe, rename templates, sorting and limits.
- **Nothing is dropped silently** — nodes your client can't support (VLESS on stock
  Clash, for example) are reported in the response headers and the UI, with the reason.
- **Traffic monitoring** — parses `Subscription-Userinfo` from each upstream, keeps
  history, and re-emits an aggregated header so your client shows a usage bar.
- **Sharing** — issue a separate, individually revocable token per friend, and see
  the real access log (when, which client, how many distinct sources).
- **Local QR codes** — generate a scannable code for a subscription link or a single
  node URI. The encoder is a self-contained pure function: **everything is computed
  locally with zero outbound requests** — that link is equivalent to credentials for
  every node, so it is never handed to a third-party QR service.
- **IX relay orchestration** *(optional, off by default)* — have subagg create the
  forwarding ports on a layer-4 relay platform and serve the relay entry address
  instead of the landing server. **Only `server` and `port` are rewritten**; UUID,
  password, TLS, SNI, Host, path and every other protocol parameter stay byte for
  byte identical. Original and `IX_` relay nodes coexist; unusable relays remain
  visible with a readable state but are never disguised as direct nodes.

## Screenshots

### Node management

Filter, inspect, and test every node in one compact workspace. The included
example has been redacted before publication.

![Node management workspace](./assets/screenshots/node-management.png)

### Chain proxy configuration

Choose entry and landing nodes for an optional relay route, while keeping the
normal subscription unchanged.

![Chain proxy configuration](./assets/screenshots/chain-proxy-configuration.png)

## Quick start

Requires Node.js ≥ 20.11.

```bash
git clone https://github.com/your-org/subagg.git
cd subagg
npm install

cp .env.example .env
echo "ADMIN_TOKEN=$(openssl rand -hex 32)" >> .env
echo "IP_HASH_SALT=$(openssl rand -hex 16)" >> .env

npm run build
npm start
```

Open <http://127.0.0.1:8787>. The separate local-development panel accepts
`ADMIN_TOKEN`; this fallback is rejected in production.

For production Google login, create a dedicated Google Web OAuth Client and set
`APP_ENV=production`, `PUBLIC_BASE_URL` / `WEB_APP_URL`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `SESSION_COOKIE_SECURE=true`, and
`ALLOW_DEV_LOGIN=false`. Register this exact callback:

```text
https://your-host/auth/google/callback
```

The server accepts only the verified addresses listed in `GOOGLE_ALLOWED_EMAILS`;
production takes exactly one (single-user self-hosting). Google tokens are discarded
after the login callback — the application stores only its own revocable, hashed session.

For development use `npm run dev` (watch mode via tsx).

> **Before exposing this to the internet, read [SECURITY.md](./SECURITY.md).**
> The database holds your proxy credentials. It needs HTTPS, and every admin API
> request must be protected by the Google application session.

Deployment: a [systemd unit](./scripts/subagg.service) for plain VPS installs,
and a [Dockerfile](./Dockerfile) / [compose file](./docker-compose.yml) if you
prefer containers.

## Using the subscription link

```bash
# Same URL, three clients, three formats
curl -A "ClashforWindows/0.20.39" https://your-host/sub/$TOKEN   # → YAML
curl -A "Shadowrocket/2.2.31"     https://your-host/sub/$TOKEN   # → base64
curl -A "v2rayN/6.45"             https://your-host/sub/$TOKEN   # → base64

# Force a format
curl "https://your-host/sub/$TOKEN?target=clash.meta"

# See what happened without downloading the body
curl -sI https://your-host/sub/$TOKEN
```

Response headers worth knowing:

| Header | Meaning |
|---|---|
| `Subscription-Userinfo` | Aggregated traffic; this is what draws the usage bar in your client |
| `Profile-Update-Interval` | How often the client should refetch |
| `X-Subagg-Nodes` | How many nodes went into the config |
| `X-Subagg-Target` | Which format was chosen, and why (`ua` / `query` / `default`) |
| `X-Subagg-Skipped` | How many nodes the target format can't represent |
| `X-Subagg-Warning` | Anything else you should know |

## IX relay orchestration

Optional. You create explicit IX relay nodes and then use them like ordinary nodes.

The problem it solves is **link quality**, not reachability: the hop from your
device to your provider's landing server is not something you control (it may
route the long way round, or get throttled). A layer-4 port-forwarding platform
gives you a nearby entry address and forwards the bytes on to the landing
server, so the long haul happens on a network somebody is paid to keep fast.

```
client ──▶ IX entry (nearby) ──▶ original landing server
```

Layer 4 means the relay never terminates TLS and never inspects the payload.
Each IX relay node changes **only the dial-out address** — `server` and `port`. UUID,
password, cipher, TLS, SNI, ALPN, REALITY, Host, path, gRPC service name, flow:
all remain identical to the original version. The mapping is stored once and the
relay node is projected into the node catalog as `IX_<original name>`. Its stable
fingerprint is derived from provider + original fingerprint, so entry hostname and
port changes do not invalidate profile picks or latency history.

One consequence of that is worth knowing, because it is where handshakes live or
die. `server` quietly doubles as "who do we handshake with" in four places —
`tls.sni`, `ws.headers.Host`, `h2.host` and `http.headers.Host` all fall back to
`server` when they're empty. Changing `server` therefore silently changes those
four values too, so subagg writes the **original** server into them explicitly.
That is not new behaviour; it pins down the default that was already in effect.
It is on by default (`fillOriginHost`) and you should leave it on — turning it
off makes TLS nodes present the *relay's* hostname as their SNI, which fails,
invisibly.

### Setting it up

1. **Add a provider** — the "IX 中转" tab → *添加中转商*. You need the API base
   URL (e.g. `https://<platform-host>/api`) and credentials.
2. **Test connection** — pulls the line list, per-line port quota, traffic, expiry
   and, explicitly, a list of what your account *cannot* do. **Sync status** then
   auto-discovers existing remote ports whose targets exactly match local nodes.
3. **Generate IX nodes** — node table → tick the original nodes →
   *生成 IX 节点* (50 fingerprints per batch, at most). If the platform already
   has a port pointing at the same `host:port`, subagg **claims** it rather than
   creating a duplicate — quotas are small enough that this matters.
4. **Pick the generated nodes** — `IX_...` rows appear next to the originals and
   can be selected directly in a profile. There is no profile-level IX switch.

### Authentication

Two modes, both first-class:

- **`X-API-Key` (preferred).** A long-lived key, which on these platforms is
  usually issued by an administrator. Ask for the least it can be: enough to read
  and write forwarding ports and to read your own subscription/quota — on the
  platform we integrated against that is `ports_traffic` + `subscription_link`.
  **Do not ask for `full`, `admin_system` or `agent_exec`**: subagg never needs
  them, and a key that can do everything is a key you cannot safely leave in a
  database. (These scope names come from the platform's own permission list;
  subagg itself never inspects them, it just sends the header.)
- **Account login (fallback).** Username and password are exchanged for a JWT —
  measured at **7 days**, renewed automatically (proactively 5 minutes before
  expiry, plus exactly one re-login on a `401`). This is the only option if your
  administrator won't issue a key. Note the ceiling: **if the platform ever turns
  on a login captcha, this path stops working** and there is no way around it
  except an API key.

### Limits you should know before you start

- **Port quota is per line, not per account**, and it is small — on the account
  this was built against, 30 ports per line. An aggregated node list is routinely
  much larger than that, which is why node selection is **a manual pick, not
  "relay everything"**. subagg checks the quota locally before creating anything
  and tells you which line is full.
- **Direct forwarding only, if your account says so.** Chained relays, custom
  forward endpoints and inbound proxying are account/line capabilities. Where the
  platform has them switched off, subagg only ever uses plain direct forwarding —
  and the connection test spells out which of them you don't have.
- **Some nodes are deliberately refused.** Where the address change would force
  subagg to guess a disguise parameter, it refuses creation before consuming a
  remote port: REALITY without an explicit `sni`, Shadowsocks with an obfuscation
  plugin, ShadowsocksR obfuscation that needs a host, plaintext gRPC, and
  UDP-native protocols (Hysteria2 / TUIC / QUIC) behind a port that doesn't forward
  UDP. Every one of them reports why, and what to do instead.
- **UDP is a property of the port.** If the forwarding port doesn't carry UDP, the
  node's UDP capability is honestly downgraded to `false` rather than left to
  silently black-hole UDP traffic. Where the platform hasn't reported the port's
  UDP capability yet, subagg says so in a warning instead of guessing.

### When something breaks

Rendering a subscription **makes zero outbound requests**. A control-plane sync
failure keeps the last known IX entry and marks the node stale. A suspended,
expired or otherwise unusable port stays visible as unavailable and is omitted from
subscriptions; it never turns into a direct node while keeping an `IX_` name. The
original node remains beside it for an explicit manual fallback.

Deleting an IX node deletes the remote port when it is the last local reference,
then reads the platform state back before removing the local mapping. A provider
cannot be deleted while it still has IX nodes.

### Two different latencies — do not add them up

- The latency in the **node table** is measured by subagg against the address shown
  in that row: original rows test the landing server; `IX_` rows test the IX entry.
- The latency on an **IX mapping** is measured by the relay platform: *relay entry
  → original landing server*.

They measure different segments, and their sum is not your end-to-end latency
either. subagg shows both, labelled, and derives nothing from them — same reason
there is no "estimated usage" figure anywhere.

### About credential encryption (read this before trusting it)

Provider credentials (API key, password, cached JWT) are encrypted with
AES-256-GCM before being stored, with the key derived from your `ADMIN_TOKEN`.

Be clear about what that buys you. It protects against **the database file
leaving the machine on its own**: a backup synced to cloud storage, `data/subagg.db`
committed by accident, the file handed to someone while debugging. In all of those
the ciphertext travels and `ADMIN_TOKEN` (in `.env` or a systemd `EnvironmentFile`)
does not. It does **not** protect against a compromised host — an attacker who can
read the database can usually read `.env` too. It raises the bar from "get the
file" to "get the file *and* the environment".

The cost is unavoidable and you should plan for it: **rotating `ADMIN_TOKEN`
makes already-stored credentials permanently undecryptable.** That is arithmetic,
not a bug. subagg handles it gracefully — the provider is flagged as needing
  re-entry, affected IX nodes become unavailable, nothing crashes — but you will
have to type the credentials in again.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `IX_SYNC_INTERVAL_MINUTES` | `5` | How often to reconcile local mappings and refresh projected IX node addresses. **`0` disables background sync**. Max 1440. |
| `IX_TIMEOUT_MS` | `15000` | Per-request timeout for platform API calls. It's an external service; it must not be able to stall the scheduler. Range 1000–120000. |
| `IX_ORPHAN_THRESHOLD` | `5` | How many consecutive syncs a node may be missing from every subscription before its mapping is flagged an orphan. Deliberately not `1`: upstreams return incomplete lists often enough that one miss means nothing. Orphans are **flagged only** — no remote port is ever deleted automatically. Range 1–100. |

No new required secrets: the encryption key is derived from the `ADMIN_TOKEN`
you already have.

## A note on Clash vs Clash.Meta

Stock Clash (the Dreamacro core, used by ClashX, Clash for Windows, Clash for Android)
**does not support VLESS, Hysteria2 or TUIC**. Clash.Meta / mihomo does.

subagg detects which one you're running and drops the nodes your core can't handle —
because emitting them would make the client reject the *entire* config, not just those
nodes. The count and reason come back in `X-Subagg-Skipped`. If you see nodes going
missing, that's usually why, and the fix is a Meta-based client (Clash Verge Rev, Stash,
FlClash…).

## What subagg cannot do

**It cannot measure how much traffic a friend used.** Their proxy traffic goes
straight from their device to the proxy server; it never passes through subagg.

The only thing observable here is that their client *fetched the subscription* —
so that is exactly what the UI shows: fetch count, timestamps, detected client,
and number of distinct source IPs (a genuine signal for "has this link been forwarded?").
There is deliberately no "estimated usage" figure anywhere, because any such number
would be fabricated. For real numbers, check your provider's dashboard.

## Architecture

```
src/core/       pure functions — no IO, fully unit-tested
  parse/        subscription formats → one node model
  filter.ts     the rule engine
  ix.ts         relay projection — swaps the dial-out address, nothing else
  secret.ts     AES-256-GCM sealing for stored credentials
  emit/         node model → client formats, plus the capability matrix
src/db/         SQLite persistence
src/services/   fetch, sync, schedule, render, relay orchestration
src/server/     HTTP: /sub/:token (public) and /api/* (authenticated)
public/         zero-build frontend — plain ES modules, no bundler
```

The node catalog projects `original + IX relay` nodes first. Profiles then use the
normal `filter → chain → emit` pipeline for both kinds.

The `core/` layer is deliberately IO-free. Protocol parsing and config generation
are where the bugs live, and keeping side effects out means every branch is
reachable from a unit test. The most important of those tests asserts
`parseUri(emitUri(node)) === node` for every protocol — URI dialects differ in ways
no code review will catch.

## Development

```bash
npm run lint
npm run typecheck
npm test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) — especially if you're adding an output
format or a protocol.

## Roadmap

Not in v1, but the seams are there:

- sing-box JSON output (`emit/` is structured for it; add a file, register it)
- Surge / Quantumult X output
- Node latency testing and speed-based sorting
- Inheriting upstream `rules` / `proxy-groups`

## License

[MIT](./LICENSE)
