import {
  APICallError,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  SharedV3Warning,
  LanguageModelV3FunctionTool,
  LanguageModelV3ToolChoice,
  LanguageModelV3Prompt,
  LanguageModelV3ProviderTool,
} from '@ai-sdk/provider';
import {
  ParseResult,
  combineHeaders,
  createEventSourceResponseHandler,
  createJsonResponseHandler,
  generateId,
  postJsonToApi,
} from '@ai-sdk/provider-utils';
import { z } from 'zod';

type DashscopeMessage =
  | { role: 'system'; content: string }
  | {
    role: 'user';
    content:
    | string
    | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;
  }
  | {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  }
  | { role: 'tool'; tool_call_id: string; content: string };

type DashscopeTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

type DashscopeToolChoice =
  | 'auto'
  | 'none'
  | { type: 'function'; function: { name: string } };

type DashscopeChatRequest = {
  model: string;
  messages: DashscopeMessage[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  max_tokens?: number;
  stop?: string[];
  tools?: DashscopeTool[];
  tool_choice?: DashscopeToolChoice;
  [key: string]: unknown;
};

const dashscopeChatResponseSchema = z.object({
  id: z.string(),
  choices: z.array(
    z.object({
      delta: z.object({
        role: z.string().nullable().optional(),
        content: z.string().nullable().optional(),
        tool_calls: z.array(
          z.object({
            index: z.number(),
            id: z.string().optional(),
            type: z.literal('function').optional(),
            function: z.object({
              name: z.string().optional(),
              arguments: z.string().nullable().optional(),
            }),
          })
        ).nullable().optional(),
      }),
      finish_reason: z.string().nullable().optional(),
    })
  ),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
  }).nullable().optional(),
});

export class DashscopeChatLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3';
  readonly provider = 'dashscope';

  readonly #usage = {
    promptTokens: 0,
    completionTokens: 0,
  };
  takeUsage() {
    const usage = { ...this.#usage };
    this.#usage.promptTokens = 0;
    this.#usage.completionTokens = 0;
    return usage;
  }

  constructor(readonly modelId: string, readonly apiKey: string, readonly baseUrl: string) { }

  readonly supportedUrls = {
    'image/*': [/^https?:\/\//, /^data:image\//],
  };

  async doGenerate(options: LanguageModelV3CallOptions): Promise<{
    content: Array<LanguageModelV3Content>;
    finishReason: LanguageModelV3FinishReason;
    usage: {
      inputTokens: {
        total: number | undefined;
        noCache: number | undefined;
        cacheRead: number | undefined;
        cacheWrite: number | undefined;
      };
      outputTokens: {
        total: number | undefined;
        text: number | undefined;
        reasoning: number | undefined;
      };
    };
    warnings: Array<SharedV3Warning>;
    request?: { body?: string };
    response?: { headers?: Record<string, string>; body?: string };
  }> {
    const { body, headers } = this.prepareRequest(options, false);
    // console.log('DashscopeChatLanguageModel.doGenerate body:', JSON.stringify(body, null, 2));
    const { responseHeaders, value: response } = await postJsonToApi({
      url: this.baseUrl + '/chat/completions',
      headers,
      body,
      failedResponseHandler: async ({ response, url, requestBodyValues }) => {
        const responseBody = await response.text();
        return {
          value: new APICallError({
            message: `Dashscope API error: ${response.status} ${responseBody}`,
            url,
            requestBodyValues,
            statusCode: response.status,
            responseBody,
            isRetryable: true,
          }),
        };
      },
      successfulResponseHandler: createJsonResponseHandler(
        z.object({
          id: z.string(),
          choices: z.array(
            z.object({
              message: z.object({
                role: z.string().nullable().optional(),
                content: z.string().nullable(),
                tool_calls: z.array(
                  z.object({
                    id: z.string(),
                    type: z.literal('function'),
                    function: z.object({
                      name: z.string(),
                      arguments: z.string().nullable().optional(),
                    }),
                  })
                ).nullable().optional(),
              }),
              finish_reason: z.string().nullable(),
            })
          ),
          usage: z.object({
            prompt_tokens: z.number(),
            completion_tokens: z.number(),
          }).nullable().optional(),
        })
      ),
      abortSignal: options.abortSignal,
    });

    const choice = response.choices[0];
    const content: Array<LanguageModelV3Content> = [];

    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        content.push({
          type: 'tool-call',
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          input: toolCall.function.arguments,
        });
      }
    }

    if (response.usage) {
      this.#usage.promptTokens += response.usage.prompt_tokens;
      this.#usage.completionTokens += response.usage.completion_tokens;
    }

    return {
      content,
      finishReason: mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: {
          total: response.usage?.prompt_tokens,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: response.usage?.completion_tokens,
          text: undefined,
          reasoning: undefined,
        },
      },
      warnings: [],
      request: { body: JSON.stringify(body) },
      response: { headers: responseHeaders, body: JSON.stringify(response) },
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV3StreamPart>;
    request?: { body?: string };
    response?: { headers?: Record<string, string> };
  }> {
    const { body, headers } = this.prepareRequest(options, true);
    // console.log('DashscopeChatLanguageModel.doStream body:', JSON.stringify(body, null, 2));
    const { responseHeaders, value: stream } = await postJsonToApi({
      url: this.baseUrl + '/chat/completions',
      headers,
      body,
      failedResponseHandler: async ({ response, url, requestBodyValues }) => {
        const responseBody = await response.text();
        return {
          value: new APICallError({
            message: `Dashscope API error: ${response.status} ${responseBody}`,
            url,
            requestBodyValues,
            statusCode: response.status,
            responseBody,
            isRetryable: true,
          }),
        };
      },
      successfulResponseHandler: createEventSourceResponseHandler(
        dashscopeChatResponseSchema
      ),
      abortSignal: options.abortSignal,
    });

    let finishReason: LanguageModelV3FinishReason = { unified: 'other', raw: undefined };
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined = undefined;
    let isActiveText = false;
    let responseId: string | undefined;
    const toolCalls: Array<{
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string;
      };
      hasFinished: boolean;
    }> = [];

    return {
      stream: stream.pipeThrough(
        new TransformStream<
          ParseResult<z.infer<typeof dashscopeChatResponseSchema>>,
          LanguageModelV3StreamPart
        >({
          start: controller => {
            controller.enqueue({ type: 'stream-start', warnings: [] });
          },
          transform: (chunk, controller) => {
            // console.log('Dashscope stream chunk:', JSON.stringify(chunk));
            if (!chunk.success) {
              controller.enqueue({ type: 'error', error: (chunk as any).error });
              return;
            }

            const value = chunk.value;
            const choice = value.choices[0];
            responseId = value.id;

            if (value.usage) {
              usage = value.usage;
            }

            if (choice?.finish_reason) {
              finishReason = mapFinishReason(choice.finish_reason);
            }

            if (choice?.delta.content) {
              if (!isActiveText) {
                controller.enqueue({ type: 'text-start', id: value.id });
                isActiveText = true;
              }
              controller.enqueue({
                type: 'text-delta',
                delta: choice.delta.content,
                id: value.id,
              });
            }

            if (choice?.delta.tool_calls) {
              for (const toolCallDelta of choice.delta.tool_calls) {
                const index = toolCallDelta.index;

                if (!toolCalls[index]) {
                  const id = toolCallDelta.id ?? generateId();
                  const name = toolCallDelta.function.name ?? '';
                  const args = toolCallDelta.function.arguments ?? '';

                  toolCalls[index] = {
                    id,
                    type: 'function',
                    function: { name, arguments: args },
                    hasFinished: false,
                  };

                  controller.enqueue({
                    type: 'tool-input-start',
                    toolName: name,
                    id,
                  });

                  if (args) {
                    controller.enqueue({
                      type: 'tool-input-delta',
                      delta: args,
                      id,
                    });
                  }
                } else {
                  const toolCall = toolCalls[index];
                  if (toolCallDelta.function.arguments) {
                    toolCall.function.arguments += toolCallDelta.function.arguments;
                    controller.enqueue({
                      type: 'tool-input-delta',
                      delta: toolCallDelta.function.arguments,
                      id: toolCall.id,
                    });
                  }
                }
              }
            }
          },
          flush: controller => {
            if (isActiveText) {
              controller.enqueue({ type: 'text-end', id: responseId ?? '0' });
            }

            for (const toolCall of toolCalls) {
              if (toolCall && !toolCall.hasFinished) {
                controller.enqueue({
                  type: 'tool-input-end',
                  id: toolCall.id,
                });
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: toolCall.id,
                  toolName: toolCall.function.name,
                  input: toolCall.function.arguments,
                });
                toolCall.hasFinished = true;
              }
            }

            if (usage) {
              this.#usage.promptTokens += usage.prompt_tokens;
              this.#usage.completionTokens += usage.completion_tokens;
            }

            controller.enqueue({
              type: 'finish',
              finishReason,
              usage: {
                inputTokens: {
                  total: usage?.prompt_tokens,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: usage?.completion_tokens,
                  text: undefined,
                  reasoning: undefined,
                },
              },
            });
          },
        })
      ),
      request: { body: JSON.stringify(body) },
      response: { headers: responseHeaders },
    };
  }

  private prepareRequest(
    options: LanguageModelV3CallOptions,
    stream: boolean
  ): { body: DashscopeChatRequest; headers: Record<string, string> } {
    const messages = toDashscopeMessages(options.prompt);
    const tools = options.tools?.length ? toDashscopeTools(options.tools) : undefined;
    const toolChoice = options.toolChoice ? toDashscopeToolChoice(options.toolChoice) : undefined;

    const body: DashscopeChatRequest = {
      model: this.modelId,
      messages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      temperature: options.temperature,
      top_p: options.topP,
      top_k: options.topK,
      presence_penalty: options.presencePenalty,
      frequency_penalty: options.frequencyPenalty,
      seed: options.seed,
      max_tokens: options.maxOutputTokens,
      stop: options.stopSequences,
      tools,
      tool_choice: toolChoice,
      ...options.providerOptions?.dashscope,
    };

    const headers = combineHeaders(options.headers, {
      Authorization: `Bearer ${this.apiKey}`,
    });

    return { body, headers };
  }
}

function toDashscopeMessages(prompt: LanguageModelV3Prompt): DashscopeMessage[] {
  const messages: DashscopeMessage[] = [];
  for (const message of prompt) {
    if (message.role === 'system') {
      messages.push({ role: 'system', content: message.content });
    } else if (message.role === 'user') {
      const content = message.content.map(part => {
        if (part.type === 'text') {
          return { type: 'text', text: part.text };
        }
        if (part.type === 'file') {
          let url: string;
          if (typeof part.data === 'string') {
            if (part.data.startsWith('http') || part.data.startsWith('data:')) {
              url = part.data;
            } else {
              url = `data:${part.mediaType};base64,${part.data}`;
            }
          } else if (part.data instanceof Uint8Array) {
            const base64 = Buffer.from(part.data).toString('base64');
            url = `data:${part.mediaType};base64,${base64}`;
          } else {
            url = part.data.toString();
          }
          return { type: 'image_url', image_url: { url } };
        }
        return null;
      }).filter((part): part is { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } => part !== null);

      messages.push({ role: 'user', content });
    } else if (message.role === 'assistant') {
      let content = '';
      const tool_calls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }> = [];
      for (const part of message.content) {
        if (part.type === 'text') {
          content += part.text;
        } else if (part.type === 'tool-call') {
          tool_calls.push({
            id: part.toolCallId,
            type: 'function',
            function: {
              name: part.toolName,
              arguments: JSON.stringify(part.input),
            },
          });
        }
      }
      const msg: DashscopeMessage = { role: 'assistant', content: content || null };
      if (tool_calls.length > 0) {
        msg.tool_calls = tool_calls;
      }
      messages.push(msg);
    } else if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          let content = '';
          if (part.output.type === 'text' || part.output.type === 'error-text') {
            content = part.output.value;
          } else if (part.output.type === 'json' || part.output.type === 'error-json') {
            content = JSON.stringify(part.output.value);
          } else if (part.output.type === 'content') {
            content = JSON.stringify(part.output.value);
          } else if (part.output.type === 'execution-denied') {
            content = `Execution denied: ${part.output.reason}`;
          }

          messages.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            content,
          });
        } else if (part.type === 'tool-approval-response') {
          if (!part.approved) {
            messages.push({
              role: 'tool',
              tool_call_id: part.approvalId,
              content: `Execution denied: ${part.reason ?? ''}`,
            });
          }
        }
      }
    }
  }
  return messages;
}

function toDashscopeTools(tools: Array<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool>): DashscopeTool[] {
  return tools.map(tool => {
    if (tool.type === 'provider') {
      // Provider tools are not supported by Dashscope directly in this implementation
      // You might want to throw an error or handle them differently
      throw new Error('Provider tools are not supported by Dashscope');
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    };
  });
}

function toDashscopeToolChoice(toolChoice: LanguageModelV3ToolChoice): DashscopeToolChoice | undefined {
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'tool') {
    return {
      type: 'function',
      function: {
        name: toolChoice.toolName,
      },
    };
  }
  return undefined;
}

function mapFinishReason(finishReason: string | null | undefined): LanguageModelV3FinishReason {
  switch (finishReason) {
    case 'stop':
      return { unified: 'stop', raw: finishReason };
    case 'length':
      return { unified: 'length', raw: finishReason };
    case 'tool_calls':
      return { unified: 'tool-calls', raw: finishReason };
    case 'content_filter':
      return { unified: 'content-filter', raw: finishReason };
    default:
      return { unified: 'other', raw: finishReason ?? undefined };
  }
}

export default function dashscope(modelId: string): DashscopeChatLanguageModel {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY environment variable is not set');
  const baseUrl = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return new DashscopeChatLanguageModel(modelId, apiKey, baseUrl);
}

