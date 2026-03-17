#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EbaySellerApi } from '@/api/index.js';
import { getEbayConfig, mcpConfig, validateEnvironmentConfig } from '@/config/environment.js';
import { getToolDefinitions, executeTool } from '@/tools/index.js';
import { serverLogger, toolLogger, getLogPaths } from '@/utils/logger.js';
import { checkForUpdates } from '@/utils/version.js';

checkForUpdates({ defer: true });

const args = process.argv.slice(2);
if (args.includes('setup')) {
  try {
    const { runSetup } = await import('./scripts/setup.js');
    await runSetup();
    process.exit(0);
  } catch (error) {
    console.error('Setup failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * eBay API MCP Server
 * Provides access to eBay APIs through Model Context Protocol
 */
class EbayMcpServer {
  private server: McpServer;
  private api: EbaySellerApi;

  constructor() {
    this.server = new McpServer(mcpConfig);

    // Initialize eBay API client
    this.api = new EbaySellerApi(getEbayConfig());
    this.setupHandlers();
    this.setupErrorHandling();
  }

  /**
   * Initialize the API (load tokens from storage)
   */
  private async initialize(): Promise<void> {
    await this.api.initialize();
  }

  private setupHandlers(): void {
    const tools = getToolDefinitions();

    serverLogger.info(`Registering ${tools.length} tools`);

    // Register each tool with the MCP server
    for (const toolDef of tools) {
      this.server.registerTool(
        toolDef.name,
        {
          description: toolDef.description,
          inputSchema: toolDef.inputSchema,
        },
        async (args: Record<string, unknown>) => {
          toolLogger.debug(`Executing tool: ${toolDef.name}`, { args });
          try {
            const result = await executeTool(this.api, toolDef.name, args);
            toolLogger.debug(`Tool ${toolDef.name} completed successfully`);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            toolLogger.error(`Tool ${toolDef.name} failed`, { error: errorMessage });

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: errorMessage }, null, 2),
                },
              ],
              isError: true,
            };
          }
        }
      );
    }
  }

  private setupErrorHandling(): void {
    process.on('SIGINT', async () => {
      serverLogger.info('Received SIGINT, shutting down...');
      await this.server.close();
      process.exit(0);
    });
  }

  async run(): Promise<void> {
    serverLogger.info('Starting eBay API MCP Server');

    // Validate environment configuration
    const validation = validateEnvironmentConfig();

    // Log warnings
    if (validation.warnings.length > 0) {
      validation.warnings.forEach((warning) => {
        serverLogger.warn(warning);
      });
    }

    // Log errors and exit if configuration is invalid
    if (!validation.isValid) {
      validation.errors.forEach((error) => {
        serverLogger.error(error);
      });
      serverLogger.error('Please fix the configuration errors and restart the server.');
      process.exit(1);
    }

    // Initialize API (load tokens from storage)
    serverLogger.info('Initializing API client');
    await this.initialize();

    // Log log file locations if file logging is enabled
    if (process.env.EBAY_ENABLE_FILE_LOGGING === 'true') {
      const paths = getLogPaths();
      serverLogger.info('File logging enabled', {
        logDir: paths.logDir,
        errorLog: paths.errorLog,
        combinedLog: paths.combinedLog,
      });
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    serverLogger.info('eBay API MCP Server running on stdio');
  }
}

// Start the server
const server = new EbayMcpServer();
server.run().catch((error) => {
  serverLogger.error('Fatal error running server', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
