# Leaflet rooms relay

The WebSocket relay behind `wss://rooms.leaflet.chat`. Readers who share a
room code (`ABCD-EFGH-JKLM`) meet here to exchange notes, reading positions
and connection details for device-to-device transfers. Everything that passes
through is sealed by the clients with a key derived from the code; the relay
routes ciphertext and never learns the code, the book, a note or a position.

## Layout

| File | Role |
| --- | --- |
| `src/hub.ts` | Pure room logic: membership, host seat, lock policy, rate limits, pings, expiry. No platform APIs; unit-tested from the app's vitest run. |
| `src/room.ts` | Durable Object wrapping one `RoomHub` with the WebSocket Hibernation API and an alarm for housekeeping. |
| `src/index.ts` | Worker entry: routes `GET /v1/rooms/<32 hex>` upgrades to the object, answers `/healthz`. |
| `dev-server.ts` | The same hub on Node + `ws`, for local development. |

## Deploy to Cloudflare

```sh
cd workers/rooms
npm install
npx wrangler login          # once
npx wrangler deploy
```

`wrangler.jsonc` declares the `ROOMS` Durable Object binding (SQLite-backed
class `RoomDurableObject`) and the custom domain `rooms.leaflet.chat`; the
zone `leaflet.chat` must already be on the same Cloudflare account. Wrangler
creates the DNS record and certificate on the first deploy. For a different
domain change `routes[0].pattern` (or delete `routes` and use the
`*.workers.dev` URL Wrangler prints); then set that address in the app's
"Relay" field.

Type-check the worker on its own with `npm run typecheck`.

## Run locally

```sh
cd workers/rooms
npm install
npm run dev:node            # ws://127.0.0.1:8787  (Node ≥ 24)
# or
npm run dev                 # wrangler dev, emulates the Durable Object
```

Node 22 needs `node --experimental-strip-types dev-server.ts`. In the app,
enter `ws://127.0.0.1:8787` as the relay address.

## What the relay can and cannot see

Sees: the room id (a hash of the code), opaque member ids it assigned,
channel labels (`notes`, `presence`, `control`, `signal`, `bulk`), ciphertext
sizes and timing, the lock flag, and who holds the host seat.

Cannot see: the room code, which book is being read, note text, highlighted
passages, reading positions, device names, or the WebRTC descriptions used
for library transfers. It also cannot forge a message: every payload is
AES-GCM sealed with the code-derived key and bound to the sender id the relay
itself assigned, so a re-attributed or replayed frame fails verification on
every client.

## Wire protocol (JSON text frames, ≤ 64 KiB)

```text
client → relay   { "type": "join", "room": "<32 hex>", "create": bool, "hostSecret"?: str }
relay  → client  { "type": "joined", "you": id, "host": bool, "hostSecret"?: str,
                   "locked": bool, "members": [{ "id", "host", "joinedAt" }] }
                 { "type": "error", "code": "not_found" | "room_full" | "rate_limited"
                                            | "bad_request" | "locked" | "forbidden" }
client → relay   { "type": "data", "channel": ch, "payload": str, "to"?: id }
relay  → client  { "type": "data", "from": id, "channel": ch, "payload": str }
relay  → client  { "type": "member-joined", "member" } | { "type": "member-left", "id" }
host   → relay   { "type": "policy", "locked": bool } | { "type": "kick", "id" }
relay  → client  { "type": "policy", "locked": bool }
either           { "type": "ping" } / { "type": "pong" }
```

Rules enforced by the hub: a room is created by the first `join` with
`create: true`; the creator receives a `hostSecret` that reclaims the host
seat after a reconnect; at most 16 members; while `locked`, `notes` and
`bulk` frames from guests are refused with `locked`; per socket 40 frames/s
(burst 80) and 2 MB/s, three strikes and the socket is closed; sockets that
never join are dropped after 10 s; idle sockets are pinged every 30 s and
dropped after two missed pings; a room's state (including the host secret)
is deleted 24 h after the last member leaves.

Close codes: `1008` policy (rate limit / malformed), `1009` frame too large,
`4000` kicked, `4001` host seat reclaimed elsewhere, `4002` idle, `4003` join
timeout, `4404` room not found, `4409` room full.
