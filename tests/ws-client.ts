import WebSocket from 'ws';

export const WS_URL = process.env.AGENT_WS_URL || 'ws://127.0.0.1:8080';
export const HTTP_CONTROL_URL = WS_URL.replace(/^ws/, 'http');
export const IS_MOCK = process.env.USE_MOCK_AGENT !== 'false';
/**
 * Tests that create, change or delete data (register, forgetMe, setConfiguration, ...)
 * only run against a live agent when ALLOW_LIVE_MUTATIONS=true. Always allowed on the mock.
 */
export const CAN_MUTATE = IS_MOCK || process.env.ALLOW_LIVE_MUTATIONS === 'true';

export interface AgentEnvelope {
  statusCode: number;
  correlationID: string;
  path: string;
  response: Record<string, any>;
  timeTaken?: string;
  processingMs?: number;
  [key: string]: any;
}

/** Parse a frame, ignoring non-JSON so one bad frame can't throw inside a listener. */
function parseFrame(raw: WebSocket.RawData): AgentEnvelope | null {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

async function control(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${HTTP_CONTROL_URL}${path}`, init);
  if (!res.ok) {
    throw new Error(`Mock control call ${path} failed: HTTP ${res.status}`);
  }
  return res.json().catch(() => null);
}

export class AgentWsClient {
  private ws!: WebSocket;

  async connect(): Promise<void> {
    this.ws = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
  }

  async send(
    path: string,
    payload?: Record<string, any>,
    customCorrelationId?: string,
    timeoutMs = 8000
  ): Promise<AgentEnvelope> {
    const correlationID =
      customCorrelationId || `e2e-${path.replace(/\//g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const body: Record<string, any> = { correlationID, path };
    if (payload !== undefined) {
      body.payload = payload;
    }

    return new Promise<AgentEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.off('message', listener);
        reject(new Error(`Timeout waiting for response on ${path} (${correlationID})`));
      }, timeoutMs);

      const listener = (raw: WebSocket.RawData) => {
        const parsed = parseFrame(raw);
        if (parsed && parsed.correlationID === correlationID) {
          // Skip intermediate 1500 pending frames if waiting for final decision unless requested
          if (parsed.response?.errorInfo?.code === 1500 && !payload?.expectInterimOnly) {
            return;
          }
          clearTimeout(timer);
          this.ws.off('message', listener);
          resolve(parsed);
        }
      };

      this.ws.on('message', listener);
      this.ws.send(JSON.stringify(body));
    });
  }

  async sendAndCollectAll(
    path: string,
    payload: Record<string, any>,
    timeoutMs = 5000
  ): Promise<AgentEnvelope[]> {
    const correlationID = `e2e-multi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const collected: AgentEnvelope[] = [];

    return new Promise<AgentEnvelope[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.off('message', listener);
        reject(new Error(`Timeout collecting frames for ${correlationID}`));
      }, timeoutMs);

      const listener = (raw: WebSocket.RawData) => {
        const parsed = parseFrame(raw);
        if (parsed && parsed.correlationID === correlationID) {
          collected.push(parsed);
          if (parsed.response?.errorInfo?.code !== 1500) {
            clearTimeout(timer);
            this.ws.off('message', listener);
            resolve(collected);
          }
        }
      };

      this.ws.on('message', listener);
      this.ws.send(JSON.stringify({ correlationID, path, payload }));
    });
  }

  async close(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}

export async function resetMockState(): Promise<void> {
  if (!IS_MOCK) return;
  await control('/__test/reset', { method: 'POST' });
}

export async function setMockState(patch: Record<string, any>): Promise<any> {
  if (!IS_MOCK) return;
  return control('/__test/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function inspectMockState(): Promise<any> {
  if (!IS_MOCK) return null;
  return control('/__test/inspect');
}
