// Minimal RFC 6455 WebSocket server — zero dependencies, Node >= 18.
//
// Enough for the Apollo bridge: text frames in both directions, ping/pong,
// close handshake, and fragment assembly. Client frames must be masked
// (per spec); server frames are unmasked. This is a LOCALHOST-only transport
// for the Apollo <-> Hermes relay — bind it to 127.0.0.1, never 0.0.0.0.
//
// Usage:
//   import http from "node:http";
//   import { attachWs } from "./ws-server.mjs";
//   const server = http.createServer();
//   const conns = attachWs(server);
//   conns.on("connection", (conn) => {
//     conn.on("text", (text) => { ... conn.send(text); });
//     conn.on("close", () => {});
//   });
//   server.listen(port, "127.0.0.1");

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BINARY = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

export function attachWs(server) {
  const emitter = new EventEmitter();
  server.on("upgrade", (req, socket) => {
    try {
      handleUpgrade(req, socket, emitter);
    } catch (e) {
      socket.destroy();
      emitter.emit("error", e);
    }
  });
  return emitter;
}

function handleUpgrade(req, socket, emitter) {
  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];
  if (!key || version !== "13") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n",
  );

  const conn = new WsConn(socket);
  emitter.emit("connection", conn);
  socket.on("data", (chunk) => conn._onData(chunk));
  socket.on("error", (e) => {
    conn._closed = true;
    // Abrupt client drops (ECONNRESET) are normal; only surface the error if
    // someone is listening — never crash the process on a peer disconnect.
    if (emitter.listenerCount("error") > 0) emitter.emit("error", e);
    conn._emitClose();
  });
  socket.on("close", () => {
    conn._closed = true;
    conn._emitClose();
  });
}

class WsConn {
  constructor(socket) {
    this.socket = socket;
    this._closed = false;
    this._buffer = Buffer.alloc(0);
    this._fragments = null; // { opcode, parts: [] } while a fragmented msg is mid-flight
    this._closeSent = false;
    this._closeEmitted = false;
  }

  send(text) {
    if (this._closed) return false;
    const payload = Buffer.from(String(text), "utf8");
    try {
      this.socket.write(encodeFrame(OP_TEXT, payload, false));
      return true;
    } catch {
      return false;
    }
  }

  // Send a ws-level ping (keeps proxies/OS timeouts at bay; browsers reply
  // with pong automatically).
  ping() {
    if (this._closed) return false;
    try {
      this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0), false));
      return true;
    } catch {
      return false;
    }
  }

  close(code = 1000, reason = "") {
    if (this._closed || this._closeSent) return;
    this._closeSent = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try {
      this.socket.write(encodeFrame(OP_CLOSE, payload, false));
    } catch {
      /* socket already dying */
    }
    // Give the peer a moment to echo close, then drop.
    setTimeout(() => this.socket.destroy(), 200).unref?.();
  }

  _onData(chunk) {
    if (this._closed) return;
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    while (true) {
      const frame = parseFrame(this._buffer);
      if (!frame) return; // need more bytes
      this._buffer = this._buffer.subarray(frame.consumed);
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    // Control frames must not be fragmented and carry <= 125 bytes.
    if (frame.opcode >= 0x8 && (!frame.fin || frame.payload.length > 125)) {
      return this._fail(1002, "invalid control frame");
    }
    switch (frame.opcode) {
      case OP_TEXT:
      case OP_BINARY:
        if (frame.fin) {
          this._emitText(frame.payload);
        } else {
          this._fragments = { opcode: frame.opcode, parts: [frame.payload] };
        }
        break;
      case OP_CONT: {
        if (!this._fragments) return this._fail(1002, "unexpected continuation");
        this._fragments.parts.push(frame.payload);
        if (frame.fin) {
          const { opcode, parts } = this._fragments;
          this._fragments = null;
          if (opcode === OP_TEXT || opcode === OP_BINARY) this._emitText(Buffer.concat(parts));
        }
        break;
      }
      case OP_PING:
        if (!this._closed) {
          try {
            this.socket.write(encodeFrame(OP_PONG, frame.payload, false));
          } catch {}
        }
        break;
      case OP_PONG:
        break; // heartbeat reply — nothing to do
      case OP_CLOSE: {
        if (!this._closeSent) this.close(1000);
        this._closed = true;
        this.socket.destroy();
        break;
      }
      default:
        this._fail(1002, "unknown opcode " + frame.opcode);
    }
  }

  _emitText(payload) {
    this.emit("text", payload.toString("utf8"));
  }

  _fail(code, reason) {
    try {
      this.close(code, reason);
    } catch {}
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this._listeners?.close?.();
  }

  // Minimal event wiring used by the relay (EventEmitter-free on purpose).
  on(event, fn) {
    this._listeners ??= {};
    this._listeners[event] = fn;
    return this;
  }
  emit(event, ...args) {
    this._listeners?.[event]?.(...args);
    return this;
  }
}

// --- framing ---------------------------------------------------------------

function encodeFrame(opcode, payload, mask) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] = (mask ? 0x80 : 0) | len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = (mask ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i % 4];
  return Buffer.concat([header, key, masked]);
}

// Parse one frame off the front of `buf`. Returns null when incomplete.
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame too large");
    len = Number(big);
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
  const start = offset + maskLen;
  const payload = buf.subarray(start, start + len);
  if (masked) {
    for (let i = 0; i < len; i++) payload[i] ^= maskKey[i % 4];
  }
  return { fin, opcode, payload: Buffer.from(payload), consumed: start + len };
}
