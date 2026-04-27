# Froggy RAG MCP

A turnkey, integrated RAG (Retrieval Augmented Generation) system with MCP (Model Context Protocol) server and modern UI. This is a self-contained Electron application that provides a complete solution for document ingestion, vector storage, semantic search, and MCP server integration. With LLM Passthrough and optional inbound HTTP listeners enabled under Settings → Server, the app can also act as a local passthrough: it accepts Ollama-style or OpenAI-compatible chat requests, retrieves from your corpora, and injects that context into the upstream LLM call so existing HTTP clients get RAG without orchestrating MCP tools. Clients that prefer explicit retrieval can still use MCP tools such as `search_vector_store` and `list_namespaces`.

## Features

### 🔍 RAG System
- **Vector Store**: Built on SQLite, stored in `~/froggy-rag-mcp/data`
- **World-Class Chunking**: Supports `.docx`, `.xlsx`, `.pdf`, `.csv`, `.txt`, `.html`, `.md`, `.markdown`, `.mdx`, and related formats
- **Queue-Based Processing**: Documents are processed in a queue, allowing semi-offline ingestion and chunking
- **Ingestion Status Tracking**: Real-time status monitoring for each document in the ingestion queue

### 📚 Document Management
- **File Ingestion**: Add individual files via drag-and-drop or file picker
- **Directory Ingestion**: Add entire directories for batch processing
- **File Watching**: Monitor files and directories for changes with automatic re-ingestion
- **Recursive Directory Watching**: Option to watch directories recursively

### 🔎 Search & Retrieval
- **Semantic Search**: World-class matching based on input queries and vector store
- **MRU (Most Recently Used)**: Quick access to recent searches
- **Chunk Inspection**: View content and metadata for retrieved chunks

### 🤖 LLM Passthrough (RAG on chat completions)

- **Local API surface**: With passthrough enabled, the app listens on configurable ports and proxies chat to your configured **upstream** (Ollama or OpenAI-compatible), after augmenting requests with retrieval from the active namespace or headers you send.
- **Per-provider settings**: Separate base URL, model, and API key for Ollama vs OpenAI-style upstreams (see **Settings → Server**).
- **Complements MCP**: MCP clients continue to use tools such as `search_vector_store`; passthrough is for HTTP clients that expect a normal **chat completions** endpoint with retrieval applied automatically.

### 🌐 MCP Server
- **Dual Interfaces**: Both stdio and REST API interfaces
- **RAG Tools**: Specialized tools for RAG operations
- **Server Management**: Start/stop server with configurable port
- **Request Logging**: Comprehensive logging of server requests and activities

### 🎨 User Interface
- **Modern Design**: Clean, intuitive interface with resizable panels
- **Tree Navigation**: Organized navigation with four main sections:
  - **Ingestion**: Manage files and directories
  - **Vector Store**: View documents, chunks, and metadata
  - **Search**: Perform semantic searches with MRU support
  - **Server**: Control MCP server and view logs
- **Persistent Settings**: Window state, splitter positions, and preferences are saved

## Installation

### Pre-built Releases

Download the latest pre-built installer from our [releases page](https://github.com/deepblue523/froggy-mcp-rag/releases).

### Manual Setup

#### Prerequisites
- Node.js (v16 or higher)
- npm or yarn

#### Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd froggy-rag-mcp
```

2. Install dependencies:
```bash
npm install
```

3. The `postinstall` script rebuilds native modules (`better-sqlite3`, `sharp`) for the **installed Electron version** so they match the app runtime (not system Node).

## Usage

### Starting the Application

**Development mode**:
```bash
npm run dev
```

To open DevTools automatically, launch Electron with `--open-devtools`.

**Production mode**:
```bash
npm start
```

### Building for Distribution

```bash
npm run build
```

This will create distributable packages in the `dist` directory using electron-builder.

## Application Structure

```
froggy-rag-mcp/
├── src/
│   ├── main/              # Electron main process
│   │   ├── main.js        # Main entry point
│   │   ├── preload.js     # Preload script
│   │   ├── ipc-handlers.js # IPC communication handlers
│   │   └── services/      # Core services
│   │       ├── rag-service.js        # RAG orchestration
│   │       ├── mcp-service.js        # MCP server implementation
│   │       ├── vector-store.js       # SQLite vector store
│   │       ├── document-processor.js # Document parsing & chunking
│   │       └── search-service.js     # Semantic search
│   └── renderer/          # Electron renderer process (UI)
│       ├── index.html     # Main HTML
│       ├── app.js         # UI logic
│       └── styles.css     # Styling
├── docs/                  # Documentation
└── package.json
```

## Data Storage

All application data is stored in:
```
~/froggy-rag-mcp/data/
```

This includes:
- Vector store database (SQLite)
- Settings and preferences
- Window state
- Watched files and directories configuration

## Supported File Formats

- **Microsoft Word**: `.docx`
- **Microsoft Excel**: `.xlsx`
- **PDF**: `.pdf`
- **CSV**: `.csv`
- **Plain Text**: `.txt`
- **HTML**: `.html`, `.htm`
- **Markdown**: `.md`, `.markdown`, `.mdx`

## MCP Server

The MCP server provides three interfaces for integration with external applications:
1. **REST API** - HTTP server for UI and external HTTP clients
2. **Stdio Mode** - Standard input/output for MCP clients (Claude Desktop, etc.)
3. **CLI Tool Mode** - Command-line interface for direct tool execution

### REST API

The REST server runs on a configurable port (default: 3000) and provides endpoints for:
- Corpus search over the vector store
- Vector store operations
- RAG queries

Start/stop the server from the UI, configure the server port, and view real-time logs of server activity.

### Stdio Mode (For MCP Clients)

Stdio mode allows MCP clients (like Claude Desktop) to spawn the server as a subprocess and communicate via stdin/stdout using JSON-RPC 2.0 protocol.

**Usage:**
```bash
# Run in stdio mode (no arguments)
npm run mcp-stdio

# Or directly
node src/cli/mcp-cli.js
```

**Configuration for MCP Clients:**

For Claude Desktop, add to your MCP configuration file:
```json
{
  "mcpServers": {
    "froggy-rag": {
      "command": "node",
      "args": ["path/to/froggy-rag-mcp/src/cli/mcp-cli.js"],
      "env": {}
    }
  }
}
```

The server reads JSON-RPC 2.0 messages line-by-line from stdin and writes responses to stdout.

### CLI Tool Mode

CLI tool mode allows you to execute MCP tools directly from the command line.

**Usage:**
```bash
# List all available tools
npm run mcp tools list

# Call a tool with parameters
npm run mcp call search --query "example query" --limit 5

# Search directly (shortcut for vector search)
npm run mcp search "example query" --limit 10 --algorithm hybrid

# Get statistics
npm run mcp stats

# Ingest a file
npm run mcp call ingest_file --filePath "/path/to/file.pdf"

# Get help
npm run mcp help
```

**Commands:**
- `tools list` - List all available tools
- `call <tool-name> [--arg key=value] ...` - Call a tool with parameters
- `search <query> [--limit N] [--algorithm]` - Search the vector store (shortcut)
- `stats` - Get vector store statistics
- `help` - Show help message

**Examples:**
```bash
# List tools
node src/cli/mcp-cli.js tools list

# Search with hybrid algorithm
node src/cli/mcp-cli.js search "machine learning" --limit 10 --algorithm hybrid

# Get all documents
node src/cli/mcp-cli.js call get_documents

# Get chunks for a document
node src/cli/mcp-cli.js call get_document_chunks --documentId "doc-123"

# Ingest directory with watching
node src/cli/mcp-cli.js call ingest_directory --dirPath "/path/to/docs" --recursive true --watch true
```

### Available Tools (MCP protocol)

The MCP server (`tools/list` / stdio / JSON-RPC) exposes:

- `search_vector_store` — Semantic search over the vector store (`topK`, optional `namespace`, optional `filters` such as algorithm)
- `get_document` — Fetch a document by ID (optional `namespace`)
- `get_chunk` — Fetch a chunk by ID (optional `namespace`)
- `list_documents` — Paginated document list (optional `namespace`)
- `list_namespaces` — List corpus namespaces on disk

The **CLI** accepts `call search` as shorthand for `search_vector_store`, and `call get_documents` for `list_documents`. Commands such as **`call ingest_file`**, **`call ingest_directory`**, **`stats`**, and **`get_document_chunks`** use the local RAG service directly; they are **not** advertised as MCP tools to remote MCP clients.

For **chat with automatic retrieval**, use **LLM Passthrough** and the inbound HTTP endpoints in the app, not an MCP tool.

### Server Management

- Start/stop the REST server from the UI
- Configure the server port
- View real-time logs of server activity
- Stdio and CLI modes run independently of the Electron UI

## Development

### Key Technologies

- **Electron**: Desktop application framework
- **@xenova/transformers**: Embedding model (Xenova/all-MiniLM-L6-v2)
- **better-sqlite3**: Vector store database
- **Express**: REST API server
- **chokidar**: File system watching
- **pdf-parse, mammoth, exceljs, docx**: Document parsing libraries

### Architecture

- **Main Process**: Handles file system operations, database access, and service orchestration
- **Renderer Process**: UI rendering and user interaction
- **IPC Communication**: Secure communication between main and renderer processes
- **Service Layer**: Modular services for RAG, MCP, vector storage, and search

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues, questions, or feature requests, please open an issue on the repository.
