import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
        },
    }
);


const debugDescription = `Execute a debug plan with breakpoints, launch, continues, and expression 
evaluation. ONLY SET BREAKPOINTS BEFORE LAUNCHING OR WHILE PAUSED. Be careful to keep track of where 
you are in your execution path and what is currently available to see the state. 
If you set a breakpoint but didn't hit it, check the stacktrace on the exception to see what you've missed, what line you're on etc.
If you can't debug directly, set breakpoints, launch, see what happens, and build up your understanding from there.`;

const listFilesDescription = "List all files in a directory. Use to explore a project's structure. Returns file paths.";
const getFileContentDescription = "Get the content of a specific file. Use to read source code, configuration files, etc.";

const getFileContentInputSchema = {
    type: "object",
    properties: {
        path: {
            type: "string",
            description: "Path to the file. IT MUST BE AN ABSOLUTE PATH AND MATCH THE OUTPUT OF listFiles"
        }
    },
    required: ["path"]
};

const debugStepSchema = {
    type: "array",
    items: {
        type: "object",
        properties: {
            type: {
                type: "string",
                enum: ["setBreakpoint", "removeBreakpoint", "continue", "evaluate", "launch"],
                description: ""
            },
            file: { type: "string" },
            line: { type: "number" },
            expression: {
                description: "An expression to be evaluated in the stack frame of the current breakpoint",
                type: "string"
            },
            condition: {
                description: "If needed, a breakpoint condition may be specified to only stop on a breakpoint for some given condition.",
                type: "string"
            },
            timeoutMs: {
                description: "Optional timeout in milliseconds for this step",
                type: "number"
            }
        },
        required: ["type"],
        allOf: [
            { 
                if: { properties: { type: { const: "setBreakpoint" } } }, 
                then: { required: ["file", "line"] } 
            },
            { 
                if: { properties: { type: { const: "removeBreakpoint" } } }, 
                then: { required: ["line"] } 
            },
            { 
                if: { properties: { type: { const: "evaluate" } } }, 
                then: { required: ["expression"] } 
            },
            { 
                if: { properties: { type: { const: "launch" } } }, 
                then: { required: ["file"] } 
            }
        ]
    }
};

const debugInputSchema = {
    type: "object",
    properties: {
        steps: debugStepSchema
    },
    required: ["steps"]
};

// Main tools array with Zod schemas
const tools = [
    {
        name: "listFiles",
        description: listFilesDescription,
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Directory path to list files from. If not provided, lists current directory."
                },
                maxDepth: {
                    type: "number", 
                    description: "Maximum depth to recurse into subdirectories. Default is 3."
                }
            }
        }
    },
    {
        name: "getFileContent",
        description: getFileContentDescription,
        inputSchema: getFileContentInputSchema
    },
    {
        name: "debug",
        description: debugDescription,
        inputSchema: debugInputSchema
    }
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const result = await makeRequest({
            method: request.params.name,
            params: request.params.arguments
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