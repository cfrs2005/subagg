import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pingHostPort } from '../src/services/tcpPing.js';

describe('TCP host port ping', () => {
  let server: net.Server;
  let port: number;

  beforeAll(async () => {
    server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('reports an open TCP port and latency', async () => {
    const result = await pingHostPort('127.0.0.1', port);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).not.toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('reports a closed TCP port without throwing', async () => {
    const result = await pingHostPort('127.0.0.1', port + 1, 200);
    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeNull();
    expect(result.error).toBeTruthy();
  });
});
