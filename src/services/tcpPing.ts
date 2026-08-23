import net from 'node:net';

export interface TcpPingResult {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

/**
 * Test TCP reachability only. No proxy handshake or credential is sent.
 */
export function pingHostPort(host: string, port: number, timeoutMs = 3000): Promise<TcpPingResult> {
  const startedAt = process.hrtime.bigint();

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (result: TcpPingResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs, () => finish({ ok: false, latencyMs: null, error: 'timeout' }));
    socket.once('connect', () => {
      const elapsedNs = process.hrtime.bigint() - startedAt;
      finish({ ok: true, latencyMs: Number(elapsedNs / 1_000_000n) });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish({ ok: false, latencyMs: null, error: error.code ?? 'connection-failed' });
    });
  });
}
