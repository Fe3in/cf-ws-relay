/**
 * One DeviceRoom instance exists per deviceId (Durable Objects are
 * addressed by idFromName(deviceId) in worker.js). It holds the WebSocket
 * connections for that one device: exactly one "device" (the phone) and
 * zero or more "webapp" viewers.
 *
 * Uses the WebSocket Hibernation API (ctx.acceptWebSocket / getWebSockets)
 * so the object doesn't accrue duration charges while idly holding open
 * connections between messages - the runtime can evict it from memory and
 * wake it back up on the next message without losing the socket.
 */
export class DeviceRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get("deviceId");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept via the hibernation API rather than server.accept(), so this
    // Durable Object can be evicted from memory between messages.
    this.ctx.acceptWebSocket(server);

    // Nothing is known about this socket yet - it must send a "register"
    // message before it can do anything else. Store the pending deviceId
    // so register-time validation can cross-check it if needed.
    server.serializeAttachment({ role: null, deviceId, registeredAt: Date.now() });

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Hibernation API callbacks -----------------------------------

  async webSocketMessage(ws, messageRaw) {
    let msg;
    try {
      msg = JSON.parse(typeof messageRaw === "string" ? messageRaw : new TextDecoder().decode(messageRaw));
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid_json" }));
      return;
    }

    const attachment = ws.deserializeAttachment() || {};

    if (msg.type === "register") {
      await this.handleRegister(ws, msg, attachment);
      return;
    }

    if (!attachment.role) {
      ws.send(JSON.stringify({ type: "error", error: "not_registered" }));
      return;
    }

    if (attachment.role === "webapp" && msg.type === "command") {
      this.forwardCommandToDevice(msg);
      return;
    }

    if (attachment.role === "device" && (msg.type === "ack" || msg.type === "status")) {
      this.forwardToWebapps(msg);
      return;
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.role === "device") {
      this.forwardToWebapps({ type: "device_status", deviceId: attachment.deviceId, status: "offline" });
    }
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.role === "device") {
      this.forwardToWebapps({ type: "device_status", deviceId: attachment.deviceId, status: "offline" });
    }
  }

  // --- Helpers -------------------------------------------------------

  async handleRegister(ws, msg, attachment) {
    const { as, token, deviceId, targetDeviceId } = msg;
    const effectiveDeviceId = as === "device" ? (deviceId || attachment.deviceId) : (targetDeviceId || attachment.deviceId);

    if (as === "device") {
      if (!this.tokenAllowed(token, this.env.DEVICE_TOKENS)) {
        ws.send(JSON.stringify({ type: "error", error: "unauthorized" }));
        ws.close(4001, "unauthorized");
        return;
      }
      // Only one active device connection per room - close any existing one.
      for (const existing of this.ctx.getWebSockets()) {
        if (existing === ws) continue;
        const a = existing.deserializeAttachment() || {};
        if (a.role === "device") {
          try { existing.close(4000, "replaced_by_new_connection"); } catch {}
        }
      }

      ws.serializeAttachment({ role: "device", deviceId: effectiveDeviceId });
      ws.send(JSON.stringify({ type: "registered", deviceId: effectiveDeviceId }));
      this.forwardToWebapps({ type: "device_status", deviceId: effectiveDeviceId, status: "online" });
      return;
    }

    if (as === "webapp") {
      if (!this.tokenAllowed(token, this.env.WEBAPP_TOKENS)) {
        ws.send(JSON.stringify({ type: "error", error: "unauthorized" }));
        ws.close(4001, "unauthorized");
        return;
      }
      ws.serializeAttachment({ role: "webapp", deviceId: effectiveDeviceId });
      const deviceOnline = this.isDeviceOnline();
      ws.send(JSON.stringify({ type: "registered", deviceId: effectiveDeviceId, deviceOnline }));
      return;
    }

    ws.send(JSON.stringify({ type: "error", error: "invalid_role" }));
  }

  tokenAllowed(token, csvSecret) {
    if (!token || !csvSecret) return false;
    const allowed = csvSecret.split(",").map((t) => t.trim());
    return allowed.includes(token);
  }

  isDeviceOnline() {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.role === "device") return true;
    }
    return false;
  }

  forwardCommandToDevice(msg) {
    const deviceSocket = this.ctx.getWebSockets().find((ws) => {
      const a = ws.deserializeAttachment() || {};
      return a.role === "device";
    });
    if (!deviceSocket) {
      // No device connected - notify all webapp viewers.
      this.forwardToWebapps({ type: "error", error: "device_offline", commandId: msg.commandId });
      return;
    }
    deviceSocket.send(JSON.stringify({
      type: "command",
      commandId: msg.commandId,
      action: msg.action,
      params: msg.params || {},
    }));
  }

  forwardToWebapps(payload) {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.role === "webapp") {
        try { ws.send(text); } catch {}
      }
    }
  }
}
