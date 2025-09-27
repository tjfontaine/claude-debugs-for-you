import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Helper functions
function nowIso() {
    return new Date().toISOString();
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
        promise.then(v => { clearTimeout(timeout); resolve(v); }, e => { clearTimeout(timeout); reject(e); });
    });
}

// Try to read port from config file, fallback to default
function getPortFromConfig(): number {
    try {
        // Determine the global storage path based on platform
        let storagePath: string;
        const homeDir = os.homedir();
        
        if (process.platform === 'darwin') {
            storagePath = path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'jasonmcghee.claude-debugs-for-you');
        } else if (process.platform === 'win32') {
            storagePath = path.join(homeDir, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'jasonmcghee.claude-debugs-for-you');
        } else {
            // Linux and others
            storagePath = path.join(homeDir, '.config', 'Code', 'User', 'globalStorage', 'jasonmcghee.claude-debugs-for-you');
        }
        
        const configPath = path.join(storagePath, 'port-config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config && typeof config.port === 'number') {
                return config.port;
            }
        }
    } catch (error) {
        console.error('Error reading port config:', error);
    }
    
    return 4711; // Default port
}

async function makeRequest(payload: any): Promise<any> {
    const port = getPortFromConfig();
    
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        
        const req = http.request({
            hostname: 'localhost',
            port,
            path: '/tcp',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(body);
                    if (!response.success) {
                        reject(new Error(response.error || 'Unknown error'));
                    } else {
                        resolve(response.data);
                    }
                } catch (err) {
                    reject(err);
                }
            });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

const server = new Server(
    {
        name: "mcp-debug-server",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
            resources: {
                subscribe: true,
                listChanged: true
            },
            prompts: {
                listChanged: true
            }
        },
    }
);

const debugDescription = `Execute a debug plan with breakpoints, launch, continues, and expression 
evaluation. ONLY SET BREAKPOINTS BEFORE LAUNCHING OR WHILE PAUSED. Be careful to keep track of where 
you are in your execution path and what is currently available to see the state. 
If you set a breakpoint but didn't hit it, check the stacktrace on the exception to see what you've missed, what line you're on etc.
If you can't debug directly, set breakpoints, launch, see what happens, and build up your understanding from there.`;

const listFilesDescription = "List all files in the workspace. Use this to find any requested files.";

const getFileContentDescription = `Get file content with line numbers - you likely need to list files 
to understand what files are available. Be careful to use absolute paths.`;

// Zod schemas for the tools
const listFilesInputSchema = {
    includePatterns: z.array(z.string()).describe("Glob patterns to include (e.g. ['**/*.js'])").optional(),
    excludePatterns: z.array(z.string()).describe("Glob patterns to exclude (e.g. ['node_modules/**'])").optional(),
};

const getFileContentInputSchema = {
    path: z.string().describe("Path to the file. IT MUST BE AN ABSOLUTE PATH AND MATCH THE OUTPUT OF listFiles"),
};

const debugStepSchema = z.object({
    type: z.enum(["setBreakpoint", "removeBreakpoint", "continue", "evaluate", "launch"]).describe(""),
    file: z.string().optional(),
    line: z.number().optional(),
    expression: z.string().describe("An expression to be evaluated in the stack frame of the current breakpoint").optional(),
    condition: z.string().describe("If needed, a breakpoint condition may be specified to only stop on a breakpoint for some given condition.").optional(),
    timeoutMs: z.number().describe("Optional timeout in milliseconds for this step").optional(),
}).refine((data) => {
    // Validation rules based on step type
    if (data.type === 'setBreakpoint') {
        return data.file && data.line !== undefined;
    }
    if (data.type === 'removeBreakpoint') {
        return data.line !== undefined;
    }
    if (data.type === 'evaluate') {
        return data.expression;
    }
    if (data.type === 'launch') {
        return data.file;
    }
    return true; // continue doesn't need additional fields
}, {
    message: "Missing required fields for step type"
});

const debugInputSchema = {
    steps: z.array(debugStepSchema),
};

// Main tools array with Zod schemas
const tools = [
    {
        name: "listFiles",
        description: listFilesDescription,
        inputSchema: listFilesInputSchema,
    },
    {
        name: "getFileContent", 
        description: getFileContentDescription,
        inputSchema: getFileContentInputSchema,
    },
    {
        name: "debug",
        description: debugDescription,
        inputSchema: debugInputSchema,
    }
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { 
        tools: [
            ...tools,
            // Additional granular debug tools
            {
                name: "debug.status",
                description: "Get current debug session status and thread information",
                inputSchema: {}
            },
            {
                name: "debug.evaluate", 
                description: "Evaluate a single expression in the current debug context",
                inputSchema: {
                    expression: z.string().describe("The expression to evaluate")
                }
            },
            {
                name: "debug.listBreakpoints",
                description: "List all current breakpoints", 
                inputSchema: {}
            },
            {
                name: "debug.getLogs",
                description: "Get recent debug server logs",
                inputSchema: {
                    level: z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical']).optional().describe("Filter by log level"),
                    limit: z.number().optional().describe("Maximum number of log entries to return (default: 100)")
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const toolName = request.params.name;
        const args = request.params.arguments;

        // Handle the additional granular debug tools
        if (toolName === 'debug.status') {
            const result = await makeRequest({
                method: 'debug.status',
                params: {}
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }
                ]
            };
        }

        if (toolName === 'debug.evaluate') {
            const result = await makeRequest({
                method: 'debug.evaluate',
                params: args
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }
                ]
            };
        }

        if (toolName === 'debug.listBreakpoints') {
            const result = await makeRequest({
                method: 'debug.listBreakpoints',
                params: {}
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }
                ]
            };
        }

        if (toolName === 'debug.getLogs') {
            const result = await makeRequest({
                method: 'debug.getLogs',
                params: args
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }
                ]
            };
        }

        // Handle the main tools
        const result = await makeRequest({
            method: toolName,
            params: args
        });
        
        return {
            content: [
                {
                    type: "text",
                    text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
                }
            ]
        };
    } catch (error: any) {
        return {
            content: [
                {
                    type: "text", 
                    text: `Error: ${error.message}`
                }
            ]
        };
    }
});

// Setup MCP resources for debug state information
server.resource("debug-session", "debug://session/current", async () => {
    try {
        const result = await makeRequest({
            method: 'getDebugStatus',
            params: {}
        });
        return {
            contents: [{
                uri: "debug://session/current",
                text: JSON.stringify(result, null, 2),
                mimeType: "application/json"
            }]
        };
    } catch (error: any) {
        return {
            contents: [{
                uri: "debug://session/current",
                text: JSON.stringify({ error: error.message }, null, 2),
                mimeType: "application/json"
            }]
        };
    }
});

server.resource("debug-breakpoints", "debug://breakpoints/all", async () => {
    try {
        const result = await makeRequest({
            method: 'listBreakpoints',
            params: {}
        });
        return {
            contents: [{
                uri: "debug://breakpoints/all",
                text: JSON.stringify(result, null, 2),
                mimeType: "application/json"
            }]
        };
    } catch (error: any) {
        return {
            contents: [{
                uri: "debug://breakpoints/all",
                text: JSON.stringify({ error: error.message }, null, 2),
                mimeType: "application/json"
            }]
        };
    }
});

server.resource("debug-events", "debug://events/recent", async () => {
    try {
        const result = await makeRequest({
            method: 'getDebugEvents',
            params: {}
        });
        return {
            contents: [{
                uri: "debug://events/recent",
                text: JSON.stringify({
                    version: 1,
                    events: result || [],
                    timestamp: nowIso()
                }, null, 2),
                mimeType: "application/json"
            }]
        };
    } catch (error: any) {
        return {
            contents: [{
                uri: "debug://events/recent",
                text: JSON.stringify({
                    version: 1,
                    events: [],
                    error: error.message,
                    timestamp: nowIso()
                }, null, 2),
                mimeType: "application/json"
            }]
        };
    }
});

// Setup MCP prompts for debugging assistance
server.prompt("debug-strategy", "Generate a debugging strategy based on current state", {
    error: z.string().describe("Error message or description of the problem"),
    language: z.string().optional().describe("Programming language (e.g., javascript, python)")
}, async (args) => {
    try {
        const currentSession = await makeRequest({
            method: 'getDebugStatus',
            params: {}
        });
        
        const prompt = `Based on the current debug session state and the error "${args.error}", here's a suggested debugging strategy:

**Current Debug State:**
${JSON.stringify(currentSession, null, 2)}

**Recommended Debugging Steps:**
1. First, examine the current call stack and variable values
2. Set strategic breakpoints at key decision points
3. Step through the code execution to understand the flow
4. Evaluate expressions to check intermediate values
5. Look for common issues in ${args.language || 'the current language'}

**Key Things to Check:**
- Variable values and types
- Conditional logic paths
- Loop boundaries and exit conditions
- Function return values
- Error handling paths`;

        return {
            messages: [{
                role: "user",
                content: {
                    type: "text",
                    text: prompt
                }
            }]
        };
    } catch (error: any) {
        return {
            messages: [{
                role: "user", 
                content: {
                    type: "text",
                    text: `Error generating debug strategy: ${error.message}`
                }
            }]
        };
    }
});

server.prompt("debug-evaluation", "Generate expressions to evaluate at current breakpoint", {
    context: z.string().describe("Current context or what you're trying to understand"),
    language: z.string().optional().describe("Programming language for syntax")
}, async (args) => {
    const prompt = `At the current breakpoint, here are some useful expressions to evaluate to understand "${args.context}":

**Basic Variable Inspection:**
- Local variables in current scope
- Function parameters and their values
- Object properties and methods

**State Analysis:**
- Check loop counters and conditions
- Examine array/object lengths and contents
- Verify boolean flags and state variables

**Common Debug Expressions for ${args.language || 'this language'}:**
- Print/log current values
- Check null/undefined values
- Examine data types and structures
- Test conditional expressions

Use the debug.evaluate tool to run these expressions and gather information about the current state.`;

    return {
        messages: [{
            role: "user",
            content: {
                type: "text", 
                text: prompt
            }
        }]
    };
});

async function main(): Promise<boolean> {
    try {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("MCP Debug Server running");
        return true;
    } catch (error: any) {
        console.error("Error starting MCP server:", error);
        return false;
    }
}

function sleep(ms: number) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

const MAX_RETRIES = 10;

// Wait 500ms before each subsequent check
const TIMEOUT = 500;

// Wait 500ms before first check
const INITIAL_DELAY = 500;

(async function() {
    await sleep(INITIAL_DELAY);

    for (let i = 0; i < MAX_RETRIES; i++) {
        const success = await main();
        if (success) {
            break;
        }
        await sleep(TIMEOUT);
    }
})();