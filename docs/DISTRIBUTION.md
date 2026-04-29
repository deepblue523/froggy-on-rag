# Distribution Guide

This document explains how to create and use distribution packages for Froggy RAG MCP.

## Creating Distribution Packages

### Source Distribution Package

Creates a clean source code package in the `dist/` folder:

```bash
npm run dist
```

or

```bash
npm run dist:source
```

This will:
- Copy all source files (`src/`)
- Copy documentation (`docs/`)
- Copy `package.json` and `package-lock.json`
- Copy `README.md` and `USAGE.html`
- Create a distribution-specific `package.json` (without devDependencies)
- Create a `DISTRIBUTION.md` file with instructions

### NPM Package

Creates an npm package file (`.tgz`) in the `dist/` folder:

```bash
npm run dist:pack
```

This creates a package that can be installed via:
```bash
npm install ./dist/froggy-rag-mcp-1.0.0.tgz
```

### Electron Installers

Creates platform-specific installers using electron-builder:

```bash
npm run build
```

This creates installers in the `dist/` folder:
- **Windows**: `.exe` installer
- **macOS**: `.dmg` disk image
- **Linux**: `.AppImage`, `.deb`, `.rpm`, or `.snap` (depending on configuration)

## Running from Distribution Package

### From Source Distribution

1. Navigate to the distribution folder:
```bash
cd dist
```

2. Install dependencies:
```bash
npm install
```

3. Run the application:

**Electron App (GUI):**
```bash
npm start
```

**MCP Server (CLI - Stdio mode):**
```bash
npm run mcp-stdio
```

**MCP Server (CLI - Tool mode):**
```bash
npm run mcp search "your query"
```

### From Project Root (Development)

You can also run the distribution version directly from the project root after creating it:

**Electron App:**
```bash
node dist/src/main/main.js
```

However, it's recommended to use `npm start` from within the `dist` folder after running `npm install` there.

**MCP Server:**
```bash
node dist/src/cli/mcp-cli.js
```

or

```bash
npm run mcp
```

## Distribution Structure

After running `npm run dist`, the `dist/` folder will contain:

```
dist/
├── src/              # Source code
│   ├── cli/         # CLI interface
│   ├── main/        # Electron main process
│   └── renderer/    # Electron renderer process (UI)
├── docs/            # Documentation
├── package.json     # Distribution package.json (no devDependencies)
├── package-lock.json
├── README.md
├── USAGE.html
└── DISTRIBUTION.md  # This file
```

## Notes

- The source distribution does **not** include `node_modules`. Users must run `npm install` in the `dist` folder.
- The distribution `package.json` has devDependencies removed to reduce size.
- Electron installers created by `npm run build` are standalone executables that don't require Node.js to be installed.

