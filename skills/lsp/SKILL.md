---
name: lsp
description: MUST USE when navigating code symbols (definitions, references, hover, document/workspace symbols), performing semantic renames, checking code actions, or running compiler diagnostics across projects using `lsp` CLI (`vtsls`, `tsc`, `biome`, `ruff`, `cargo check`).
---

# LSP Code Intelligence, Symbols & Diagnostics Skill (v2.1+)

Use this skill for **symbol-level semantic navigation**, **project-wide symbol search**, **semantic refactoring (rename)**, and **fast compiler diagnostics** using the config-driven `lsp` CLI (`~/.local/bin/lsp`, configured via `~/.dsh/lsp.json`).

---

## 1. Reality Check: Language Support Matrix

Run `lsp servers` to inspect local availability:

| Language | Backend Engines | Reliability Level | Practical Guidance |
|---|---|---|---|
| **TypeScript / JavaScript** (`.ts`, `.tsx`, `.js`, `.jsx`) | `vtsls` + `biome` + project `tsc` | **Tier A (Fully Reliable)** | **Primary support**. Instant cross-file jump, full hover, workspace symbols, semantic rename, and project-pinned compiler checks. |
| **Python** (`.py`, `.pyi`) | `ty` + `ruff` | **Tier B (Lightweight)** | Fast linting, symbol navigation, and local hover via `ty` and `ruff`. |
| **Rust** (`.rs`) | `rust-analyzer` + `cargo check` | **Tier B (Cold-start Warning)** | Available (`rust-analyzer`), but initial crate indexing can take **10–60s**. Use `--timeout 40000` to prevent timeouts. |

---

## 2. Smart Targeting: Curing Column Positioning Failures

In previous versions, passing `file.ts:42` without a column or with `col: 1` caused the cursor to land on whitespace or keywords like `export`, resulting in `No definition found.`.

In **v2.1+**, `lsp` automatically resolves the target:
1. **Target by Symbol Name (`-s, --symbol <name>`)**:
   ```bash
   # Automatically locates 'getStoredProxy' on line 35 without counting columns
   lsp def src/index.ts:35 -s getStoredProxy
   ```
2. **Auto-snapping Column 1 / Omitted Column**:
   If `:col` is omitted or lands on whitespace, `lsp` automatically skips leading whitespace and declaration keywords (`export`, `declare`, `async`, `function`, `class`, `const`, `interface`, etc.) and snaps directly to the first identifier token on that line:
   ```bash
   lsp def src/index.ts:35       # Automatically snaps to 'initial' at col 9
   lsp hover src/index.ts:34     # Automatically snaps to 'apply' at col 17
   ```

---

## 3. High-Leverage Trio: Locate $\to$ Refactor $\to$ Gate

When performing refactorings or codebase exploration, follow this unified loop:

```
[Step 1: Explore & Enumerate]
     lsp symbols <file|query>   (Find symbols in file or across workspace)
     lsp ref <file:line> -s <symbol> --no-decl  (Find all call sites)
     │
     ▼
[Step 2: Safe Semantic Refactor / AST Rewrite]
     lsp rename <file:line> <newName> [-s <symbol>]        (Preview Dry-Run)
     lsp rename <file:line> <newName> --apply [-s <symbol>] (Apply in-place)
     OR
     ast-grep run -p 'PATTERN' -r 'REPLACEMENT' -U          (Structural transform)
     │
     ▼
[Step 3: Quality Gate Verification]
     lsp diag / lsp diag <file> -e
     │ (Verify zero hard errors; aborts on exit code 1)
```

---

## 4. Symbol Discovery (`lsp symbols`)

### 4.1 Document Symbol Outline
Extracts the complete hierarchical outline of interfaces, classes, functions, and variables defined in a file with line and column numbers:
```bash
# Display hierarchical symbol outline
lsp symbols src/index.ts

# Machine-readable JSON output
lsp symbols src/index.ts --json
```

### 4.2 Workspace Symbol Search
Searches across the entire repository for matching symbol definitions without reading individual files:
```bash
# Find where a symbol/type is declared across the whole workspace
lsp symbols AntigravityAuthConfig
lsp symbols Auth --limit 30
```

---

## 5. Semantic Rename (`lsp rename`) with 2-Phase Safety Commit

Semantic rename uses the language server's AST and type graph to update definitions and all references across files simultaneously.

### Phase 1: Preview / Dry-Run (Default)
```bash
lsp rename src/index.ts:35 tempInitial -s initial
```
Outputs proposed replacements and current code snippets across all affected files. **Files on disk remain 100% untouched.**

### Phase 2: Apply to Disk (`--apply`)
Append `--apply` only after verifying Phase 1 output:
```bash
lsp rename src/index.ts:35 tempInitial --apply -s initial
```
Applies edits atomically in reverse line order across all affected files.

---

## 6. Semantic Navigation Reference

Input format: `<file>:<line>[:<col>]` (1-based index).

- **Go to Definition (`lsp def`)**:
  ```bash
  lsp def src/index.ts:35 -s getStoredProxy
  lsp def src/auth-service.ts:98:24
  ```
- **Find References (`lsp ref`)**:
  ```bash
  lsp ref src/index.ts:34 -s apply --no-decl   # Drops declaration itself
  lsp ref src/types.ts:42:10 --limit 50        # Caps results (default 200)
  ```
- **Type Hover & Documentation (`lsp hover`)**:
  ```bash
  lsp hover src/index.ts:35 -s initial
  ```
- **Code Actions & Refactorings (`lsp action`)**:
  ```bash
  lsp action src/index.ts:34 -s apply
  ```

---

## 7. Diagnostics & Quality Gate (`lsp diag`)

`lsp diag` is an **exit-code-based verification gate**:
- **Exit Code `0`**: Clean or warnings-only. Safe to proceed.
- **Exit Code `1`**: **Hard errors detected**. Must be fixed before concluding tasks.

### 7.1 Single-File Diagnostics
Queries the file's active language server and linter concurrently:
```bash
lsp diag src/auth-service.ts
lsp diag src/auth-service.ts -e      # -e/--errors-only: omit warnings, report errors only
lsp diag src/auth-service.ts --json  # Structured JSON diagnostics
```

### 7.2 Project-Wide Compilation Gate
Scans for project roots (`tsconfig.json`, `Cargo.toml`, `pyproject.toml`) and prioritizes **project-pinned binaries** (e.g. `./node_modules/.bin/tsc`) over global ones to prevent version mismatches:
```bash
lsp diag                 # Current working directory
lsp diag packages/core   # Specific sub-project
```
