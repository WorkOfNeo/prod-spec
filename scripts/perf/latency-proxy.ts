// TCP proxy that adds a fixed delay to every chunk in both directions —
// a stand-in for the network hop between the app and Postgres in
// production, which localhost doesn't have. With it, every sequential query
// costs at least 2 × delay, so an N+1 pattern shows up in local timings.
//
// Standalone:
//   npx tsx scripts/perf/latency-proxy.ts --listen 3111 --target localhost:5432 --delay-ms 2
// then point the app at it: DATABASE_URL=postgresql://postgres@localhost:3111/prodspec_p0
//
// probe.ts runs it in-process and flips the delay between runs (setDelay), so
// the server's pooled connections stay warm across latency settings.

import net from "node:net";

export type LatencyProxy = {
  port: number;
  setDelay(ms: number): void;
  close(): Promise<void>;
};

// One direction of one connection. Chunks are released in arrival order,
// each `delay` ms after it arrived — chunks that arrive together leave
// together, so a pipelined Parse/Bind/Execute costs one delay, not three.
function delayedPipe(from: net.Socket, to: net.Socket, getDelay: () => number) {
  const queue: Array<{ at: number; chunk: Buffer }> = [];
  let timer: NodeJS.Timeout | null = null;
  let ended = false;

  const flush = () => {
    timer = null;
    const now = Date.now();
    while (queue.length > 0 && queue[0].at <= now) to.write(queue.shift()!.chunk);
    if (queue.length > 0) timer = setTimeout(flush, queue[0].at - now);
    else if (ended) to.end();
  };

  from.on("data", (chunk: Buffer) => {
    const delay = getDelay();
    if (delay <= 0 && queue.length === 0) {
      to.write(chunk);
      return;
    }
    queue.push({ at: Date.now() + delay, chunk });
    if (!timer) timer = setTimeout(flush, Math.max(0, queue[0].at - Date.now()));
  });
  from.on("end", () => {
    ended = true;
    if (queue.length === 0 && !timer) to.end();
  });
}

export function startLatencyProxy(opts: {
  listenPort: number;
  targetHost: string;
  targetPort: number;
  delayMs: number;
}): Promise<LatencyProxy> {
  let delay = opts.delayMs;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(opts.targetPort, opts.targetHost);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    delayedPipe(client, upstream, () => delay);
    delayedPipe(upstream, client, () => delay);
    const teardown = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", teardown);
    upstream.on("error", teardown);
    client.on("close", teardown);
    upstream.on("close", teardown);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.listenPort, "127.0.0.1", () => {
      resolve({
        port: opts.listenPort,
        setDelay(ms: number) {
          delay = ms;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

// CLI entry — only when run directly, not when probe.ts imports it.
if (process.argv[1] && /latency-proxy\.ts$/.test(process.argv[1])) {
  const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const [targetHost, targetPort] = arg("--target", "localhost:5432").split(":");
  startLatencyProxy({
    listenPort: Number(arg("--listen", "3111")),
    targetHost,
    targetPort: Number(targetPort),
    delayMs: Number(arg("--delay-ms", "2")),
  }).then((p) => {
    console.log(`latency proxy 127.0.0.1:${p.port} → ${targetHost}:${targetPort}, +${arg("--delay-ms", "2")} ms per chunk each way`);
  });
}
