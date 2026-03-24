#!/usr/bin/env node

/**
 * MCP JSON-RPC server over stdio for scribe.js document tools.
 * All tool logic lives in tools.js; this file handles the protocol.
 */

import fs from 'node:fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TOOLS, toolHandlers } from './tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logFile = resolve(__dirname, 'mcp.log');

function mcpLog(msg) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
}

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(`${json}\n`);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'scribe-document-tools',
        version: '0.1.0',
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    const handler = toolHandlers[toolName];

    if (!handler) {
      sendResult(id, {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      });
      return;
    }

    mcpLog(`tool call: ${toolName} args=${JSON.stringify(toolArgs)}`);
    const startTime = Date.now();
    try {
      const result = await handler(toolArgs);
      const elapsed = Date.now() - startTime;
      mcpLog(`tool done: ${toolName} (${elapsed}ms)`);

      // render_page returns image content instead of JSON text
      if (toolName === 'render_page' && result.base64) {
        sendResult(id, {
          content: [
            { type: 'image', data: result.base64, mimeType: 'image/png' },
            { type: 'text', text: JSON.stringify({ page: result.page, pageCount: result.pageCount, dpi: result.dpi }) },
          ],
        });
      } else {
        sendResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      }
    } catch (e) {
      sendResult(id, {
        content: [{ type: 'text', text: `Error: ${e.message}\n${e.stack}` }],
        isError: true,
      });
    }
    return;
  }

  if (method === 'ping') {
    sendResult(id, {});
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

let stdinBuf = '';

process.stdin.setEncoding('utf8');

const processLines = () => {
  let newlineIdx = stdinBuf.indexOf('\n');
  for (; newlineIdx !== -1; newlineIdx = stdinBuf.indexOf('\n')) {
    const line = stdinBuf.slice(0, newlineIdx).trim();
    stdinBuf = stdinBuf.slice(newlineIdx + 1);

    if (!line) continue;

    if (/^Content-Length:/i.test(line)) continue;

    try {
      const msg = JSON.parse(line);
      handleRequest(msg).catch((e) => {
        process.stderr.write(`Error handling request: ${e.message}\n${e.stack}\n`);
        if (msg.id !== undefined) {
          sendError(msg.id, -32603, `Internal error: ${e.message}`);
        }
      });
    } catch (e) {
      process.stderr.write(`Failed to parse JSON-RPC message: ${e.message}\n`);
    }
  }
};

process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  processLines();
});

process.stderr.write('scribe-document-tools MCP server started\n');
