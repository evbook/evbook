import { isLocalAddress } from "../../core/loginThrottle";

/**
 * The client's address on Node, for sign-in throttling
 * (src/core/loginThrottle.ts). Only behind a reverse proxy the owner says to
 * trust (TRUST_PROXY=true): without one, X-Forwarded-For is whatever the
 * client wrote, and with one in front the socket's address is the proxy's,
 * shared by everybody. Either way there is no address to lock, and the
 * throttle only slows sign-ins down.
 *
 * Even then the header counts only on a connection from a local address
 * (`peer`: loopback, a private network, a Docker bridge), which is where a
 * proxy in front of this server connects from. A published port reached
 * straight from the internet keeps the caller's own public address, and there
 * the header is the caller's word again: believing it would let every guess
 * name a fresh client, or name the owner's address to lock them out.
 *
 * The last entry is the one to read. A proxy appends the address it saw (or,
 * like Caddy, replaces the header with it), so the last entry is the proxy's
 * own word; everything before it came from the client and can be invented.
 * That holds for exactly one proxy: behind a chain, the last entry is the
 * next proxy's address, which is why the setting says "true" and nothing more
 * clever.
 */
export function forwardedClient(request: Request, trustProxy: boolean, peer: string | undefined): string | null {
  if (!trustProxy || !isLocalAddress(peer)) return null;
  const last = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return last ? last : null;
}
