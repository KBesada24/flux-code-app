/**
 * CopilotTools - Filesystem tool definitions and execution for the GitHub Copilot adapter.
 *
 * Provides OpenAI-compatible tool schemas and Node.js-based execution of filesystem
 * operations within a sandboxed working directory.
 *
 * @module CopilotTools
 */
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenAIToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const COPILOT_TOOL_DEFINITIONS: OpenAIToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the text contents of a file within the working directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the working directory or absolute.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the provided text content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the working directory or absolute.",
          },
          content: {
            type: "string",
            description: "The text content to write to the file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List files and subdirectories at a given path. Skips node_modules, .git, and other build artifacts.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to list (default: working directory root).",
          },
          recursive: {
            type: "boolean",
            description: "List recursively (default: false).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Search for a text pattern across source files in the working directory.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "The text string to search for.",
          },
          path: {
            type: "string",
            description: "File or directory to search within (default: working directory).",
          },
          case_sensitive: {
            type: "boolean",
            description: "Case-sensitive search (default: false).",
          },
        },
        required: ["pattern"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

/**
 * Returns a system prompt that tells the model about its filesystem tools
 * and the working directory it operates in.
 */
export function buildCopilotSystemPrompt(cwd: string): string {
  return [
    "You are an expert coding assistant with direct access to the user's filesystem.",
    `Working directory: ${cwd}`,
    "",
    "You have the following filesystem tools available:",
    "  - read_file: Read the contents of a file",
    "  - write_file: Create or overwrite a file",
    "  - list_directory: List files and subdirectories",
    "  - search_code: Search for text patterns in files",
    "",
    "Use these tools to explore and modify the codebase as needed.",
    "Always read existing files before modifying them.",
    "File paths may be relative to the working directory or absolute.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Path Sandboxing
// ---------------------------------------------------------------------------

/**
 * Resolves a user-supplied path against cwd and validates it stays within cwd.
 * Returns the resolved absolute path, or null if the path escapes the working directory.
 */
export function safePath(cwd: string, input: string): string | null {
  const normalizedCwd = path.resolve(cwd);
  const resolved = path.resolve(normalizedCwd, input);
  if (resolved !== normalizedCwd && !resolved.startsWith(normalizedCwd + path.sep)) {
    return null;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Tool Dispatcher
// ---------------------------------------------------------------------------

/**
 * Executes a named filesystem tool and returns a string result.
 * Errors are returned as "Error: ..." strings rather than thrown, so the model
 * can see them as tool results.
 */
export async function executeCopilotTool(
  cwd: string,
  name: string,
  args: unknown,
): Promise<string> {
  switch (name) {
    case "read_file":
      return readFileTool(cwd, args);
    case "write_file":
      return writeFileTool(cwd, args);
    case "list_directory":
      return listDirectoryTool(cwd, args);
    case "search_code":
      return searchCodeTool(cwd, args);
    default:
      return `Error: Unknown tool '${name}'.`;
  }
}

// ---------------------------------------------------------------------------
// Tool Implementations
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 500_000;

async function readFileTool(cwd: string, args: unknown): Promise<string> {
  const a = args as Record<string, unknown>;
  const filePath = typeof a?.path === "string" ? a.path : null;
  if (!filePath) return "Error: 'path' argument is required.";

  const safe = safePath(cwd, filePath);
  if (!safe) return `Error: Path '${filePath}' is outside the working directory.`;

  try {
    const stat = await fs.promises.stat(safe);
    if (stat.size > MAX_FILE_BYTES) {
      return `Error: File exceeds ${MAX_FILE_BYTES} byte read limit (file size: ${stat.size} bytes).`;
    }
    return await fs.promises.readFile(safe, "utf-8");
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function writeFileTool(cwd: string, args: unknown): Promise<string> {
  const a = args as Record<string, unknown>;
  const filePath = typeof a?.path === "string" ? a.path : null;
  const content = typeof a?.content === "string" ? a.content : null;
  if (!filePath) return "Error: 'path' argument is required.";
  if (content === null) return "Error: 'content' argument is required.";

  const safe = safePath(cwd, filePath);
  if (!safe) return `Error: Path '${filePath}' is outside the working directory.`;

  try {
    await fs.promises.mkdir(path.dirname(safe), { recursive: true });
    await fs.promises.writeFile(safe, content, "utf-8");
    return `Successfully wrote ${content.length} character(s) to '${filePath}'.`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  "dist",
  "out",
  ".next",
  "build",
  ".turbo",
  "coverage",
]);
const MAX_DEPTH = 8;
const MAX_LIST_ENTRIES = 500;

async function listDirectoryTool(cwd: string, args: unknown): Promise<string> {
  const a = (args as Record<string, unknown>) ?? {};
  const dirPath = typeof a.path === "string" ? a.path : ".";
  const recursive = a.recursive === true;

  const safe = safePath(cwd, dirPath);
  if (!safe) return `Error: Path '${dirPath}' is outside the working directory.`;

  try {
    const entries = await collectEntries(safe, safe, recursive, 0);
    if (entries.length === 0) return "(empty directory)";
    return entries.join("\n");
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function collectEntries(
  rootDir: string,
  dir: string,
  recursive: boolean,
  depth: number,
): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const entries: string[] = [];
  let items: fs.Dirent[];
  try {
    items = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const item of items) {
    if (entries.length >= MAX_LIST_ENTRIES) break;
    if (item.name.startsWith(".") && depth === 0) continue;
    if (item.isDirectory() && SKIP_DIRS.has(item.name)) continue;
    const fullPath = path.join(dir, item.name);
    const relPath = path.relative(rootDir, fullPath);
    if (item.isDirectory()) {
      entries.push(`${relPath}/`);
      if (recursive) {
        const children = await collectEntries(rootDir, fullPath, true, depth + 1);
        const remaining = MAX_LIST_ENTRIES - entries.length;
        entries.push(...children.slice(0, remaining));
      }
    } else {
      entries.push(relPath);
    }
  }
  return entries;
}

const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_FILES = 500;

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".jsonc", ".yaml", ".yml",
  ".md", ".txt", ".html", ".css", ".scss", ".less",
  ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".cs",
  ".sh", ".bash", ".zsh", ".fish",
  ".toml", ".ini", ".cfg", ".conf",
  ".env", ".envrc", ".lock",
  ".sql", ".graphql", ".proto",
]);

async function searchCodeTool(cwd: string, args: unknown): Promise<string> {
  const a = (args as Record<string, unknown>) ?? {};
  const pattern = typeof a.pattern === "string" ? a.pattern : null;
  const searchPath = typeof a.path === "string" ? a.path : ".";
  const caseSensitive = a.case_sensitive === true;
  if (!pattern) return "Error: 'pattern' argument is required.";

  const safe = safePath(cwd, searchPath);
  if (!safe) return `Error: Path '${searchPath}' is outside the working directory.`;

  const results: string[] = [];
  const filesScanned = { count: 0 };

  try {
    await searchInPath(safe, safe, pattern, caseSensitive, results, filesScanned);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (results.length === 0) return `No matches found for "${pattern}".`;
  const shown = results.slice(0, MAX_SEARCH_RESULTS);
  const extra =
    results.length > MAX_SEARCH_RESULTS
      ? `\n... ${results.length - MAX_SEARCH_RESULTS} more result(s) omitted.`
      : "";
  return shown.join("\n") + extra;
}

async function searchInPath(
  rootDir: string,
  target: string,
  pattern: string,
  caseSensitive: boolean,
  results: string[],
  filesScanned: { count: number },
): Promise<void> {
  if (results.length >= MAX_SEARCH_RESULTS || filesScanned.count >= MAX_SEARCH_FILES) return;

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(target);
  } catch {
    return;
  }

  if (stat.isFile()) {
    filesScanned.count++;
    const ext = path.extname(target).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) return;
    if (stat.size > MAX_FILE_BYTES) return;
    let content: string;
    try {
      content = await fs.promises.readFile(target, "utf-8");
    } catch {
      return;
    }
    const lines = content.split("\n");
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
      const line = lines[i] ?? "";
      const haystack = caseSensitive ? line : line.toLowerCase();
      if (haystack.includes(needle)) {
        const relPath = path.relative(rootDir, target);
        results.push(`${relPath}:${i + 1}: ${line.trim()}`);
      }
    }
    return;
  }

  if (stat.isDirectory()) {
    const name = path.basename(target);
    if (SKIP_DIRS.has(name) || name.startsWith(".")) return;
    let items: fs.Dirent[];
    try {
      items = await fs.promises.readdir(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (results.length >= MAX_SEARCH_RESULTS || filesScanned.count >= MAX_SEARCH_FILES) break;
      await searchInPath(
        rootDir,
        path.join(target, item.name),
        pattern,
        caseSensitive,
        results,
        filesScanned,
      );
    }
  }
}
