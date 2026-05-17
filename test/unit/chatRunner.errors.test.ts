import { describe, expect, it } from 'vitest';
import {
  gatewayBridgeFailureUserMessage,
  isGatewayBridgeFailure,
} from '../../src/services/chatRunner';

describe('isGatewayBridgeFailure', () => {
  it('detects gatewayWs connection errors', () => {
    expect(isGatewayBridgeFailure(new Error('gatewayWs: connection failed'))).toBe(true);
    expect(isGatewayBridgeFailure(new Error('gatewayWs: socket closed'))).toBe(true);
  });

  it('detects missing auth token messages', () => {
    expect(isGatewayBridgeFailure(new Error('gatewayWs: no auth token'))).toBe(true);
    expect(isGatewayBridgeFailure(new Error('OpenClaw: no auth token'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isGatewayBridgeFailure(new Error('model overloaded'))).toBe(false);
    expect(isGatewayBridgeFailure(new Error(''))).toBe(false);
  });
});

describe('gatewayBridgeFailureUserMessage', () => {
  it('returns a Ukrainian line without implementation details', () => {
    const msg = gatewayBridgeFailureUserMessage();
    expect(msg).not.toMatch(/gatewayWs/i);
    expect(msg.length).toBeGreaterThan(30);
  });
});
