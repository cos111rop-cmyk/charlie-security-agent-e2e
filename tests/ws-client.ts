import WebSocket from 'ws';

export const WS_URL = process.env.AGENT_WS_URL || 'ws://127.0.0.1:8080';
export const HTTP_CONTROL_URL = WS_URL.replace(/^ws/, 'http');
export const IS_MOCK = process.env.USE_MOCK_AGENT !== 'false';

export interface AgentEnvelope {
  statusCode: number;
  correlationID: string;
  path: string;
  response: Record<string, any>;
  timeTaken?: string;
  processingMs?: number;
  [key: string]: any;
}

export class AgentWsClient {
  private ws!: WebSocket;
  private messages: AgentEnvelope[] = [];

  async connect(): Promise<void> {
    this.ws = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
    this.ws.on('message', (raw) => {
      try {
        this.messages.push(JSON.parse(raw.toString()));
      } catch {
        // ignore non-json frames
      }
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
        const parsed: AgentEnvelope = JSON.parse(raw.toString());
        if (parsed.correlationID === correlationID) {
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
        const parsed: AgentEnvelope = JSON.parse(raw.toString());
        if (parsed.correlationID === correlationID) {
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
  await fetch(`${HTTP_CONTROL_URL}/__test/reset`, { method: 'POST' });
}

export async function setMockState(patch: Record<string, any>): Promise<any> {
  if (!IS_MOCK) return;
  const res = await fetch(`${HTTP_CONTROL_URL}/__test/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return res.json();
}

export async function inspectMockState(): Promise<any> {
  if (!IS_MOCK) return null;
  const res = await fetch(`${HTTP_CONTROL_URL}/__test/inspect`);
  return res.json();
}
