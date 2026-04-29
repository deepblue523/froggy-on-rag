#!/usr/bin/env node

/**
 * Create a source distribution package
 * Copies necessary files to dist/ folder for distribution
 */

const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const projectRoot = path.join(__dirname, '..');

// Files and folders to copy
const filesToCopy = [
  'package.json',
  'package-lock.json',
  'README.md',
  'USAGE.html'
];

const dirsToCopy = [
  'src',
  'docs',
  'scripts'
];

// Files to exclude from src folder
const excludePatterns = [
  /\.map$/,
  /\.log$/,
  /\.tmp$/
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function copyFile(src, dest) {
  const destDir = path.dirname(dest);
  ensureDir(destDir);
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest, baseDir = '') {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const relativePath = path.join(baseDir, entry.name);

    // Skip excluded patterns
    if (excludePatterns.some(pattern => pattern.test(relativePath))) {
      continue;
    }

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, relativePath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

function createDistPackageJson() {
  const packageJsonPath = path.join(distDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // Remove devDependencies for distribution
  delete packageJson.devDependencies;

  // Update scripts to remove dev-only commands
  packageJson.scripts = {
    start: packageJson.scripts.start,
    mcp: packageJson.scripts.mcp,
    'mcp-stdio': packageJson.scripts['mcp-stdio']
  };

  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
}

function createDistReadme() {
  const readmePath = path.join(distDir, 'DISTRIBUTION.md');
  const readmeContent = `# Distribution Package

This is a source distribution of Froggy RAG MCP.

## Installation

1. Install dependencies:
\`\`\`bash
npm install
\`\`\`

2. The \`postinstall\` script will automatically rebuild native dependencies.

## Running the Application

### Electron App (GUI)
\`\`\`bash
npm start
\`\`\`

### MCP Server (CLI)
\`\`\`bash
# Stdio mode (for MCP clients)
npm run mcp-stdio

# Or CLI tool mode
npm run mcp search "your query"
\`\`\`

## Building Installers

To create platform-specific installers:
\`\`\`bash
npm run build
\`\`\`

This will create installers in the \`dist\` folder using electron-builder.

## Documentation

See README.md for full documentation.
`;

  fs.writeFileSync(readmePath, readmeContent);
}

// Main execution
console.log('Creating distribution package...');

// Clean dist folder (but preserve electron-builder outputs if they exist)
if (fs.existsSync(distDir)) {
  const entries = fs.readdirSync(distDir);
  for (const entry of entries) {
    const entryPath = path.join(distDir, entry);
    const stat = fs.statSync(entryPath);
    
    // Skip electron-builder outputs (installers, etc.)
    if (entry.endsWith('.exe') || entry.endsWith('.dmg') || entry.endsWith('.AppImage') || 
        entry.endsWith('.deb') || entry.endsWith('.rpm') || entry.endsWith('.zip') ||
        entry.endsWith('.snap') || entry === 'win-unpacked' || entry === 'mac' || entry === 'linux-unpacked') {
      continue;
    }
    
    if (stat.isDirectory()) {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(entryPath);
    }
  }
} else {
  ensureDir(distDir);
}

// Copy files
console.log('Copying files...');
for (const file of filesToCopy) {
  const srcPath = path.join(projectRoot, file);
  const destPath = path.join(distDir, file);
  if (fs.existsSync(srcPath)) {
    copyFile(srcPath, destPath);
    console.log(`  ✓ ${file}`);
  }
}

// Copy folders
console.log('Copying folders...');
for (const dir of dirsToCopy) {
  const srcPath = path.join(projectRoot, dir);
  const destPath = path.join(distDir, dir);
  if (fs.existsSync(srcPath)) {
    copyDir(srcPath, destPath);
    console.log(`  ✓ ${dir}/`);
  }
}

// Create distribution-specific package.json
console.log('Creating distribution package.json...');
createDistPackageJson();

// Create distribution README
console.log('Creating distribution README...');
createDistReadme();

console.log('\n✓ Distribution package created successfully!');
console.log(`\nLocation: ${distDir}`);
console.log('\nTo run from distribution:');
console.log('  1. cd dist');
console.log('  2. npm install');
console.log('  3. npm start (for Electron app) or npm run mcp (for CLI)');

