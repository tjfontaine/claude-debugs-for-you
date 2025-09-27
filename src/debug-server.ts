import * as net from 'net';
import * as http from 'http';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { z } from 'zod';

interface DebugServerEvents {
    on(event: 'started', listener: () => void): this;
    on(event: 'stopped', listener: () => void): this;
    emit(event: 'started'): boolean;
    emit(event: 'stopped'): boolean;
}
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

export interface DebugCommand {
    command: 'listFiles' | 'getFileContent' | 'debug';
    payload: any;
}

export interface DebugStep {
    type: 'setBreakpoint' | 'removeBreakpoint' | 'continue' | 'evaluate' | 'launch';
    file?: string;
    line?: number;
    expression?: string;
    condition?: string;
    timeoutMs?: number;
}

// New structured response types
export interface DebugStepResult {
    index: number;
    type: string;
    status: 'ok' | 'error' | 'skipped' | 'timeout';
    messages?: string[];
    error?: {
        message: string;
        stack?: string;
        dapCommand?: string;
        dapArgs?: any;
        category?: 'validation' | 'dap_protocol' | 'fatal_launch' | 'internal';
    };
    timing: { started: string; ended?: string; durationMs?: number };
    output?: any;
}

export interface DebugEvent {
    event: string;
    body?: any;
    sessionId?: string;
    timestamp: string;
}

export interface DebugExecutionEnvelope {
    version: 1;
    sessionId: string;
    steps: DebugStepResult[];
    events: DebugEvent[];
    summary: {
        overallStatus: 'ok' | 'partial' | 'failed';
        successCount: number;
        errorCount: number;
        skippedCount: number;
    };
}

interface ToolRequest {
    type: 'listTools' | 'callTool';
    tool?: string;
    arguments?: any;
}

const debugDescription = `Execute a debug plan with breakpoints, launch, continues, and expression 
evaluation. ONLY SET BREAKPOINTS BEFORE LAUNCHING OR WHILE PAUSED. Be careful to keep track of where 
you are, if paused on a breakpoint. Make sure to find and get the contents of any requested files. 
Only use continue when ready to move to the next breakpoint. Launch will bring you to the first 
breakpoint. DO NOT USE CONTINUE TO GET TO THE FIRST BREAKPOINT.`;

// Utility functions for enhanced debug server
function nowIso(): string {
    return new Date().toISOString();
}

async function safeDAP<T>(
    session: vscode.DebugSession,
    command: string,
    args: any
): Promise<{ result?: T; error?: { message: string; stack?: string; category: 'validation' | 'dap_protocol' | 'fatal_launch' | 'internal' } }> {
    try {
        const result = await session.customRequest(command, args);
        return { result };
    } catch (e: any) {
        return {
            error: {
                message: e?.message || String(e),
                stack: e?.stack,
                category: 'dap_protocol' as const
            }
        };
    }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
        promise.then(v => { clearTimeout(timeout); resolve(v); }, e => { clearTimeout(timeout); reject(e); });
    });
}

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
        description: listFilesDescription, // Make sure this variable is defined in your code
        inputSchema: listFilesInputSchema,
    },
    {
        name: "getFileContent",
        description: getFileContentDescription, // Make sure this variable is defined in your code
        inputSchema: getFileContentInputSchema,
    },
    {
        name: "debug",
        description: debugDescription, // Make sure this variable is defined in your code
        inputSchema: debugInputSchema,
    },
];
export class DebugServer extends EventEmitter implements DebugServerEvents {
    private server: net.Server | null = null;
    private port: number = 4711;
    private portConfigPath: string | null = null;
    private activeTransports: Record<string, SSEServerTransport> = {};
    private mcpServer: McpServer;
    private _isRunning: boolean = false;
    private bufferedEvents: DebugEvent[] = [];
    private eventDisposables: vscode.Disposable[] = [];

    constructor(port?: number, portConfigPath?: string) {
        super();
        this.port = port || 4711;
        this.portConfigPath = portConfigPath || null;
        this.mcpServer = new McpServer({
            name: "Debug Server",
            version: "1.0.0",
        });

        // Setup MCP tools to use our existing handlers
        this.mcpServer.tool("listFiles", listFilesDescription, listFilesInputSchema, async (args: any) => {
            const files = await this.handleListFiles(args);
            return { content: [{ type: "text", text: JSON.stringify(files) }] };
        });

        this.mcpServer.tool("getFileContent", getFileContentDescription, getFileContentInputSchema, async (args: any) => {
            const content = await this.handleGetFile(args);
            return { content: [{ type: "text", text: content }] };
        });

        this.mcpServer.tool("debug", debugDescription, debugInputSchema, async (args: any) => {
            const envelope = await this.executeDebugPlan(args);
            return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
        });

        // Additional granular debug tools
        this.mcpServer.tool("debug.status", "Get current debug session status and thread information", {}, async () => {
            return { content: [{ type: "text", text: JSON.stringify(await this.getDebugStatus(), null, 2) }] };
        });

        this.mcpServer.tool("debug.evaluate", "Evaluate a single expression in the current debug context", {
            expression: z.string().describe("The expression to evaluate")
        }, async (args: any) => {
            const result = await this.evaluateExpression(args.expression);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });

        this.mcpServer.tool("debug.listBreakpoints", "List all current breakpoints", {}, async () => {
            return { content: [{ type: "text", text: JSON.stringify(await this.listBreakpoints(), null, 2) }] };
        });
    }

    get isRunning(): boolean {
        return this._isRunning;
    }

    setPort(port: number): void {
        this.port = port || 4711;

        // Update port in configuration file if available
        if (this.portConfigPath && typeof port === 'number') {
            try {
                const fs = require('fs');
                fs.writeFileSync(this.portConfigPath, JSON.stringify({ port }));
            } catch (err) {
                console.error('Failed to update port configuration file:', err);
                // We'll still use the new port even if saving to file fails
            }
        }
    }

    getPort(): number {
        return this.port;
    }

    async forceStopExistingServer(): Promise<void> {
        try {
            // Send a request to the shutdown endpoint of any existing server
            await new Promise<void>((resolve, reject) => {
                const req = http.request({
                    hostname: 'localhost',
                    port: this.port,
                    path: '/shutdown',
                    method: 'POST',
                    timeout: 3000 // 3 second timeout
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            // Give the server a moment to shut down
                            setTimeout(resolve, 500);
                        } else {
                            reject(new Error(`Unexpected status: ${res.statusCode}`));
                        }
                    });
                });

                req.on('error', (err: NodeJS.ErrnoException) => {
                    // If we can't connect, there's no server running or it's not ours
                    if (err.code === 'ECONNREFUSED') {
                        resolve(); // No server running, so nothing to stop
                    } else {
                        reject(err);
                    }
                });

                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Request timed out'));
                });

                req.end();
            });
        } catch (err) {
            console.error('Error requesting server shutdown:', err);
            throw new Error('Failed to stop existing server');
        }
    }

    async start(): Promise<void> {
        if (this.server) {
            throw new Error('Server is already running');
        }

        this.server = http.createServer(async (req, res) => {
            // Handle CORS
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');

            if (req.method === 'OPTIONS') {
                res.writeHead(204).end();
                return;
            }

            // Shutdown endpoint - allows another instance to request shutdown of this server
            if (req.method === 'POST' && req.url === '/shutdown') {
                res.writeHead(200).end('Server shutting down');
                this.stop().catch(err => {
                    res.writeHead(500).end(`Error shutting down: ${err.message}`);
                });
                return;
            }

            // Legacy TCP-style endpoint
            if (req.method === 'POST' && req.url === '/tcp') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const request = JSON.parse(body);
                        let response: any;

                        if (request.type === 'listTools') {
                            response = { tools };
                        } else if (request.type === 'callTool') {
                            response = await this.handleCommand(request);
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, data: response }));
                    } catch (error) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            error: error instanceof Error ? error.message : 'Unknown error'
                        }));
                    }
                });
                return;
            }

            // SSE endpoint
            if (req.method === 'GET' && req.url === '/sse') {
                const transport = new SSEServerTransport('/messages', res);
                this.activeTransports[transport.sessionId] = transport;
                await this.mcpServer.connect(transport);
                res.on('close', () => {
                    delete this.activeTransports[transport.sessionId];
                });
                return;
            }

            // Message endpoint for SSE
            if (req.method === 'POST' && req.url?.startsWith('/messages')) {
                const url = new URL(req.url, 'http://localhost');
                const sessionId = url.searchParams.get('sessionId');
                if (!sessionId || !this.activeTransports[sessionId]) {
                    res.writeHead(404).end('Session not found');
                    return;
                }
                await this.activeTransports[sessionId].handlePostMessage(req, res);
                return;
            }

            res.writeHead(404).end();
        });

        return new Promise((resolve, reject) => {
            this.server!.listen(this.port, () => {
                this._isRunning = true;
                this.emit('started');
                resolve();
            }).on('error', reject);
        });
    }

    // Helper method to handle tool calls
    private async handleCommand(request: ToolRequest): Promise<any> {
        switch (request.tool) {
            case 'listFiles':
                return await this.handleListFiles(request.arguments);
            case 'getFileContent':
                return await this.handleGetFile(request.arguments);
            case 'debug':
                return await this.executeDebugPlan(request.arguments);
            default:
                throw new Error(`Unknown tool: ${request.tool}`);
        }
    }

    private async handleLaunch(payload: {
        program: string,
        args?: string[]
    }): Promise<string> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder found');
        }

        // Try to get launch configurations
        const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
        const configurations = launchConfig.get<any[]>('configurations');

        if (!configurations || configurations.length === 0) {
            throw new Error('No debug configurations found in launch.json');
        }

        // Get the first configuration and update it with the current file
        const config = { ...configurations[0] };

        // Replace ${file} with actual file path if it exists in the configuration
        Object.keys(config).forEach(key => {
            if (typeof config[key] === 'string') {
                config[key] = config[key].replace('${file}', payload.program);
            }
        });

        // Replace ${workspaceFolder} in environment variables if they exist
        if (config.env) {
            Object.keys(config.env).forEach(key => {
                if (typeof config.env[key] === 'string') {
                    config.env[key] = config.env[key].replace(
                        '${workspaceFolder}',
                        workspaceFolder.uri.fsPath
                    );
                }
            });
        }

        // Check if we're already debugging
        let session = vscode.debug.activeDebugSession;
        if (!session) {
            // Start debugging using the configured launch configuration
            await vscode.debug.startDebugging(workspaceFolder, config);

            // Wait for session to be available
            session = await this.waitForDebugSession();
        }

        // Check if we're at a breakpoint
        try {
            const threads = await session.customRequest('threads');
            const threadId = threads.threads[0].id;

            const stack = await session.customRequest('stackTrace', { threadId });
            if (stack.stackFrames && stack.stackFrames.length > 0) {
                const topFrame = stack.stackFrames[0];
                const currentBreakpoints = vscode.debug.breakpoints.filter(bp => {
                    if (bp instanceof vscode.SourceBreakpoint) {
                        return bp.location.uri.toString() === topFrame.source.path &&
                            bp.location.range.start.line === (topFrame.line - 1);
                    }
                    return false;
                });

                if (currentBreakpoints.length > 0) {
                    return `Debug session started - Stopped at breakpoint on line ${topFrame.line}`;
                }
            }
            return 'Debug session started';
        } catch (err) {
            console.error('Error checking breakpoint status:', err);
            return 'Debug session started';
        }
    }

    private waitForDebugSession(): Promise<vscode.DebugSession> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for debug session'));
            }, 5000);

            const checkSession = () => {
                const session = vscode.debug.activeDebugSession;
                if (session) {
                    clearTimeout(timeout);
                    resolve(session);
                } else {
                    setTimeout(checkSession, 100);
                }
            };

            checkSession();
        });
    }

    private async handleListFiles(payload: {
        includePatterns?: string[],
        excludePatterns?: string[]
    }): Promise<string[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error('No workspace folders found');
        }

        const includePatterns = payload.includePatterns || ['**/*'];
        const excludePatterns = payload.excludePatterns || ['**/node_modules/**', '**/.git/**'];

        const files: string[] = [];
        for (const folder of workspaceFolders) {
            const relativePattern = new vscode.RelativePattern(folder, `{${includePatterns.join(',')}}`);
            const foundFiles = await vscode.workspace.findFiles(relativePattern, `{${excludePatterns.join(',')}}`);
            files.push(...foundFiles.map(file => file.fsPath));
        }

        return files;
    }

    private async handleGetFile(payload: { path: string }): Promise<string> {
        const doc = await vscode.workspace.openTextDocument(payload.path);
        const lines = doc.getText().split('\n');
        return lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
    }

    private async executeDebugPlan(payload: { steps: DebugStep[] }): Promise<DebugExecutionEnvelope> {
        const steps = payload.steps || [];
        const sessionId = crypto.randomUUID();
        const results: DebugStepResult[] = [];
        const bufferedEvents: DebugEvent[] = [];

        // Subscribe to debug events
        const disposables: vscode.Disposable[] = [];

        disposables.push(
            vscode.debug.onDidReceiveDebugSessionCustomEvent(evt => {
                bufferedEvents.push({
                    event: 'debug.custom',
                    body: evt.body,
                    sessionId: evt.session.id,
                    timestamp: nowIso()
                });
            }),
            vscode.debug.onDidTerminateDebugSession(s => {
                bufferedEvents.push({ 
                    event: 'debug.terminated', 
                    sessionId: s.id, 
                    timestamp: nowIso() 
                });
            }),
            vscode.debug.onDidStartDebugSession(s => {
                bufferedEvents.push({ 
                    event: 'debug.started', 
                    sessionId: s.id, 
                    timestamp: nowIso() 
                });
            })
        );

        let fatal = false;

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const timingStart = Date.now();
            const result: DebugStepResult = {
                index: i,
                type: step.type,
                status: 'ok',
                timing: { started: nowIso() },
                messages: []
            };

            if (fatal) {
                result.status = 'skipped';
                result.messages!.push('Skipped due to previous fatal error');
                results.push(result);
                continue;
            }

            try {
                // Apply timeout if specified
                const stepPromise = this.executeStep(step, result);
                const timeoutMs = step.timeoutMs || 30000; // Default 30s timeout
                
                await withTimeout(stepPromise, timeoutMs);

            } catch (e: any) {
                if (e.message.includes('Timeout after')) {
                    result.status = 'timeout';
                    result.error = { 
                        message: e.message, 
                        category: 'internal' 
                    };
                } else {
                    result.status = 'error';
                    result.error = { 
                        message: e?.message || String(e), 
                        stack: e?.stack,
                        category: this.classifyError(e, step.type)
                    };
                    
                    // Mark as fatal if it's a launch failure
                    if (step.type === 'launch') {
                        fatal = true;
                    }
                }
            } finally {
                result.timing.ended = nowIso();
                result.timing.durationMs = Date.now() - timingStart;
                results.push(result);
            }
        }

        disposables.forEach(d => d.dispose());

        const errorCount = results.filter(r => r.status === 'error').length;
        const skippedCount = results.filter(r => r.status === 'skipped').length;
        const successCount = results.filter(r => r.status === 'ok').length;
        
        const overallStatus =
            errorCount === 0 && skippedCount === 0 ? 'ok' :
            errorCount === results.length ? 'failed' : 'partial';

        return {
            version: 1,
            sessionId,
            steps: results,
            events: bufferedEvents,
            summary: {
                overallStatus,
                successCount,
                errorCount,
                skippedCount
            }
        };
    }

    private async executeStep(step: DebugStep, result: DebugStepResult): Promise<void> {
        switch (step.type) {
            case 'setBreakpoint': {
                if (!step.line) {
                    throw new Error('Line number required for setBreakpoint');
                }
                if (!step.file) {
                    throw new Error('File path required for setBreakpoint');
                }

                // Open the file and make it active
                const document = await vscode.workspace.openTextDocument(step.file);
                const editor = await vscode.window.showTextDocument(document);

                const bp = new vscode.SourceBreakpoint(
                    new vscode.Location(
                        editor.document.uri,
                        new vscode.Position(step.line - 1, 0)
                    ),
                    true,
                    step.condition,
                );
                await vscode.debug.addBreakpoints([bp]);
                result.messages!.push(`Set breakpoint at ${step.file}:${step.line}${step.condition ? ` (condition: ${step.condition})` : ''}`);
                break;
            }

            case 'removeBreakpoint': {
                if (!step.line) {
                    throw new Error('Line number required for removeBreakpoint');
                }
                const bps = vscode.debug.breakpoints.filter(bp => {
                    if (bp instanceof vscode.SourceBreakpoint) {
                        return bp.location.range.start.line === step.line! - 1;
                    }
                    return false;
                });
                await vscode.debug.removeBreakpoints(bps);
                result.messages!.push(`Removed ${bps.length} breakpoint(s) at line ${step.line}`);
                break;
            }

            case 'continue': {
                const session = vscode.debug.activeDebugSession;
                if (!session) {
                    throw new Error('No active debug session');
                }
                const { result: continueResult, error } = await safeDAP(session, 'continue', {});
                if (error) {
                    result.error = {
                        message: error.message,
                        stack: error.stack,
                        dapCommand: 'continue',
                        category: error.category
                    };
                    result.status = 'error';
                } else {
                    result.messages!.push('Continued execution');
                }
                break;
            }

            case 'evaluate': {
                if (!step.expression) {
                    throw new Error('Expression required for evaluate');
                }
                
                const session = vscode.debug.activeDebugSession;
                if (!session) {
                    throw new Error('No active debug session');
                }

                const activeStackItem = vscode.debug.activeStackItem;
                let frameId = undefined;
                
                if (activeStackItem instanceof vscode.DebugStackFrame) {
                    frameId = activeStackItem.frameId;
                }

                // Get frame ID if not available
                if (!frameId) {
                    const { result: stackResult, error: stackError } = await safeDAP<any>(session, 'stackTrace', { threadId: 1 });
                    if (stackError || !stackResult?.stackFrames?.length) {
                        throw new Error('No stack frame available for evaluation');
                    }
                    frameId = stackResult.stackFrames[0].id;
                }

                const { result: evalResult, error } = await safeDAP<any>(session, 'evaluate', {
                    expression: step.expression,
                    frameId,
                    context: 'repl'
                });

                if (error) {
                    result.status = 'error';
                    result.error = {
                        message: error.message,
                        stack: error.stack,
                        dapCommand: 'evaluate',
                        dapArgs: { expression: step.expression, frameId },
                        category: error.category
                    };
                } else {
                    result.output = evalResult;
                    result.messages!.push(`Evaluated "${step.expression}": ${evalResult.result}`);
                }
                break;
            }

            case 'launch': {
                if (!step.file) {
                    throw new Error('File path required for launch');
                }
                const launchResult = await this.handleLaunch({ program: step.file! });
                result.messages!.push(launchResult);
                
                // Parse launch result to extract initial state info
                if (launchResult.includes('Stopped at breakpoint on line')) {
                    const lineMatch = launchResult.match(/line (\d+)/);
                    if (lineMatch) {
                        result.output = {
                            initialState: 'stopped_at_breakpoint',
                            line: parseInt(lineMatch[1]),
                            file: step.file
                        };
                    }
                } else if (launchResult.includes('Debug session started')) {
                    result.output = {
                        initialState: 'running',
                        file: step.file
                    };
                }
                break;
            }

            default:
                throw new Error(`Unsupported step type: ${step.type}`);
        }
    }

    private classifyError(error: any, stepType: string): 'validation' | 'dap_protocol' | 'fatal_launch' | 'internal' {
        const message = error?.message || String(error);
        
        if (message.includes('required')) {
            return 'validation';
        }
        if (stepType === 'launch') {
            return 'fatal_launch';
        }
        if (message.includes('debug session') || message.includes('DAP') || message.includes('customRequest')) {
            return 'dap_protocol';
        }
        return 'internal';
    }

    private async getDebugStatus(): Promise<any> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            return { 
                version: 1,
                status: 'no_active_session',
                timestamp: nowIso()
            };
        }

        try {
            const { result: threads } = await safeDAP<any>(session, 'threads', {});
            const activeStackItem = vscode.debug.activeStackItem;
            
            return {
                version: 1,
                status: 'active',
                sessionId: session.id,
                sessionName: session.name,
                threads: threads?.threads || [],
                activeStackFrame: activeStackItem instanceof vscode.DebugStackFrame ? {
                    frameId: activeStackItem.frameId
                } : null,
                timestamp: nowIso()
            };
        } catch (error) {
            return {
                version: 1,
                status: 'error',
                error: String(error),
                timestamp: nowIso()
            };
        }
    }

    private async evaluateExpression(expression: string): Promise<any> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            return {
                version: 1,
                status: 'error',
                error: 'No active debug session',
                timestamp: nowIso()
            };
        }

        try {
            const activeStackItem = vscode.debug.activeStackItem;
            let frameId = undefined;
            
            if (activeStackItem instanceof vscode.DebugStackFrame) {
                frameId = activeStackItem.frameId;
            }

            if (!frameId) {
                const { result: stackResult, error: stackError } = await safeDAP<any>(session, 'stackTrace', { threadId: 1 });
                if (stackError || !stackResult?.stackFrames?.length) {
                    return {
                        version: 1,
                        status: 'error',
                        error: 'No stack frame available for evaluation',
                        timestamp: nowIso()
                    };
                }
                frameId = stackResult.stackFrames[0].id;
            }

            const { result: evalResult, error } = await safeDAP<any>(session, 'evaluate', {
                expression,
                frameId,
                context: 'repl'
            });

            if (error) {
                return {
                    version: 1,
                    status: 'error',
                    error: error.message,
                    expression,
                    timestamp: nowIso()
                };
            }

            return {
                version: 1,
                status: 'ok',
                expression,
                result: evalResult,
                timestamp: nowIso()
            };
        } catch (error) {
            return {
                version: 1,
                status: 'error',
                error: String(error),
                expression,
                timestamp: nowIso()
            };
        }
    }

    private async listBreakpoints(): Promise<any> {
        const breakpoints = vscode.debug.breakpoints;
        const formattedBreakpoints = breakpoints.map(bp => {
            if (bp instanceof vscode.SourceBreakpoint) {
                return {
                    type: 'source',
                    file: bp.location.uri.fsPath,
                    line: bp.location.range.start.line + 1, // Convert to 1-based
                    condition: bp.condition,
                    enabled: bp.enabled
                };
            } else if (bp instanceof vscode.FunctionBreakpoint) {
                return {
                    type: 'function',
                    functionName: bp.functionName,
                    condition: bp.condition,
                    enabled: bp.enabled
                };
            } else {
                return {
                    type: 'other',
                    enabled: bp.enabled
                };
            }
        });

        return {
            version: 1,
            breakpoints: formattedBreakpoints,
            count: formattedBreakpoints.length,
            timestamp: nowIso()
        };
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            // Dispose of any active event listeners
            this.eventDisposables.forEach(d => d.dispose());
            this.eventDisposables = [];
            
            if (!this.server) {
                this._isRunning = false;
                this.emit('stopped');
                resolve();
                return;
            }

            Object.values(this.activeTransports).forEach(transport => {
                transport.close();
            });
            this.activeTransports = {};

            this.server.close(() => {
                this.server = null;
                this._isRunning = false;
                this.emit('stopped');
                resolve();
            });
        });
    }
}
