import { ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { sendInput, getScreenContent, runCommandAndWait, execOnSession } from "./terminal";
import { checkAutoApproval } from "./db";
import type { LanguageModel } from "ai";

// Debug logging — enable by setting DEBUG_AGENT=1 in environment
const DEBUG = process.env.DEBUG_AGENT === "1";
function dbg(...args: unknown[]) {
  if (DEBUG) console.log("[agent:debug]", ...args);
}

export interface ApprovalRequest {
  id: string;
  command: string;
  sessionId: string;
  resolve: (approved: boolean) => void;
}

const pendingApprovals = new Map<string, ApprovalRequest>();

export function getPendingApprovals() {
  return Array.from(pendingApprovals.values()).map(({ id, command, sessionId }) => ({ id, command, sessionId }));
}

export function resolveApproval(id: string, approved: boolean) {
  const approval = pendingApprovals.get(id);
  if (approval) {
    pendingApprovals.delete(id);
    approval.resolve(approved);
  }
}

export interface AgentContext {
  sessionId: string;
  serverId: number;
  sudoPassword?: string;
  onApprovalNeeded: (approval: { id: string; command: string }) => void;
}

function createTools(ctx: AgentContext) {
  async function requireApproval(command: string): Promise<boolean> {
    if (checkAutoApproval(command, ctx.serverId)) return true;
    return new Promise<boolean>((resolve) => {
      const id = `approval_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      pendingApprovals.set(id, { id, command, sessionId: ctx.sessionId, resolve });
      ctx.onApprovalNeeded({ id, command });
    });
  }

  return {
    /**
     * exec — runs a command via a dedicated SSH exec channel (separate from the
     * interactive shell).  Output is streamed as preliminary results and a final
     * result is always yielded once the channel closes or the timeout expires.
     *
     * Key fix: both stdout AND stderr are consumed so the ssh2 close event is
     * guaranteed to fire (unread stderr causes backpressure that can stall it).
     */
    "exec": tool({
      description: "通过独立 SSH exec 通道执行命令，实时流式返回输出。适合不需要交互的命令。",
      inputSchema: z.object({
        command: z.string().describe("要执行的命令"),
        timeout: z.number().optional().describe("超时时间（毫秒），默认 30000"),
      }),
      async *execute({ command, timeout = 30000 }) {
        dbg("exec start:", command);

        const approved = await requireApproval(command);
        if (!approved) {
          yield { output: "命令被用户拒绝", closed: true, exitCode: null, command };
          return;
        }

        let output = "";

        // Preliminary yield — signals the UI that the command has started
        yield { output: "", closed: false, exitCode: null, command };

        try {
          const execPromise = execOnSession(ctx.sessionId, command, (data) => {
            output += data;
            dbg("exec data chunk:", data.slice(0, 100));
          });

          let timeoutId: ReturnType<typeof setTimeout>;
          const timeoutPromise = new Promise<{ exitCode: number | null }>(
            (_, reject) => {
              timeoutId = setTimeout(
                () => reject(new Error(`命令超时（${timeout}ms）`)),
                timeout
              );
            }
          );

          const { exitCode } = await Promise.race([execPromise, timeoutPromise]);
          clearTimeout(timeoutId!);
          dbg("exec closed, exitCode:", exitCode, "outputLen:", output.length);
          yield { output, closed: true, exitCode, command };
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          dbg("exec error:", errMsg);
          yield { output: output + "\n" + errMsg, closed: true, exitCode: null, command };
        }
      },
    }),

    "run-command": tool({
      description: "在终端中运行命令并获取输出。适用于不需要交互输入的标准命令。",
      inputSchema: z.object({
        command: z.string().describe("要运行的命令"),
        timeout: z.number().optional().describe("超时时间（毫秒），默认 30000"),
      }),
      async *execute({ command, timeout }) {
        yield { state: "loading" as const };
        const approved = await requireApproval(command);

        if (!approved) {
          yield { state: "ready" as const, result: { error: "命令被用户拒绝" } };
          return;
        }

        try {
          const output = await runCommandAndWait(ctx.sessionId, command, timeout || 30000);
          yield { state: "ready" as const, result: { output, success: true } };
        } catch (e: unknown) {
          const error = e instanceof Error ? e.message : String(e);
          yield { state: "error" as const, error };
        }
      },
    }),

    "send-input": tool({
      description: "向终端发送输入（例如 sudo 密码、MySQL 命令等 REPL 模式下的输入）。在 run-command 等待输入时使用。",
      inputSchema: z.object({
        input: z.string().describe("要发送的输入内容（如密码、命令）"),
        press_enter: z.boolean().optional().describe("是否在输入后按回车，默认 true"),
      }),
      async *execute({ input, press_enter = true }) {
        yield { state: "loading" as const };
        sendInput(ctx.sessionId, input + (press_enter ? "\r" : ""));
        await new Promise((r) => setTimeout(r, 1000));
        const screen = getScreenContent(ctx.sessionId);
        yield { state: "ready" as const, result: { screen: screen.slice(-2000), sent: input } };
      },
    }),

    "get-screen": tool({
      description: "获取当前终端屏幕内容以查看显示内容。",
      inputSchema: z.object({}),
      async *execute() {
        const content = getScreenContent(ctx.sessionId);
        yield { state: "ready" as const, result: { content: content.slice(-3000) } };
      },
    }),

    "wait-for-output": tool({
      description: "等待终端输出中出现特定模式。",
      inputSchema: z.object({
        pattern: z.string().describe("等待的字符串或正则表达式模式"),
        timeout: z.number().optional().describe("超时时间（毫秒），默认 15000"),
      }),
      async *execute({ pattern, timeout = 15000 }) {
        yield { state: "loading" as const };
        await new Promise((r) => setTimeout(r, timeout / 2));
        const content = getScreenContent(ctx.sessionId);
        yield { state: "ready" as const, result: { content: content.slice(-3000), matched: content.includes(pattern) } };
      },
    }),
  };
}

export function createTerminalAgent(model: LanguageModel, ctx: AgentContext) {
  const instructions = `你是一个服务器诊断 agent。你帮助用户通过终端命令诊断和修复服务器问题。
你可以使用工具来运行命令、发送输入并查看终端屏幕。
优先使用 exec 工具执行命令，它通过独立 SSH exec 通道运行命令并实时流式返回输出。
运行 sudo 命令时，先使用 exec，然后在命令等待输入时用 send-input 提供密码。${ctx.sudoPassword ? `\n此服务器的 sudo/su 密码是：${ctx.sudoPassword}` : ""}
对于 MySQL REPL，先运行 mysql 命令，然后用 send-input 发送后续 SQL 命令。
在运行命令之前，请先解释你要做什么。
所有命令在执行前都需要审批——这由工具自动处理。
在开始处理用户的第一个请求时，请先调用 get-screen 工具获取当前终端屏幕内容，了解终端的当前状态。`;

  return new ToolLoopAgent({
    model,
    instructions,
    tools: createTools(ctx),
    stopWhen: [(p) => (p.steps?.length ?? 0) >= 20],
  });
}
