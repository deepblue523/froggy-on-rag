#!/usr/bin/env node

/**
 * MCP CLI - Command-line interface for MCP server
 * Supports two modes:
 * 1. Stdio mode: MCP clients spawn as subprocess (default when no args)
 * 2. CLI tool mode: Direct command execution from terminal
 *
 * Global options (any position before or between command words):
 *   --namespace, -n <name>   Use ~/froggy-rag-mcp/data/<name>; create if missing.
 *   --data-path <path>       With --namespace: use this directory for DB/settings
 *                            (vector store, namespace.json). Create if missing.
 *                            Requires --namespace. If omitted, default data dir is used.
 */

const fs = require('fs');
const path = require('path');
const {
  ensureUserDataLayout,
  getResolvedDataDir,
  getDataDirForNamespace,
  isValidNamespaceName
} = require('../paths');

/**
 * Pull --namespace / --data-path out of argv; remaining tokens are the command.
 */
function extractGlobalOptions(argv) {
  let namespace = null;
  let dataPath = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--namespace' || a === '-n') {
      if (i + 1 >= argv.length) {
        console.error(`${a} requires a value`);
        process.exit(1);
      }
      namespace = argv[++i];
      continue;
    }
    if (a === '--data-path') {
      if (i + 1 >= argv.length) {
        console.error('--data-path requires a value');
        process.exit(1);
      }
      dataPath = argv[++i];
      continue;
    }
    if (a.startsWith('--namespace=')) {
      namespace = a.slice('--namespace='.length);
      continue;
    }
    if (a.startsWith('--data-path=')) {
      dataPath = a.slice('--data-path='.length);
      continue;
    }
    rest.push(a);
  }
  return { namespace, dataPath, rest };
}

function resolveCliDataDir(namespace, dataPath) {
  if (dataPath != null && dataPath !== '' && !namespace) {
    console.error('--data-path requires --namespace');
    process.exit(1);
  }
  if (namespace) {
    if (!isValidNamespaceName(namespace)) {
      console.error(
        'Invalid --namespace: use 1–64 chars, start with a letter or digit, then letters, digits, - or _'
      );
      process.exit(1);
    }
    if (dataPath != null && dataPath !== '') {
      const resolved = path.resolve(dataPath);
      fs.mkdirSync(resolved, { recursive: true });
      return resolved;
    }
    const dir = getDataDirForNamespace(namespace);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }
  return getResolvedDataDir();
}

ensureUserDataLayout();
const cliArgs = process.argv.slice(2);
const { namespace: cliNamespace, dataPath: cliDataPath, rest: cliRest } = extractGlobalOptions(cliArgs);
const dataDir = resolveCliDataDir(cliNamespace, cliDataPath);

// Initialize services
const { RAGService } = require('../main/services/rag-service');
const { MCPService } = require('../main/services/mcp-service');

async function main() {
  if (cliRest.length === 0) {
    await runStdioMode();
    return;
  }
  await runCLIToolMode(cliRest);
}

async function runStdioMode() {
  try {
    // Initialize services
    const ragService = new RAGService(dataDir);
    const mcpService = new MCPService(ragService);
    
    // Start stdio transport
    await mcpService.startStdio();
    
    // Keep process alive - stdio mode runs until stdin closes
    process.stdin.on('end', () => {
      process.exit(0);
    });
    
    process.stdin.on('error', (error) => {
      console.error('Stdin error:', error);
      process.exit(1);
    });
  } catch (error) {
    console.error('Error starting stdio mode:', error);
    process.exit(1);
  }
}

async function runCLIToolMode(args) {
  try {
    // Initialize services
    const ragService = new RAGService(dataDir);
    const mcpService = new MCPService(ragService);
    
    const command = args[0];
    
    switch (command) {
      case 'tools':
        if (args[1] === 'list') {
          await listTools(mcpService);
        } else {
          console.error('Unknown tools command. Use: tools list');
          process.exit(1);
        }
        break;
        
      case 'call':
        if (args.length < 2) {
          console.error('Usage: call <tool-name> [--arg key=value] ...');
          process.exit(1);
        }
        await callTool(mcpService, args.slice(1));
        break;
        
      case 'search':
        if (args.length < 2) {
          console.error('Usage: search <query> [--limit N] [--algorithm hybrid|bm25|tfidf|vector] [--web]');
          process.exit(1);
        }
        await callSearchTool(mcpService, args.slice(1));
        break;
        
      case 'stats':
        await callStatsTool(mcpService);
        break;
        
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Use --help for usage information');
        process.exit(1);
    }
    
    // Clean up and exit
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

async function listTools(mcpService) {
  const tools = await mcpService.listTools();
  console.log(JSON.stringify({ tools }, null, 2));
}

async function callTool(mcpService, args) {
  const toolName = args[0];
  const params = {};
  
  // Parse arguments in format: --arg key=value or --key value
  for (let i = 1; i < args.length; i++) {
    let key, value;
    
    if (args[i].startsWith('--')) {
      const arg = args[i].substring(2);
      if (arg.includes('=')) {
        [key, value] = arg.split('=', 2);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        key = arg;
        value = args[++i];
      } else {
        // Boolean flag
        key = arg;
        value = true;
      }
      
      // Parse value types
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (!isNaN(value) && value !== '') value = Number(value);
      
      params[key] = value;
    }
  }
  
  const result = await mcpService.callTool(toolName, params);
  console.log(JSON.stringify(result, null, 2));
}

async function callSearchTool(mcpService, args) {
  const query = args[0];
  const params = { query };
  
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) {
      params.limit = parseInt(args[++i], 10);
    } else if (args[i] === '--algorithm' && i + 1 < args.length) {
      params.algorithm = args[++i];
    } else if (args[i] === '--web') {
      params.webSearch = true;
    }
  }
  
  const result = await mcpService.callTool('search', params);
  console.log(JSON.stringify(result, null, 2));
}

async function callStatsTool(mcpService) {
  const result = await mcpService.callTool('get_stats', {});
  console.log(JSON.stringify(result, null, 2));
}

function printHelp() {
  console.log(`
MCP CLI - Command-line interface for MCP server

Usage:
  node src/cli/mcp-cli.js [options]                    # Stdio mode (MCP clients)
  node src/cli/mcp-cli.js [options] <command>         # CLI tool mode

Global options (can appear before or after the command name):
  --namespace, -n <name>   Data under ~/froggy-rag-mcp/data/<name> (created if missing).
                           If the folder already exists, it is used as-is.
  --data-path <path>       With --namespace: store vector DB and namespace.json in <path>
                           (absolute or relative to cwd). Created if missing.
                           Ignored without --namespace.

Examples:
  froggy-rag-mcp --namespace work
  froggy-rag-mcp -n work
  froggy-rag-mcp search "hello" -n work
  froggy-rag-mcp -n demo --data-path D:/rag-data stats

Commands:
  tools list                                  # List all available tools
  call <tool-name> [--arg key=value] ...     # Call a tool with parameters
  search <query> [--limit N] [--algorithm] [--web]  # Search (--web adds Google results)
  stats                                       # Get vector store statistics
  help                                        # Show this help message

More examples:
  # List all tools
  node src/cli/mcp-cli.js tools list

  # Call search tool
  node src/cli/mcp-cli.js call search --query "example query" --limit 5

  # Search directly
  node src/cli/mcp-cli.js search "example query" --limit 10

  # Get statistics
  node src/cli/mcp-cli.js stats

  # Ingest a file
  node src/cli/mcp-cli.js call ingest_file --filePath "/path/to/file.pdf"

Modes:
  - Stdio mode (no command after options): MCP via stdin/stdout
  - CLI tool mode: a command such as tools, call, search, stats, or help
`);
}

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Run main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

