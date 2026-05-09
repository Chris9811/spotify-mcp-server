import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: path.join(__dirname, '../.env'),
  quiet: true
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { albumTools } from './albums.js';
import { playTools } from './play.js';
import { playlistTools } from './playlist.js';
import { readTools } from './read.js';

function createServer() {
  const server = new McpServer({
    name: 'spotify-controller',
    version: '1.0.0',
  });

  [...readTools, ...playTools, ...albumTools, ...playlistTools].forEach(
    (tool) => {
      server.tool(tool.name, tool.description, tool.schema, tool.handler);
    },
  );

  return server;
}

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawBody) {
    return undefined;
  }

  return JSON.parse(rawBody);
}

function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function startStdioServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttpServer() {
  const port = Number.parseInt(process.env.PORT || '8080', 10);
  const host = process.env.HOST || '0.0.0.0';
  const mcpPath = process.env.MCP_PATH || '/mcp';
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
        writeJson(res, 200, { status: 'ok' });
        return;
      }

      if (requestUrl.pathname !== mcpPath) {
        writeJson(res, 404, {
          error: 'Not found',
          message: `Use ${mcpPath} for MCP requests.`,
        });
        return;
      }

      if (req.method !== 'POST') {
        writeJson(res, 405, {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Method not allowed.',
          },
          id: null,
        });
        return;
      }

      const sessionIdHeader = req.headers['mcp-session-id'];
      const sessionId =
        typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;

      const parsedBody =
        req.method === 'POST' ? await readJsonBody(req) : undefined;

      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);

        if (!transport) {
          writeJson(res, 404, {
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'Session not found',
            },
            id: null,
          });
          return;
        }
      } else if (req.method === 'POST' && parsedBody && isInitializeRequest(parsedBody)) {
        const server = createServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport!);
          },
        });

        transport.onclose = () => {
          if (transport?.sessionId) {
            transports.delete(transport.sessionId);
          }
          void server.close();
        };

        await server.connect(transport);
      } else {
        writeJson(res, 400, {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      console.error('Error handling HTTP MCP request:', error);

      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, () => {
      console.log(
        `Spotify MCP server listening on http://${host}:${port}${mcpPath}`,
      );
      resolve();
    });

    httpServer.on('error', reject);
  });
}

async function main() {
  const transportMode = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();

  if (transportMode === 'http') {
    await startHttpServer();
    return;
  }

  if (transportMode === 'stdio') {
    await startStdioServer();
    return;
  }

  throw new Error(
    `Unsupported MCP_TRANSPORT "${transportMode}". Use "stdio" or "http".`,
  );
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
