import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

type Validator = (agentId: string, token: string) => boolean;
type AgentClient = { agentId: string; socket: WebSocket };

const clients = new Set<AgentClient>();
const pathPattern = /^\/ws\/agents\/([0-9a-f-]{36})\/tasks$/i;

function tokenFromRequest(req: IncomingMessage): string {
  const header = req.headers['x-agent-token'];
  if (typeof header === 'string') return header;
  const url = new URL(req.url || '/', 'http://localhost');
  return url.searchParams.get('token') || '';
}

/** Attach the authenticated task push channel to the HTTP server. */
export function attachAgentTaskWebSocket(server: Server, validate: Validator): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const match = pathPattern.exec(new URL(req.url || '/', 'http://localhost').pathname);
    if (!match) { socket.destroy(); return; }
    const agentId = match[1];
    if (!validate(agentId, tokenFromRequest(req))) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const client = { agentId, socket: ws };
      clients.add(client);
      ws.send(JSON.stringify({ type: 'ready', agentId }));
      ws.on('close', () => clients.delete(client));
      ws.on('error', () => clients.delete(client));
    });
  });
  server.on('close', () => {
    for (const client of clients) client.socket.close();
    clients.clear();
    wss.close();
  });
}

/** Push a newly created task to all connected clients for that Agent. */
export function publishAgentTask(agentId: string, task: Record<string, unknown>): void {
  const payload = JSON.stringify({ type: 'task', task });
  for (const client of clients) {
    if (client.agentId !== agentId || client.socket.readyState !== WebSocket.OPEN) continue;
    try { client.socket.send(payload); } catch { clients.delete(client); }
  }
}
