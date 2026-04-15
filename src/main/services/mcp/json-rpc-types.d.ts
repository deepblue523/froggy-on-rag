/**
 * JSON-RPC 2.0 and MCP-shaped types for the HTTP/stdio transport.
 * The runtime is JavaScript; this file provides editor/checker hints only.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: JsonRpcId;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Returned by the handler when the client sent a notification (no JSON body). */
export type MCPHandlerResult = JsonRpcResponse | null;

/** initialize params (MCP); fields optional for backward compatibility. */
export interface InitializeParams {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  clientInfo?: { name?: string; version?: string };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools: Record<string, unknown>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
  instructions: string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolsListResult {
  tools: McpToolDefinition[];
}

export interface ToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ToolsCallResult {
  content: TextContentBlock[];
  isError?: boolean;
}
