/**
 * HTTP surface for the MCP protocol only: GET /mcp (metadata), POST /mcp (JSON-RPC).
 */

/**
 * @param {import('express').Express} app
 * @param {object} opts
 * @param {(body: unknown) => Promise<import('./json-rpc-types').MCPHandlerResult>} opts.handleMCPRequest
 * @param {(level: string, message: string, data?: object) => void} opts.log
 */
function mountMcpRoutes(app, { handleMCPRequest, log }) {
  app.get('/mcp', (req, res) => {
    res.json({
      service: 'froggy-rag-mcp',
      protocol: 'JSON-RPC 2.0',
      post: '/mcp',
      note: 'Send MCP messages as JSON-RPC POST bodies to this path.'
    });
  });

  app.post('/mcp', async (req, res) => {
    try {
      const response = await handleMCPRequest(req.body);

      if (response === null) {
        return res.status(204).end();
      }

      if (response.error && response.error.code === -32600) {
        return res.status(400).json(response);
      }

      return res.json(response);
    } catch (error) {
      log('error', 'MCP Protocol request error', { error: error.message });
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Server error',
          data: error.message
        },
        id: null
      });
    }
  });
}

module.exports = { mountMcpRoutes };
