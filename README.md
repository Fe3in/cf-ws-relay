# DND Remote Relay — Cloudflare Worker + Durable Object

Same relay protocol as the earlier Node/`ws` server, rebuilt on Cloudflare
using a Durable Object per device with the WebSocket Hibernation API, so it
stays within Cloudflare's free Durable Objects allowance for typical
personal-project traffic (occasional commands/status pings, not
high-frequency messaging).

## Files
- `wrangler.toml` — Worker + Durable Object binding config
- `src/worker.js` — entry point, routes each connection to the right DeviceRoom
- `src/device-room.js` — the Durable Object: auth, registration, message relay

## One important protocol change vs. the Node version

Because Cloudflare routes to a Durable Object **before** any message is
read, the `deviceId` must be passed as a **query parameter on the
WebSocket URL itself**, not inside the first `register` message body (the
`register` message is still sent the same way, for the token/role check).

**Old URL (Node server):** `wss://your-app.up.railway.app`
**New URL (Cloudflare):** `wss://dnd-remote-relay.<your-subdomain>.workers.dev/connect?deviceId=my-phone-1`

Everything else about the message protocol (`register`, `command`, `ack`,
`status`, `device_status`, `error`) is unchanged — the Android app's
`WebSocketClient` and the webapp's `app.js` don't need logic changes, only
the URL you type into their connection settings needs the `?deviceId=...`
suffix (or update the app/webapp to append it automatically — see note
below).

## Deploying

```bash
npm install
npx wrangler login          # same Cloudflare account as your Telegram bot
npx wrangler secret put DEVICE_TOKENS
# paste a long random token when prompted (comma-separate if you'll have >1 device)
npx wrangler secret put WEBAPP_TOKENS
# paste a different long random token when prompted
npx wrangler deploy
```

Wrangler will print your live URL, something like:
`https://dnd-remote-relay.<your-subdomain>.workers.dev`

Use `wss://` (not `https://`) with the same host when configuring the
Android app and the webapp.

## Verifying it's live

```bash
curl https://dnd-remote-relay.<your-subdomain>.workers.dev/health
# {"ok":true}
```

## Recommended follow-up: auto-append deviceId in the clients

Rather than remembering to type `?deviceId=...` by hand every time, update:
- **Android `WebSocketClient`**: build the URL as `"$baseUrl/connect?deviceId=$deviceId"` before opening the connection.
- **Webapp `app.js`**: in `connect()`, use `` `${config.wsUrl}/connect?deviceId=${encodeURIComponent(config.deviceId)}` `` instead of the raw `config.wsUrl` when constructing `new WebSocket(...)`.

Ask for this change to be made for you if you'd rather not edit the code
by hand.

## Cost expectations

For one phone with occasional manual toggles plus periodic scheduled
status pings, you should stay within Cloudflare's free Durable Objects
allowance indefinitely. If you later add many devices or high-frequency
polling, revisit the pricing calculator on Cloudflare's docs.
