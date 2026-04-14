# Froggy RAG MCP

A turnkey, integrated RAG (Retrieval Augmented Generation) system with MCP (Model Context Protocol) server and modern UI. This is a self-contained Electron application that provides a complete solution for document ingestion, vector storage, semantic search, optional live web search (Google Custom Search), and MCP server integration.

## Features

### 🔍 RAG System
- **Vector Store**: Built on SQLite, stored in `~/froggy-rag-mcp/data`
- **World-Class Chunking**: Supports `.docx`, `.xlsx`, `.pdf`, `.csv`, and `.txt` files
- **Queue-Based Processing**: Documents are processed in a queue, allowing semi-offline ingestion and chunking
- **Ingestion Status Tracking**: Real-time status monitoring for each document in the ingestion queue

### 📚 Document Management
- **File Ingestion**: Add individual files via drag-and-drop or file picker
- **Directory Ingestion**: Add entire directories for batch processing
- **File Watching**: Monitor files and directories for changes with automatic re-ingestion
- **Recursive Directory Watching**: Option to watch directories recursively

### 🔎 Search & Retrieval
- **Semantic Search**: World-class matching based on input queries and vector store
- **Optional Web Search**: When configured, Google Custom Search results are chunked and merged with vector-store hits so one query can rank local documents and the web together (UI toggle on the Search screen; `webSearch` on MCP/REST; `--web` in the CLI)
- **MRU (Most Recently Used)**: Quick access to recent searches
- **Chunk Inspection**: View content and metadata for retrieved chunks

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
- **Persistent Settings**: Window state, splitter positions, and preferences are saved (including optional web search credentials under **Settings → Web Search**)

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
cd froggy-nobs-mcp-rag
```

2. Install dependencies:
```bash
npm install
```

3. The `postinstall` script will automatically rebuild `better-sqlite3` for your platform.

## Usage

### Starting the Application

**Development mode** (with DevTools):
```bash
npm run dev
```

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
froggy-nobs-mcp-rag/
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
│   │       ├── search-service.js     # Semantic search
│   │       └── web-search-service.js # Google Custom Search (optional)
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

## MCP Server

The MCP server provides three interfaces for integration with external applications:
1. **REST API** - HTTP server for UI and external HTTP clients
2. **Stdio Mode** - Standard input/output for MCP clients (Claude Desktop, etc.)
3. **CLI Tool Mode** - Command-line interface for direct tool execution

### REST API

The REST server runs on a configurable port (default: 3000) and provides endpoints for:
- Document search (optional `webSearch: true` in the body merges in Google Custom Search when configured in the app)
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
      "args": ["path/to/froggy-nobs-mcp-rag/src/cli/mcp-cli.js"],
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

# Include web search in tool call (when Google Custom Search is configured)
npm run mcp call search --query "example query" --limit 5 --webSearch true

# Search directly (shortcut; add --web to include Google results when configured)
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
- `search <query> [--limit N] [--algorithm] [--web]` - Search the vector store (shortcut); `--web` merges Google Custom Search when configured
- `stats` - Get vector store statistics
- `help` - Show help message

**Examples:**
```bash
# List tools
node src/cli/mcp-cli.js tools list

# Search with hybrid algorithm
node src/cli/mcp-cli.js search "machine learning" --limit 10 --algorithm hybrid

# Same search, including web results (requires API key + CX in Settings → Web Search)
node src/cli/mcp-cli.js search "machine learning" --limit 10 --algorithm hybrid --web

# Get all documents
node src/cli/mcp-cli.js call get_documents

# Get chunks for a document
node src/cli/mcp-cli.js call get_document_chunks --documentId "doc-123"

# Ingest directory with watching
node src/cli/mcp-cli.js call ingest_directory --dirPath "/path/to/docs" --recursive true --watch true
```

### Available Tools

All modes support the same set of tools:
- `search` - Search the vector store for similar content; pass `webSearch: true` to merge Google Custom Search results when configured
- `get_documents` - Get all documents in the vector store
- `get_document_chunks` - Get chunks for a specific document
- `get_chunk` - Get chunk content by ID
- `get_stats` - Get vector store statistics
- `ingest_file` - Ingest a file into the vector store
- `ingest_directory` - Ingest a directory into the vector store

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
- **Service Layer**: Modular services for RAG, MCP, vector storage, search, and optional web search (Google Custom Search JSON API)

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues, questions, or feature requests, please open an issue on the repository.
