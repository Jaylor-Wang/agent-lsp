# agent-lsp

[![license](https://img.shields.io/github/license/Jaylor-Wang/agent-lsp.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/agent-lsp.svg)](https://github.com/Jaylor-Wang/agent-lsp/releases)
[![node version](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](package.json)

> **Lightweight, zero-dependency, config-driven Language Server Protocol (LSP) client & compiler diagnostics CLI built for AI coding agents and terminal workflows.**

`agent-lsp` provides real AST-grade language intelligence (definitions, references, type hover, document/workspace symbols, safe two-phase rename, code actions, and compiler diagnostics) over standard JSON-RPC 2.0 stdio language servers—without requiring an active IDE GUI.

---

## ✨ Key Features

- **🚀 Zero Runtime Dependencies**: Pure Node.js standard library implementation. Sub-millisecond cold start, minimal memory footprint.
- **🤖 Built for AI Agents**: Native support for DeepSeek Harness (DSH), OpenCodeInterpreter/OMP, Claude Code, Cursor, Windsurf, and custom terminal agent harnesses. Includes ready-to-use `SKILL.md`.
- **🎯 Smart Column Auto-Snapping**: Automatically skips declaration keywords (`export`, `default`, `async`, `function`, `class`, `const`, `interface`, etc.) and snaps column 1 directly onto the identifier token.
- **🔍 Symbol Targeting (`-s, --symbol <name>`)**: Locate symbols by name directly on any line without needing column calculation.
- **🌳 Symbols Navigation**: Document symbol outline hierarchy (`textDocument/documentSymbol`) and cross-workspace fuzzy symbol search (`workspace/symbol`).
- **🛡️ 2-Phase Atomic Rename**:
  - **Phase 1 (Dry-run proposal)**: Previews affected files and line diffs. Disk remains 100% untouched.
  - **Phase 2 (`--apply`)**: Reverse-range atomic disk mutations to preserve character offsets across files.
- **💡 Code Actions & Quick-Fixes**: Discover refactorings and compiler quick-fixes (`textDocument/codeAction`).
- **🩺 Multi-Compiler Diagnostics (`lsp diag`)**: Unifies file-level real-time LSP diagnostics with project-wide compiler sweeps (`vtsls`, `tsc`, `biome`, `ruff`, `ty`, `cargo check`).
- **⚙️ Config-Driven Registry**: Add, disable, or customize language servers via simple JSON configurations without touching engine code.

---

## 🛠️ Supported Language Servers

| Server | Languages | Capabilities |
| :--- | :--- | :--- |
| **`vtsls`** | TypeScript (`.ts`, `.tsx`), JavaScript (`.js`, `.jsx`) | def, ref, hover, symbols, rename, action, diag |
| **`biome`** | JS/TS, JSON, JSONC, CSS | fast lint diagnostics, formatting |
| **`rust-analyzer`** | Rust (`.rs`, `Cargo.toml`) | def, ref, hover, symbols, rename, action, diag |
| **`ty`** / **`ruff`** | Python (`.py`) | type diagnostics, linting, hover |

---

## 📦 Installation & Setup

### Option 1: Install directly from GitHub (Zero build step, immediate use)
```bash
npm install -g github:Jaylor-Wang/agent-lsp
# or
pnpm add -g github:Jaylor-Wang/agent-lsp
```

### Option 2: Clone & Link for Local Development
```bash
git clone https://github.com/Jaylor-Wang/agent-lsp.git
cd agent-lsp
npm link
```

Verify installation:
```bash
lsp --version
lsp servers
```

---

## 📖 Command Reference

### 1. Code Navigation & Inspection
```bash
# Jump to definition (auto-snaps column 1 to identifier)
lsp def src/index.ts:42

# Target specific symbol on a line
lsp def src/parser.ts:15 -s TokenStream

# Find references across codebase
lsp ref src/types.ts:10:5

# Hover type signatures and documentation
lsp hover src/client.ts:88:12
```

### 2. Symbol Navigation (`symbols`)
```bash
# View document outline tree (classes, functions, methods, properties)
lsp symbols src/lsp-cli.js

# Search workspace-wide symbols across the entire repository
lsp symbols -q "createClient"
lsp symbols -q "Config"
```

### 3. Safe Two-Phase Semantic Rename (`rename`)
```bash
# Phase 1: Dry-run proposal (preview diff, disk untouched)
lsp rename src/models.ts:12:8 UserProfile

# Target by symbol name
lsp rename src/models.ts:12 -s OldProfile UserProfile

# Phase 2: Persist changes across all referenced files
lsp rename src/models.ts:12:8 UserProfile --apply
```

### 4. Code Actions & Quick-Fixes (`action`)
```bash
# List available refactorings and compiler quick-fixes
lsp action src/app.ts:35:10

# Filter by diagnostic errors only
lsp action src/app.ts:35:10 -e
```

### 5. Diagnostics Gate (`diag`)
```bash
# Single file: Query active LSP server directly
lsp diag src/server.ts

# Project-wide sweep: Trigger project compiler/linter (tsc, cargo check, biome, etc.)
lsp diag
lsp diag src/
```

---

## ⚙️ Configuration Resolution

`agent-lsp` automatically looks for server configurations in the following priority order:

1. CLI flag: `--config <path>`
2. Environment variables: `$AGENT_LSP_CONFIG`, `$DSH_LSP_CONFIG`
3. Project root: `./.lsp.json`
4. DSH config: `~/.dsh/lsp.json`
5. OMP config: `~/.omp/agent/lsp.json`
6. System config: `~/.config/agent-lsp/lsp.json`
7. Bundled fallback: `config/lsp.default.json`

### Example `lsp.json`:
```json
{
  "servers": {
    "vtsls": {
      "command": "vtsls",
      "args": ["--stdio"],
      "fileTypes": [".ts", ".tsx", ".js", ".jsx"],
      "rootMarkers": ["tsconfig.json", "package.json", "vite.config.*"],
      "settings": {
        "vtsls.autoUseWorkspaceTsdk": true,
        "typescript.updateImportsOnFileMove.enabled": "always"
      }
    }
  }
}
```

---

## 🤖 Agent Harness Integration

For AI coding agents (DeepSeek Harness, OMP, Claude Code, etc.), point your agent to [`skills/lsp/SKILL.md`](skills/lsp/SKILL.md) to enable autonomous code navigation, refactoring, and verification gates.

---

## 📄 License

[MIT](LICENSE) © 2026 [Jaylor-Wang](https://github.com/Jaylor-Wang)
