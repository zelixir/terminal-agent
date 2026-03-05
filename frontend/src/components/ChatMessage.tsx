import { useState } from 'react'
import { Copy, Send, ChevronDown, Settings, Terminal, Check, Bug } from 'lucide-react'
import { UIMessage, isTextUIPart, isToolOrDynamicToolUIPart } from 'ai'
import ApprovalDialog from './ApprovalDialog'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from './ui/dropdown-menu'
import { CodeBlock } from './ui/code'

interface Props {
  message: UIMessage
  sessionId: string
  serverId: number
  onAddSessionApproval: (command: string) => void
  /** When true, raw tool call JSON is shown alongside each tool part */
  debugMode?: boolean
}

/** Strip ANSI escape sequences from text */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[\x3c-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[>=]/g, '')
    .replace(/\x1b[^[\]()>=]/g, '')
    .replace(/\r/g, '')
}

function extractCodeBlocks(content: string): Array<{ type: 'text' | 'code'; content: string; lang?: string }> {
  const parts: Array<{ type: 'text' | 'code'; content: string; lang?: string }> = []
  const regex = /```(\w*)\n?([\s\S]*?)```/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: content.slice(lastIndex, match.index) })
    }
    parts.push({ type: 'code', content: match[2].trim(), lang: match[1] || 'bash' })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', content: content.slice(lastIndex) })
  }

  return parts
}

async function postAutoApproval(command: string, scope: string, serverId: number) {
  await fetch('/api/auto-approvals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pattern: command,
      is_regex: false,
      description: 'Auto-approved from chat',
      scope,
      server_id: scope === 'server' ? serverId : undefined,
    }),
  })
}

async function sendCommandToTerminal(sessionId: string, command: string) {
  try {
    await fetch(`/api/agent/${sessionId}/send-to-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    })
  } catch (err) {
    console.error('Failed to send command to terminal', err)
  }
}

function CommandBlock({ command, sessionId, serverId, onAddSessionApproval }: {
  command: string
  sessionId: string
  serverId: number
  onAddSessionApproval: (command: string) => void
}) {
  const [showApprovalDialog, setShowApprovalDialog] = useState(false)

  return (
    <div className="relative my-2">
      <div className="bg-gray-950 border border-gray-700 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800 border-b border-gray-700">
          <span className="text-xs text-gray-400 font-mono">bash</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" title="复制" onClick={() => navigator.clipboard.writeText(command)}>
              <Copy className="w-3 h-3" />
            </Button>
            <Button variant="ghost" size="icon" title="发送到终端" onClick={() => sendCommandToTerminal(sessionId, command)}>
              <Send className="w-3 h-3" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon"><ChevronDown className="w-3 h-3" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => postAutoApproval(command, 'global', serverId)}>允许此命令（所有服务器）</DropdownMenuItem>
                <DropdownMenuItem onClick={() => postAutoApproval(command, 'server', serverId)}>允许此命令（仅此服务器）</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAddSessionApproval(command)}>允许此命令（仅此会话）</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setShowApprovalDialog(true)}>允许命令...</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <CodeBlock className="rounded-none border-0 text-green-300">{command}</CodeBlock>
      </div>
      {showApprovalDialog && (
        <ApprovalDialog command={command} serverId={serverId} onClose={() => setShowApprovalDialog(false)} />
      )}
    </div>
  )
}

function ExecResult({ command, output, closed, exitCode, debugMode, debugData }: {
  command: string
  output?: string
  closed: boolean
  exitCode: number | null
  debugMode?: boolean
  debugData?: unknown
}) {
  const [copied, setCopied] = useState(false)
  const success = closed && exitCode === 0

  const handleCopy = () => {
    navigator.clipboard.writeText(output || command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="bg-gray-950 border border-gray-700 rounded-lg overflow-hidden my-2">
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Terminal className="w-3 h-3 text-green-400 flex-shrink-0" />
          <code className="text-xs text-green-300 font-mono truncate">{command}</code>
          {closed && (
            <span className={`text-xs flex-shrink-0 px-1 rounded ${success ? 'text-green-400' : 'text-red-400'}`}>
              [{exitCode ?? '?'}]
            </span>
          )}
        </div>
        <Button variant="ghost" size="icon" title="复制" onClick={handleCopy}>
          {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
        </Button>
      </div>
      {output ? (
        <CodeBlock className="rounded-none border-0 max-h-48 overflow-y-auto text-gray-300">{output}</CodeBlock>
      ) : !closed ? (
        <div className="p-3 flex items-center gap-2 text-xs text-gray-400">
          <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin" />
          执行中...
        </div>
      ) : null}
      {debugMode && (
        <details className="border-t border-gray-700">
          <summary className="px-3 py-1 text-xs text-yellow-400 cursor-pointer hover:bg-gray-800 flex items-center gap-1">
            <Bug className="w-3 h-3" /> 调试数据
          </summary>
          <CodeBlock className="rounded-none border-0 text-yellow-200 text-xs max-h-32 overflow-y-auto">{JSON.stringify(debugData, null, 2)}</CodeBlock>
        </details>
      )}
    </div>
  )
}

function RunCommandResult({ command, output, state, error, sessionId, serverId, onAddSessionApproval, debugMode, debugData }: {
  command: string
  output?: string
  state: string
  error?: string
  sessionId: string
  serverId: number
  onAddSessionApproval: (command: string) => void
  debugMode?: boolean
  debugData?: unknown
}) {
  const [copied, setCopied] = useState(false)
  const [showApprovalDialog, setShowApprovalDialog] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(output || command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="bg-gray-950 border border-gray-700 rounded-lg overflow-hidden my-2">
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Terminal className="w-3 h-3 text-green-400 flex-shrink-0" />
          <code className="text-xs text-green-300 font-mono truncate">{command}</code>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
          <Button variant="ghost" size="icon" title="复制" onClick={handleCopy}>
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          </Button>
          <Button variant="ghost" size="icon" title="发送到终端" onClick={() => sendCommandToTerminal(sessionId, command)}>
            <Send className="w-3 h-3" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon"><ChevronDown className="w-3 h-3" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => postAutoApproval(command, 'global', serverId)}>允许此命令（所有服务器）</DropdownMenuItem>
              <DropdownMenuItem onClick={() => postAutoApproval(command, 'server', serverId)}>允许此命令（仅此服务器）</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onAddSessionApproval(command)}>允许此命令（仅此会话）</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setShowApprovalDialog(true)}>允许命令...</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {state === 'output-available' && output && (
        <CodeBlock className="rounded-none border-0 max-h-48 overflow-y-auto text-gray-300">{stripAnsi(output)}</CodeBlock>
      )}
      {state === 'output-available' && error && (
        <div className="p-3 text-xs text-red-400 font-mono">{stripAnsi(error)}</div>
      )}
      {state !== 'output-available' && (
        <div className="p-3 flex items-center gap-2 text-xs text-gray-400">
          <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin" />
          执行中...
        </div>
      )}
      {debugMode && (
        <details className="border-t border-gray-700">
          <summary className="px-3 py-1 text-xs text-yellow-400 cursor-pointer hover:bg-gray-800 flex items-center gap-1">
            <Bug className="w-3 h-3" /> 调试数据
          </summary>
          <CodeBlock className="rounded-none border-0 text-yellow-200 text-xs max-h-32 overflow-y-auto">{JSON.stringify(debugData, null, 2)}</CodeBlock>
        </details>
      )}
      {showApprovalDialog && (
        <ApprovalDialog command={command} serverId={serverId} onClose={() => setShowApprovalDialog(false)} />
      )}
    </div>
  )
}

function GenericToolResult({ name, state, result, debugMode, debugData }: {
  name: string
  state: string
  result: unknown
  debugMode?: boolean
  debugData?: unknown
}) {
  return (
    <div className="bg-gray-800 border border-gray-600 rounded-lg p-3 text-xs my-1">
      <div className="flex items-center gap-1.5 mb-1 text-blue-400">
        <Settings className="w-3 h-3 animate-spin" style={{ animationPlayState: state === 'output-available' ? 'paused' : 'running' }} />
        <span className="font-mono">{name}</span>
      </div>
      {state === 'output-available' && result !== undefined && (
        <CodeBlock className="text-gray-300 text-xs max-h-32 overflow-y-auto bg-black/30 p-2 mt-1 border-0">
          {stripAnsi(typeof result === 'string' ? result : JSON.stringify(result, null, 2))}
        </CodeBlock>
      )}
      {debugMode && (
        <details className="mt-1">
          <summary className="text-xs text-yellow-400 cursor-pointer flex items-center gap-1">
            <Bug className="w-3 h-3" /> 调试数据
          </summary>
          <CodeBlock className="text-yellow-200 text-xs max-h-24 overflow-y-auto bg-black/30 p-2 mt-1 border-0">{JSON.stringify(debugData, null, 2)}</CodeBlock>
        </details>
      )}
    </div>
  )
}

export default function ChatMessage({ message, sessionId, serverId, onAddSessionApproval, debugMode }: Props) {
  const isUser = message.role === 'user'

  const renderContent = (content: string) => {
    const parts = extractCodeBlocks(content)
    return parts.map((part, i) => {
      if (part.type === 'code') {
        return (
          <CommandBlock key={i} command={part.content} sessionId={sessionId} serverId={serverId} onAddSessionApproval={onAddSessionApproval} />
        )
      }
      return (
        <p key={i} className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">{part.content}</p>
      )
    })
  }

  if (isUser) {
    const textContent = message.parts.filter(isTextUIPart).map(p => p.text).join('')
    return (
      <div className="flex justify-end">
        <div className="bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2 max-w-[85%]">
          <p className="text-sm whitespace-pre-wrap">{textContent}</p>
        </div>
      </div>
    )
  }

  const toolParts = message.parts.filter(isToolOrDynamicToolUIPart)
  const textParts = message.parts.filter(isTextUIPart)

  return (
    <div className="space-y-2">
      {/* Text first */}
      {textParts.length > 0 && (
        <div className="bg-gray-800 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[95%]">
          {textParts.map((part, i) => (
            <div key={i}>{renderContent(part.text)}</div>
          ))}
        </div>
      )}

      {/* Tool calls below */}
      {toolParts.map((part, i) => {
        const name = 'toolName' in part ? part.toolName : part.type.replace('tool-', '')
        const state = part.state
        const args = 'input' in part ? part.input : undefined
        const result = 'output' in part ? part.output : undefined
        const debugData = debugMode ? { name, state, input: args, output: result } : undefined

        if (name === 'exec') {
          const command = (args as any)?.command || ''
          const out = (result as any)?.output ?? ''
          const closed = (result as any)?.closed ?? (state === 'output-available')
          const exitCode = (result as any)?.exitCode ?? null
          return (
            <ExecResult key={i} command={command} output={out} closed={closed} exitCode={exitCode} debugMode={debugMode} debugData={debugData} />
          )
        }

        if (name === 'run-command') {
          const command = (args as any)?.command || ''
          const output = (result as any)?.result?.output || (result as any)?.output || ''
          const error = (result as any)?.result?.error || (result as any)?.error || ''
          return (
            <RunCommandResult key={i} command={command} output={output} state={state} error={error} sessionId={sessionId} serverId={serverId} onAddSessionApproval={onAddSessionApproval} debugMode={debugMode} debugData={debugData} />
          )
        }

        return (
          <GenericToolResult key={i} name={name} state={state} result={result} debugMode={debugMode} debugData={debugData} />
        )
      })}
    </div>
  )
}
