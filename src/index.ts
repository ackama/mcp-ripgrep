#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListRootsResultSchema,
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { access } from "fs/promises";
import path from "path";

interface Root {
  uri: string;
  name?: string;
}

class RipgrepServer {
  private server: Server;
  private availableRoots: Root[] = [];
  private defaultRipgrepArgs: string[] = ["--json", "--no-heading"];

  constructor() {
    this.server = new Server(
      {
        name: "mcp-ripgrep",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
          // Declare that we want to access roots
          roots: {
            listChanged: true,
          },
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "ripgrep_search",
            description: "Search for patterns using ripgrep across client-provided roots or specified path",
            inputSchema: {
              type: "object",
              properties: {
                pattern: {
                  type: "string",
                  description: "The pattern to search for (regex supported)",
                },
                max_results: {
                  type: "number",
                  description: "Maximum number of results to return",
                  default: 1000,
                },
                max_matched_files: {
                  type: "number",
                  description: "Maximum number of matched files to return",
                  default: 100,
                },
                path: {
                  type: "string",
                  description: "Optional specific path to search (defaults to all available roots)",
                },
                root_name: {
                  type: "string",
                  description: "Optional name of specific root to search in",
                },
                case_sensitive: {
                  type: "boolean",
                  description: "Whether the search should be case sensitive",
                  default: false,
                },
                context_lines: {
                  type: "number",
                  description: "Number of context lines to include around matches",
                  default: 0,
                },
              },
              required: ["pattern"], // Only pattern is required
            },
          },
          {
            name: "refresh_roots",
            description: "Refresh the list of available roots from the client",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === "ripgrep_search") {
        return await this.handleRipgrepSearch(args);
      } else if (name === "refresh_roots") {
        return await this.handleRefreshRoots();
      }

      throw new Error(`Unknown tool: ${name}`);
    });
  }

  private async requestRootsFromClient(): Promise<Root[]> {
    try {
      // Request roots from the client
      const response = await this.server.request<typeof ListRootsResultSchema>(
        { method: "roots/list" },
        ListRootsResultSchema
      );

      this.availableRoots = response.roots || [];
      return this.availableRoots;
    } catch (error) {
      console.error("Failed to get roots from client:", error);
      return [];
    }
  }

  private async handleRefreshRoots() {
    const roots = await this.requestRootsFromClient();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "Roots refreshed successfully",
              availableRoots: roots.map((root) => ({
                uri: root.uri,
                name: root.name,
                path: root.uri.replace("file://", ""),
              })),
              totalRoots: roots.length,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleRipgrepSearch(args: any) {
    const { pattern, path: specifiedPath, root_name, case_sensitive = false, context_lines = 0, max_results = 1000, max_matched_files = 100 } = args;

    if (!pattern) {
      throw new Error("Pattern is required");
    }

    // If no roots available, try to get them from client
    if (this.availableRoots.length === 0) {
      await this.requestRootsFromClient();
    }

    // Determine search paths
    let searchPaths: string[];

    if (specifiedPath) {
      // Use specified path
      searchPaths = [specifiedPath];
    } else if (root_name) {
      // Search in specific named root
      const targetRoot = this.availableRoots.find((root) => root.name === root_name);
      if (!targetRoot) {
        throw new Error(
          `Root '${root_name}' not found. Available roots: ${this.availableRoots.map((r) => r.name).join(", ")}`
        );
      }
      searchPaths = [targetRoot.uri.replace("file://", "")];
    } else if (this.availableRoots.length > 0) {
      // Use all available roots from client
      searchPaths = this.availableRoots.map((root) => root.uri.replace("file://", ""));
    } else {
      throw new Error(
        "No search paths available. The client has not provided any roots. Use refresh_roots tool or provide a specific path."
      );
    }

    // Validate all paths exist and are within allowed roots
    for (const searchPath of searchPaths) {
      try {
        await access(searchPath);

        // Validate path is within allowed roots (security check)
        if (this.availableRoots.length > 0) {
          const isWithinRoots = this.availableRoots.some((root) => {
            const rootPath = root.uri.replace("file://", "");
            const resolvedSearchPath = path.resolve(searchPath);
            const resolvedRootPath = path.resolve(rootPath);
            return resolvedSearchPath.startsWith(resolvedRootPath);
          });

          if (!isWithinRoots) {
            throw new Error(`Search path '${searchPath}' is not within any allowed root`);
          }
        }
      } catch (error: any) {
        throw new Error(`Search path validation failed for '${searchPath}': ${error.message}`);
      }
    }

    // Build ripgrep arguments
    const ripgrepArgs = [...this.defaultRipgrepArgs];

    if (!case_sensitive) {
      ripgrepArgs.push("--ignore-case");
    }

    if (context_lines > 0) {
      ripgrepArgs.push(`--context=${context_lines}`);
    }

    if (max_results > 0) {
      ripgrepArgs.push(`--max-results=${max_results}`);
    }

    if (max_matched_files > 0) {
      ripgrepArgs.push(`--max-matched-files=${max_matched_files}`);
    }

    ripgrepArgs.push(pattern);
    ripgrepArgs.push(...searchPaths);

    try {
      // Execute ripgrep
      const results = await this.executeRipgrep(ripgrepArgs);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                pattern,
                searchPaths: searchPaths.map((sp) => ({
                  path: sp,
                  rootName: this.availableRoots.find((r) => sp.startsWith(r.uri.replace("file://", "")))?.name,
                })),
                results: results,
                totalMatches: results.length,
                availableRoots: this.availableRoots.length,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Search failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async executeRipgrep(args: string[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const child = spawn("rg", args);
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (code === 0 || code === 1) {
          // 0 = matches found, 1 = no matches found
          try {
            // Parse JSON lines output from ripgrep
            const results = stdout
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => {
                try {
                  return JSON.parse(line);
                } catch {
                  return null;
                }
              })
              .filter(Boolean)
              .filter((result) => result.type === "match"); // Only keep match results

            resolve(results);
          } catch (error) {
            reject(new Error(`Failed to parse ripgrep output: ${error}`));
          }
        } else {
          reject(new Error(`Ripgrep failed with code ${code}: ${stderr}`));
        }
      });

      child.on("error", (error) => {
        reject(new Error(`Failed to execute ripgrep: ${error.message}`));
      });
    });
  }

  // Handle notifications about root changes from client
  private setupNotificationHandlers() {
    this.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
      console.error("Roots changed, refreshing...");
      await this.requestRootsFromClient();
    });
  }

  async run() {
    this.setupNotificationHandlers();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Request initial roots from client
    setTimeout(async () => {
      const roots = await this.requestRootsFromClient();
      console.error("MCP Ripgrep server running. Available roots:", roots.length);
      roots.forEach((root) => {
        console.error(`  - ${root.name || "Unnamed"}: ${root.uri}`);
      });
    }, 100);
  }
}

// Main execution
async function main() {
  const server = new RipgrepServer();
  await server.run();
}

main();
