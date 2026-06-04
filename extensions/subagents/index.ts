import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getAgentDir, parseFrontmatter, SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const SUBAGENT_SESSION = "subagent-session";
const SUBAGENT_CHILD = "subagent-child";

interface AgentToolConfig {
	enabled: boolean;
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	guidelines: string[];
	defaultTask?: string;
	taskDescription?: string;
}

interface AgentConfig {
	name: string;
	description: string;
	systemPrompt: string;
	filePath: string;
	tool?: AgentToolConfig;
}

interface SubagentSessionMeta {
	agent: string;
	parentSession?: string;
	createdAt: number;
	task: string;
}

interface SubagentChildMeta extends SubagentSessionMeta {
	childSession: string;
}

interface SubagentResult {
	output: string;
	stderr: string;
	exitCode: number;
	childSession: string;
}

type JobStatus = "running" | "done" | "error" | "cancelled";

interface SubagentJob {
	id: string;
	agent: AgentConfig;
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	contextWindow?: number;
	contextTokens?: number;
	startedAt: number;
	status: JobStatus;
	childSession: string;
	events: string[];
	proc?: ChildProcessWithoutNullStreams;
	result?: SubagentResult;
}

const jobs = new Map<string, SubagentJob>();
let activeSubagentMeta: SubagentSessionMeta | undefined;
let statusCtx: any | undefined;
let statusTimer: ReturnType<typeof setInterval> | undefined;
let statusFrame = 0;

function getString(value: unknown): string | undefined {
	return typeof value === "string" ? value.trim() : undefined;
}

function parseBoolean(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	const text = getString(value);
	if (!text) return false;
	return ["1", "true", "yes", "on"].includes(text.toLowerCase());
}

function parseList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => getString(item)).filter(Boolean) as string[];
	const text = getString(value);
	if (!text) return [];
	return text
		.split(/\r?\n|;/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function makeToolConfig(agentName: string, description: string, frontmatter: Record<string, unknown>): AgentToolConfig | undefined {
	if (!parseBoolean(frontmatter.tool)) return undefined;

	const toolName = getString(frontmatter.toolName) || agentName;
	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(toolName)) return undefined;

	const guidelines = parseList(frontmatter.toolWhen ?? frontmatter.toolGuidelines);
	return {
		enabled: true,
		name: toolName,
		label: getString(frontmatter.toolLabel),
		description: getString(frontmatter.toolDescription) || `Run the ${agentName} subagent. ${description}`,
		promptSnippet: getString(frontmatter.toolPromptSnippet),
		guidelines,
		defaultTask: getString(frontmatter.defaultTask),
		taskDescription: getString(frontmatter.taskDescription),
	};
}

function loadAgentsFromDir(dir: string): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const rawName = getString(frontmatter.name);
		if (!rawName) continue;

		const name = rawName;
		const description = getString(frontmatter.description) || `Subagent ${name}`;

		agents.push({
			name,
			description,
			systemPrompt: body.trim(),
			filePath,
			tool: makeToolConfig(name, description, frontmatter),
		});
	}

	return agents;
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function loadAgents(cwd?: string): AgentConfig[] {
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of loadAgentsFromDir(path.join(getAgentDir(), "agents"))) agentMap.set(agent.name, agent);

	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	if (projectAgentsDir) {
		for (const agent of loadAgentsFromDir(projectAgentsDir)) agentMap.set(agent.name, agent);
	}

	return Array.from(agentMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function findAgent(name: string, cwd?: string): AgentConfig | undefined {
	return loadAgents(cwd).find((agent) => agent.name === name);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

function splitModel(model: string | undefined): { provider: string; modelId: string } | undefined {
	if (!model) return undefined;
	const slash = model.indexOf("/");
	if (slash <= 0) return undefined;
	return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

function extractAssistantText(message: Message): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function summarizeText(text: string, max = 180): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function summarizeJsonEvent(event: any): string | undefined {
	if (event.message) {
		const msg = event.message as Message;
		if (msg.role === "assistant") {
			const text = extractAssistantText(msg);
			if (text) return `assistant: ${summarizeText(text)}`;
			const toolCalls = msg.content.filter((part) => part.type === "toolCall").map((part: any) => part.name);
			if (toolCalls.length > 0) return `assistant tool calls: ${toolCalls.join(", ")}`;
		}
		if (msg.role === "toolResult") return `tool result: ${(msg as any).toolName ?? "unknown"}`;
	}

	const toolName = event.toolName ?? event.name ?? event.message?.toolName;
	if (typeof event.type === "string" && event.type.includes("tool") && toolName) return `${event.type}: ${toolName}`;
	if (event.type === "error") return `error: ${summarizeText(JSON.stringify(event))}`;
	return undefined;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function pushJobEvent(job: SubagentJob, event: string): void {
	job.events.push(`${new Date().toLocaleTimeString()} ${event}`);
	if (job.events.length > 20) job.events.splice(0, job.events.length - 20);
}

function getLatestRunningJob(): SubagentJob | undefined {
	return Array.from(jobs.values())
		.filter((job) => job.status === "running")
		.sort((a, b) => b.startedAt - a.startedAt)[0];
}

function updateSubagentStatus(): void {
	if (!statusCtx) return;
	const job = getLatestRunningJob();
	try {
		if (!job) {
			statusCtx.ui.setStatus("subagents", undefined);
			if (statusTimer) clearInterval(statusTimer);
			statusTimer = undefined;
			return;
		}

		const frames = [".", "..", "...", ".."];
		const dots = frames[statusFrame++ % frames.length];
		let context = "ctx ?";
		if (job.contextTokens && job.contextWindow) {
			const pct = Math.min(100, Math.max(0, (job.contextTokens / job.contextWindow) * 100));
			context = `ctx ${pct.toFixed(1)}% (${formatTokens(job.contextTokens)}/${formatTokens(job.contextWindow)})`;
		} else if (job.contextTokens) {
			context = `ctx ${formatTokens(job.contextTokens)}`;
		}

		statusCtx.ui.setStatus("subagents", `subagent ${job.agent.name}${dots} ${context}`);
	} catch {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
		statusCtx = undefined;
	}
}

function startSubagentStatus(ctx: any): void {
	statusCtx = ctx;
	if (!statusTimer) statusTimer = setInterval(updateSubagentStatus, 500);
	updateSubagentStatus();
}

function stopSubagentStatus(): void {
	if (statusTimer) clearInterval(statusTimer);
	statusTimer = undefined;
	try {
		statusCtx?.ui.setStatus("subagents", undefined);
	} catch {
		// context may already be stale during session replacement
	}
	statusCtx = undefined;
}

function getCustomData<T>(entries: any[], customType: string): T[] {
	return entries
		.filter((entry) => entry.type === "custom" && entry.customType === customType)
		.map((entry) => entry.data)
		.filter(Boolean) as T[];
}

function getSessionEntries(sessionManager: any): any[] {
	return typeof sessionManager.getBranch === "function" ? sessionManager.getBranch() : sessionManager.getEntries();
}

function getSubagentSessionMeta(sessionManager: any): SubagentSessionMeta | undefined {
	const metas = getCustomData<SubagentSessionMeta>(getSessionEntries(sessionManager), SUBAGENT_SESSION);
	return metas.at(-1);
}

function createEntryId(): string {
	return randomBytes(4).toString("hex");
}

function makeEntry(type: string, parentId: string | null, extra: Record<string, unknown>) {
	return {
		type,
		id: createEntryId(),
		parentId,
		timestamp: new Date().toISOString(),
		...extra,
	};
}

function createChildSession(ctx: any, agent: AgentConfig, task: string, model: string | undefined, thinkingLevel: string | undefined) {
	const parentSession = ctx.sessionManager.getSessionFile();
	const createdAt = Date.now();
	const child = SessionManager.create(ctx.cwd);
	child.newSession({ parentSession });
	const childSession = child.getSessionFile();
	if (!childSession) throw new Error("Could not create subagent child session file");

	const header = {
		type: "session",
		version: 3,
		id: child.getSessionId(),
		timestamp: new Date().toISOString(),
		cwd: ctx.cwd,
		parentSession,
	};

	const entries: any[] = [header];
	let parentId: string | null = null;
	const append = (entry: any) => {
		entries.push(entry);
		parentId = entry.id;
	};

	append(makeEntry("session_info", parentId, { name: `subagent:${agent.name}` }));
	const parsedModel = splitModel(model);
	if (parsedModel) append(makeEntry("model_change", parentId, parsedModel));
	if (thinkingLevel) append(makeEntry("thinking_level_change", parentId, { thinkingLevel }));
	append(
		makeEntry("custom", parentId, {
			customType: SUBAGENT_SESSION,
			data: { agent: agent.name, parentSession, createdAt, task } satisfies SubagentSessionMeta,
		}),
	);

	fs.mkdirSync(path.dirname(childSession), { recursive: true });
	fs.writeFileSync(childSession, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");

	return { childSession, parentSession, createdAt };
}

async function runSubagent(job: SubagentJob): Promise<SubagentResult> {
	const args = ["--mode", "json", "-p", "--session", job.childSession];
	if (job.model) args.push("--model", job.model);
	if (job.thinkingLevel) args.push("--thinking", job.thinkingLevel);
	args.push(`Task for subagent ${job.agent.name}:\n\n${job.task || "(no additional task)"}`);

	return await new Promise((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: job.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		job.proc = proc;

		let stdoutBuffer = "";
		let stderr = "";
		let lastAssistantOutput = "";
		let finalExitCode = 0;
		let settled = false;
		let finishTimer: ReturnType<typeof setTimeout> | undefined;

		const scheduleFinish = (exitCode: number, reason: string, delayMs: number) => {
			if (finishTimer) clearTimeout(finishTimer);
			finishTimer = setTimeout(() => finish(exitCode, reason), delayMs);
		};

		const finish = (exitCode: number, reason?: string, terminate = true) => {
			if (settled) return;
			settled = true;
			if (finishTimer) clearTimeout(finishTimer);
			if (reason) pushJobEvent(job, reason);
			if (terminate && !proc.killed) proc.kill("SIGTERM");
			if (terminate) {
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 2000);
			}
			resolve({ output: lastAssistantOutput.trim(), stderr: stderr.trim(), exitCode, childSession: job.childSession });
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				pushJobEvent(job, `stdout: ${summarizeText(line)}`);
				return;
			}

			const summary = summarizeJsonEvent(event);
			if (summary) pushJobEvent(job, summary);

			if (event.message) {
				const msg = event.message as Message;
				const text = extractAssistantText(msg);
				if (text) lastAssistantOutput = text;

				const usage = (msg as any).usage;
				if (typeof usage?.totalTokens === "number" && usage.totalTokens > 0) {
					job.contextTokens = usage.totalTokens;
					updateSubagentStatus();
				}

				const isFinalMessageEvent = event.type === "message_end" || event.type === "turn_end";
				if (isFinalMessageEvent && msg.role === "assistant" && (msg as any).stopReason && (msg as any).stopReason !== "toolUse") {
					const stopReason = (msg as any).stopReason;
					finalExitCode = stopReason === "error" || stopReason === "aborted" ? 1 : 0;
					scheduleFinish(finalExitCode, `final assistant watchdog stopReason=${stopReason}`, 10_000);
				}
			}

			if (event.type === "agent_end") {
				scheduleFinish(finalExitCode, "agent_end", 500);
			}

			if (event.type === "context_usage") {
				const tokens = event.tokens ?? event.contextTokens ?? event.usage?.totalTokens;
				if (typeof tokens === "number" && tokens > 0) {
					job.contextTokens = tokens;
					updateSubagentStatus();
				}
			}
		};

		proc.stdout.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			const text = data.toString();
			stderr += text;
			pushJobEvent(job, `stderr: ${summarizeText(text)}`);
		});

		proc.on("close", (code, signal) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			const exitCode = job.status === "cancelled" ? 130 : (code ?? (signal ? 130 : 0));
			finish(exitCode, `process closed${signal ? ` signal=${signal}` : ""}`, false);
		});

		proc.on("error", (error) => {
			pushJobEvent(job, `process error: ${error.message}`);
			stderr = stderr ? `${stderr}\n${error.message}` : error.message;
			finish(1, "process error");
		});
	});
}

function formatSubagentMessage(agent: AgentConfig, task: string, result: SubagentResult): string {
	const status = result.exitCode === 0 ? "OK" : `ERROR exitCode=${result.exitCode}`;
	const body = result.output || result.stderr || "(empty output)";
	return [
		`[subagent:${agent.name}] ${status}`,
		`Task: ${task || "(no additional task)"}`,
		`Child session: ${result.childSession}`,
		"",
		"Result:",
		body,
		"",
		'Main agent instruction: napisz użytkownikowi: "Takie coś dostałem od subagenta:" i pokaż wynik subagenta.',
	].join("\n");
}

function formatSubagentToolText(agent: AgentConfig, task: string, result: SubagentResult): string {
	const status = result.exitCode === 0 ? "OK" : `ERROR exitCode=${result.exitCode}`;
	const body = result.output || result.stderr || "(empty output)";
	return [
		`Subagent: ${agent.name}`,
		`Status: ${status}`,
		`Task: ${task || "(no additional task)"}`,
		`Child session: ${result.childSession}`,
		"",
		"Subagent output:",
		body,
	].join("\n");
}

function cancelRunningJobs(reason: string): void {
	for (const job of jobs.values()) {
		if (job.status !== "running") continue;
		job.status = "cancelled";
		pushJobEvent(job, reason);
		job.proc?.kill("SIGTERM");
		setTimeout(() => {
			if (job.proc && !job.proc.killed) job.proc.kill("SIGKILL");
		}, 5000);
	}
}

function createSubagentJob(pi: ExtensionAPI, agent: AgentConfig, task: string, ctx: any): SubagentJob {
	const mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
	const thinkingLevel = pi.getThinkingLevel();
	const child = createChildSession(ctx, agent, task, mainModel, thinkingLevel);

	pi.appendEntry(SUBAGENT_CHILD, {
		agent: agent.name,
		parentSession: child.parentSession,
		childSession: child.childSession,
		createdAt: child.createdAt,
		task,
	} satisfies SubagentChildMeta);

	const job: SubagentJob = {
		id: Math.random().toString(16).slice(2, 8),
		agent,
		task,
		cwd: ctx.cwd,
		model: mainModel,
		thinkingLevel,
		contextWindow,
		startedAt: Date.now(),
		status: "running",
		childSession: child.childSession,
		events: [],
	};
	jobs.set(job.id, job);
	pushJobEvent(job, `started on ${mainModel ?? "default model"}`);
	return job;
}

async function runAgentForResult(pi: ExtensionAPI, agent: AgentConfig, task: string, ctx: any, signal?: AbortSignal): Promise<SubagentResult> {
	const job = createSubagentJob(pi, agent, task, ctx);
	startSubagentStatus(ctx);

	const abort = () => {
		if (job.status !== "running") return;
		job.status = "cancelled";
		pushJobEvent(job, "aborted");
		job.proc?.kill("SIGTERM");
		setTimeout(() => {
			if (job.proc && !job.proc.killed) job.proc.kill("SIGKILL");
		}, 5000);
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });

	try {
		const result = await runSubagent(job);
		job.result = result;
		if (job.status === "cancelled") throw new Error(`Subagent ${agent.name} was cancelled`);
		job.status = result.exitCode === 0 ? "done" : "error";
		pushJobEvent(job, `finished exitCode=${result.exitCode}`);
		updateSubagentStatus();
		return result;
	} finally {
		signal?.removeEventListener("abort", abort);
		updateSubagentStatus();
	}
}

async function startAgent(pi: ExtensionAPI, agentName: string, task: string, ctx: any): Promise<void> {
	const agent = findAgent(agentName, ctx.cwd);
	if (!agent) {
		const available = loadAgents(ctx.cwd).map((a) => a.name).join(", ") || "none";
		ctx.ui.notify(`Unknown subagent: ${agentName}. Available: ${available}`, "error");
		return;
	}

	const job = createSubagentJob(pi, agent, task, ctx);
	ctx.ui.notify(`Started subagent ${agent.name} [${job.id}]${job.model ? ` on ${job.model}` : ""}`, "info");
	startSubagentStatus(ctx);

	void (async () => {
		try {
			const result = await runSubagent(job);
			job.result = result;
			if (job.status === "cancelled") return;
			job.status = result.exitCode === 0 ? "done" : "error";
			pushJobEvent(job, `finished exitCode=${result.exitCode}`);
			updateSubagentStatus();

			const content = formatSubagentMessage(agent, task, result);
			pi.sendMessage(
				{
					customType: "subagent-result",
					content,
					display: true,
					details: {
						agent: agent.name,
						task,
						exitCode: result.exitCode,
						stderr: result.stderr,
						agentFile: agent.filePath,
						model: job.model,
						thinkingLevel: job.thinkingLevel,
						childSession: result.childSession,
						jobId: job.id,
					},
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			if (job.status === "cancelled") return;
			job.status = "error";
			updateSubagentStatus();
			pushJobEvent(job, `error: ${error instanceof Error ? error.message : String(error)}`);
			try {
				ctx.ui.notify(`Subagent ${agent.name} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} catch {
				// command context may be stale after session replacement
			}
		}
	})();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		activeSubagentMeta = getSubagentSessionMeta(ctx.sessionManager);
	});

	pi.on("session_shutdown", (event) => {
		stopSubagentStatus();
		cancelRunningJobs(`session shutdown: ${event.reason}`);
	});

	pi.on("before_agent_start", (event) => {
		if (!activeSubagentMeta) return;
		const agent = findAgent(activeSubagentMeta.agent, event.systemPromptOptions.cwd);
		if (!agent) return;

		const subagentPrompt = [
			`# Subagent: ${agent.name}`,
			"",
			"You are running as a subagent in a separate, clean pi child session.",
			"You can use normal project AGENTS.md/CLAUDE.md context, skills, tools, and extensions.",
			"You cannot see the parent agent conversation, hidden reasoning, or unrelated session history.",
			"Work only from this child session plus project/global context loaded by pi.",
			"",
			agent.systemPrompt,
		].join("\n");

		return { systemPrompt: `${event.systemPrompt}\n\n${subagentPrompt}` };
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Run a named subagent in an isolated child session and return its result.",
		promptSnippet: "Run a named subagent in an isolated child session",
		promptGuidelines: [
			"Use subagent when a specialized agent is better suited than the main agent, for example tester for test execution or reviewer for code review.",
			"Do not use subagent from inside another subagent; subagent tools are intended for the main agent only.",
		],
		parameters: Type.Object({
			agent: Type.String({ description: "Name of the subagent to run, e.g. tester or reviewer" }),
			task: Type.String({ description: "Task to delegate to the subagent" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (getSubagentSessionMeta(ctx.sessionManager)) throw new Error("Nested subagent execution is disabled.");
			const agent = findAgent(params.agent, ctx.cwd);
			if (!agent) {
				const available = loadAgents(ctx.cwd).map((a) => a.name).join(", ") || "none";
				throw new Error(`Unknown subagent: ${params.agent}. Available agents: ${available}.`);
			}
			const result = await runAgentForResult(pi, agent, params.task, ctx, signal);
			return {
				content: [{ type: "text", text: formatSubagentToolText(agent, params.task, result) }],
				details: { agent: agent.name, task: params.task, result },
			};
		},
	});

	const reservedAgentToolNames = new Set(["subagent", "read", "bash", "edit", "write", "grep", "find", "ls"]);
	const registeredAgentTools = new Set<string>();
	const registerAgentTools = (cwd?: string) => {
		for (const agent of loadAgents(cwd)) {
			const tool = agent.tool;
			if (!tool?.enabled) continue;
			if (reservedAgentToolNames.has(tool.name) || registeredAgentTools.has(tool.name)) continue;
			if (pi.getAllTools().some((existing) => existing.name === tool.name)) continue;
			registeredAgentTools.add(tool.name);

			const defaultTask = tool.defaultTask;
			pi.registerTool({
				name: tool.name,
				label: tool.label || agent.name,
				description: tool.description || `Run the ${agent.name} subagent. ${agent.description}`,
				promptSnippet: tool.promptSnippet || `Run the ${agent.name} subagent`,
				promptGuidelines: tool.guidelines.length > 0 ? tool.guidelines : undefined,
				parameters: Type.Object({
					task: Type.Optional(
						Type.String({
							description: tool.taskDescription || "Optional task or scope for the subagent.",
						}),
					),
				}),
				async execute(_toolCallId, params, signal, _onUpdate, ctx) {
					if (getSubagentSessionMeta(ctx.sessionManager)) throw new Error(`Nested ${tool.name} execution is disabled.`);
					const currentAgent = findAgent(agent.name, ctx.cwd);
					if (!currentAgent) throw new Error(`Agent ${agent.name} not found. Create ~/.pi/agent/agents/${agent.name}.md or .pi/agents/${agent.name}.md.`);
					const task = params.task?.trim() || defaultTask || `Run the ${currentAgent.name} subagent for the appropriate task.`;
					const result = await runAgentForResult(pi, currentAgent, task, ctx, signal);
					return {
						content: [{ type: "text", text: formatSubagentToolText(currentAgent, task, result) }],
						details: { agent: currentAgent.name, task, result },
					};
				},
			});
		}
	};

	pi.registerCommand("agent", {
		description: "Run a subagent by name: /agent <name> <task>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
			if (!match) {
				const available = loadAgents(ctx.cwd).map((agent) => agent.name).join(", ") || "none";
				ctx.ui.notify(`Usage: /agent <name> <task>. Available: ${available}`, "info");
				return;
			}
			await startAgent(pi, match[1], match[2] ?? "", ctx);
		},
	});

	const registeredAgentCommands = new Set<string>();
	const registerAgentCommands = (cwd?: string) => {
		for (const agent of loadAgents(cwd)) {
			if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(agent.name)) continue;
			if (registeredAgentCommands.has(agent.name)) continue;
			registeredAgentCommands.add(agent.name);
			pi.registerCommand(agent.name, {
				description: `Run subagent: ${agent.description}`,
				handler: async (args, ctx) => {
					await startAgent(pi, agent.name, args.trim(), ctx);
				},
			});
		}
	};

	registerAgentCommands();
	pi.on("session_start", (_event, ctx) => {
		registerAgentTools(ctx.cwd);
		registerAgentCommands(ctx.cwd);
	});
}
