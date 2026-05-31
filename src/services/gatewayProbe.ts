/**
 * Shared gateway reachability probe for page renders.
 *
 * The connection badge can't rely on the unauthenticated HTTP `/health` check
 * alone: the gateway can answer `/health` while the authenticated WS RPC still
 * fails (wrong port, token mismatch, blocked upgrade). So we probe both and
 * derive an honest status. On failure we log the baseUrl we tried — a wrong
 * port/host is the usual culprit and silent failures render a dead-end screen.
 */

import { openclaw } from './openclaw';
import { openclawWs } from './openclawWs';

export type GatewayStatus = 'ok' | 'degraded' | 'down';

export interface GatewayProbe {
  /** HTTP `/health` reachable (unauthenticated). */
  gatewayUp: boolean;
  /** Agent list for the composer dropdown — empty when the RPC failed. */
  agents: { id: string }[];
  /** Human-readable RPC error, or null on success. */
  agentsError: string | null;
  /** Honest connection state for the badge. */
  gatewayStatus: GatewayStatus;
  /** The baseUrl we tried — surfaced in the UI for diagnostics. */
  baseUrl: string;
}

export async function probeGateway(context = 'page'): Promise<GatewayProbe> {
  const gatewayUp = await openclaw.health();

  let agents: { id: string }[] = [];
  let agentsError: string | null = null;
  try {
    const raw = await openclawWs.listAgents();
    agents = [{ id: 'openclaw/default' }, ...raw.map((a) => ({ id: `openclaw/${a.id}` }))];
  } catch (err) {
    agentsError = err instanceof Error ? err.message : String(err);
    console.error(
      `[${context}] agents.list failed (baseUrl=${openclaw.baseUrl}, gatewayHealth=${
        gatewayUp ? 'up' : 'down'
      }): ${agentsError}`,
    );
  }

  const gatewayStatus: GatewayStatus = !gatewayUp
    ? 'down'
    : agentsError
      ? 'degraded'
      : 'ok';

  return { gatewayUp, agents, agentsError, gatewayStatus, baseUrl: openclaw.baseUrl };
}
