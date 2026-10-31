import crypto from 'node:crypto';

/**
 * A minimal RFC 6455 server, dependency-free.
 *
 * Yu needs exactly one thing from WebSockets: accepting a *reverse* connection
 * from an OneBot client (NapCat / SnowLuma dial in to us). Pulling a full
 * library in for that would add a native/browser dependency to a plugin that
 * otherwise runs on Node builtins alone, so the handshake and frame codec live
 * here, are covered by unit tests, and are deliberately strict:
 *
 * - client frames must be masked (a protocol requirement);
 * - payloads above `maxPayload` close the connection instead of buffering;
 * - unknown opcodes, unmasked frames, or malformed lengths fail closed.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const WS_OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
};

export function acceptKey(clientKey) {
  return crypto.createHash('sha1').update(`${clientKey}${GUID}`).digest('base64');
}

/** Encode one unmasked server frame. */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, data]);
}

/**
 * Incremental parser. Feed it socket chunks; it yields complete frames.
 * Returns `{ frames, rest }`; a malformed frame yields `{ error }`.
 */
export function createFrameReader({ maxPayload = 4 * 1024 * 1024 } = {}) {
  let buffer = Buffer.alloc(0);
  let fragmented = null; // { opcode, chunks }

  return function read(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    const frames = [];
    for (;;) {
      if (buffer.length < 2) break;
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;

      if (!masked) return { frames, error: 'client frame was not masked' };
      if (length === 126) {
        if (buffer.length < offset + 2) break;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) break;
        const big = buffer.readBigUInt64BE(offset);
        if (big > BigInt(maxPayload)) return { frames, error: 'frame payload too large' };
        length = Number(big);
        offset += 8;
      }
      if (length > maxPayload) return { frames, error: 'frame payload too large' };
      if (buffer.length < offset + 4 + length) break;

      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i++) payload[i] = buffer[offset + i] ^ mask[i & 3];
      offset += length;
      buffer = buffer.subarray(offset);

      if (opcode === WS_OPCODE.close) {
        frames.push({ opcode, payload, fin: true });
        continue;
      }
      if (opcode === WS_OPCODE.ping || opcode === WS_OPCODE.pong) {
        frames.push({ opcode, payload, fin: true });
        continue;
      }
      if (opcode === WS_OPCODE.continuation) {
        if (!fragmented) return { frames, error: 'unexpected continuation frame' };
        fragmented.chunks.push(payload);
        if (fin) {
          const whole = Buffer.concat(fragmented.chunks);
          frames.push({ opcode: fragmented.opcode, payload: whole, fin: true });
          fragmented = null;
        }
        continue;
      }
      if (opcode === WS_OPCODE.text || opcode === WS_OPCODE.binary) {
        if (!fin) {
          fragmented = { opcode, chunks: [payload] };
          continue;
        }
        frames.push({ opcode, payload, fin: true });
        continue;
      }
      return { frames, error: `unsupported opcode ${opcode}` };
    }
    return { frames };
  };
}

/**
 * Complete the HTTP upgrade and return a small connection object:
 *   { send(text), close(code, reason), destroy(), remote, onMessage, onClose }
 */
export function acceptWebSocket(req, socket, head, { maxPayload = 4 * 1024 * 1024, log } = {}) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (!key || version !== '13' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n'),
  );
  socket.setNoDelay?.(true);

  const read = createFrameReader({ maxPayload });
  let closed = false;
  const listeners = { message: [], close: [] };

  const emit = (event, value) => {
    for (const fn of listeners[event]) {
      try {
        fn(value);
      } catch (error) {
        log?.warn(`ws ${event} handler threw: ${error.message}`);
      }
    }
  };

  const finish = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    try {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      socket.write(encodeFrame(WS_OPCODE.close, body));
    } catch {
      /* ignore */
    }
    socket.end();
    emit('close', { code, reason });
  };

  socket.on('data', (chunk) => {
    if (closed) return;
    const { frames, error } = read(chunk);
    if (error) {
      log?.warn(`ws protocol error: ${error}`);
      finish(1002, error);
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === WS_OPCODE.close) {
        finish(1000, 'peer closed');
        return;
      }
      if (frame.opcode === WS_OPCODE.ping) {
        try {
          socket.write(encodeFrame(WS_OPCODE.pong, frame.payload));
        } catch {
          /* ignore */
        }
        continue;
      }
      if (frame.opcode === WS_OPCODE.pong) continue;
      if (frame.opcode === WS_OPCODE.text) emit('message', frame.payload.toString('utf8'));
      else if (frame.opcode === WS_OPCODE.binary) emit('message', frame.payload);
    }
  });
  socket.on('error', (error) => {
    log?.debug(`ws socket error: ${error.message}`);
    closed = true;
    emit('close', { code: 1006, reason: error.message });
  });
  socket.on('close', () => {
    if (!closed) {
      closed = true;
      emit('close', { code: 1006, reason: 'socket closed' });
    }
  });

  if (head && head.length) socket.emit('data', head);

  return {
    remote: `${req.socket?.remoteAddress ?? '?'}:${req.socket?.remotePort ?? 0}`,
    on(event, fn) {
      if (listeners[event]) listeners[event].push(fn);
      return () => {
        const list = listeners[event];
        if (!list) return;
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    },
    send(text) {
      if (closed) return false;
      try {
        socket.write(encodeFrame(WS_OPCODE.text, String(text)));
        return true;
      } catch {
        return false;
      }
    },
    close: finish,
    destroy() {
      closed = true;
      socket.destroy();
    },
    get closed() {
      return closed;
    },
  };
}
