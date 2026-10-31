import net from 'node:net';
import crypto from 'node:crypto';

/**
 * Minimal RFC 6455 *client*, used only by the protocol tests.
 *
 * Yu runs the server side for OneBot reverse connections; testing that path
 * needs a client, and a real NapCat cannot run in CI. This client speaks just
 * enough of the protocol: handshake, masked text frames, ping/pong, close.
 */
export function connectWebSocket({ port, path, headers = {}, host = '127.0.0.1', timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect({ port, host });
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let closed = false;
    const listeners = { message: [], close: [] };

    const emit = (event, value) => {
      for (const fn of listeners[event]) {
        try {
          fn(value);
        } catch {
          /* a test listener threw; ignore */
        }
      }
    };

    const encode = (opcode, payload) => {
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
      const mask = crypto.randomBytes(4);
      let header;
      if (data.length < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | data.length;
      } else if (data.length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(data.length), 2);
      }
      header[0] = 0x80 | opcode;
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
      return Buffer.concat([header, mask, masked]);
    };

    const timer = setTimeout(() => {
      if (!upgraded) {
        socket.destroy();
        reject(new Error('websocket handshake timed out'));
      }
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          '',
          '',
        ].join('\r\n'),
      );
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        const status = Number(head.split(' ')[1]);
        if (status !== 101) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`handshake rejected: ${status} ${head.split('\r\n')[0]}`));
          return;
        }
        upgraded = true;
        clearTimeout(timer);
        resolve(client);
        return;
      }
      // Parse server frames (unmasked).
      for (;;) {
        if (buffer.length < 2) return;
        const b0 = buffer[0];
        const b1 = buffer[1];
        const opcode = b0 & 0x0f;
        let length = b1 & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) {
          closed = true;
          emit('close', { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005 });
          socket.destroy();
          return;
        }
        if (opcode === 0x9) {
          socket.write(encode(0xa, payload));
          continue;
        }
        if (opcode === 0xa) continue;
        if (opcode === 0x1) emit('message', payload.toString('utf8'));
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      if (!upgraded) reject(error);
    });
    socket.on('close', () => {
      if (!closed) {
        closed = true;
        emit('close', { code: 1006, reason: 'socket closed' });
      }
    });

    const client = {
      on(event, fn) {
        listeners[event]?.push(fn);
        return client;
      },
      send(text) {
        socket.write(encode(0x1, text));
      },
      /** Wait for the next JSON message matching `predicate`. */
      waitFor(predicate, { timeoutMs: waitTimeout = 8000 } = {}) {
        return new Promise((resolveWait, rejectWait) => {
          const timerWait = setTimeout(() => rejectWait(new Error('timed out waiting for a websocket message')), waitTimeout);
          const handler = (raw) => {
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch {
              return;
            }
            if (!predicate(parsed)) return;
            clearTimeout(timerWait);
            const list = listeners.message;
            const index = list.indexOf(handler);
            if (index >= 0) list.splice(index, 1);
            resolveWait(parsed);
          };
          listeners.message.push(handler);
        });
      },
      close() {
        try {
          socket.write(encode(0x8, Buffer.alloc(0)));
        } catch {
          /* ignore */
        }
        socket.destroy();
      },
      get closed() {
        return closed;
      },
    };
  });
}

/** Raw upgrade attempt for negative tests: resolves with the HTTP status line. */
export function probeUpgrade({ port, path, headers = {}, host = '127.0.0.1', timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host });
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('probe timed out'));
    }, timeoutMs);
    socket.on('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
      const line = data.split('\r\n')[0];
      if (!line.includes(' ')) return;
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: Number(line.split(' ')[1]), line });
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
