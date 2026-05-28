/**
 * Tiny module that holds the bound host:port of the iClaw HTTP server.
 *
 * The address is known only after `server.listen(...)` resolves in
 * `index.ts`, and several services (remote-access, …) need to make
 * loopback requests against it. Rather than thread the values through
 * every call site, we set them once on startup and read them where
 * needed.
 */

interface BoundAddress {
  host: string;
  port: number;
}

let bound: BoundAddress | null = null;

export function setBoundLocalAddress(addr: BoundAddress): void {
  bound = addr;
}

export function getBoundLocalAddress(): BoundAddress | null {
  return bound;
}
