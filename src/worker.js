/**
 * Entry Worker: terminates the HTTP/WebSocket request and forwards it to
 * the Durable Object instance for the target device. One DeviceRoom per
 * deviceId, so the device and any webapp viewers for that device share
 * a single coordination point at the edge.
 */

export { DeviceRoom } from "./device-room.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    // Every connection (device or webapp) must say which device it's
    // about via a query param, e.g. wss://.../connect?deviceId=my-phone-1
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) {
      return new Response("Missing deviceId query param", { status: 400 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const id = env.DEVICE_ROOM.idFromName(deviceId);
    const stub = env.DEVICE_ROOM.get(id);
    return stub.fetch(request);
  },
};
