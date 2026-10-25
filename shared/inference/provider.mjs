// A local AI SDK v3 provider over caller-owned anonymous pipes.
import { read, writeSync } from 'node:fs';
import { isDeepStrictEqual, promisify } from 'node:util';

const readBytes = promisify(read);

export function createStdio(options) {
  const settings = JSON.parse(process.env.INFERENCE_PROVIDER);
  const reader = { fd: settings.readFd, pending: Buffer.alloc(0) };
  const state = { busy: false, failed: false, finished: false, id: 0, history: [], assistants: [] };
  const model = {
    specificationVersion: 'v3',
    provider: options.name,
    modelId: settings.model,
    supportedUrls: {},
    doGenerate: () => {
      throw new Error('Only the pinned headless streaming path is supported');
    },
    doStream: parameters => exchange(parameters, settings, reader, state),
  };
  return {
    specificationVersion: 'v3',
    languageModel(name) {
      if (name !== settings.model) throw new Error('Another model was requested');
      return model;
    },
  };
}

async function exchange(parameters, settings, reader, state) {
  if (state.busy || state.failed || state.finished) {
    state.failed = true;
    record(settings, { id: state.id, failure: 'A concurrent, auxiliary or post-completion request was attempted' });
    throw new Error('The single request lane is unavailable');
  }
  state.busy = true;
  const started = performance.now();
  const id = ++state.id;
  try {
    if (parameters.abortSignal?.aborted) throw new Error('Inference was cancelled');
    const messages = promptMessages(parameters.prompt, state.assistants);
    if (!isDeepStrictEqual(messages.slice(0, state.history.length), state.history))
      throw new Error('The session history changed or an auxiliary request was attempted');
    const tools = requestTools(parameters.tools ?? [], settings.tools);
    const request = {
      id,
      messages,
      tools,
      tool_choice: toolChoice(parameters.toolChoice),
      max_tokens: settings.outputTokens,
      ...settings.sampling,
    };
    writeLine(settings.writeFd, request);
    record(settings, { id, requested: true });
    const answer = JSON.parse(await readLine(reader));
    record(settings, {
      id,
      exchangeSeconds: (performance.now() - started) / 1000,
      usage: answer.usage ?? null,
      timings: answer.timings ?? null,
      finishReason: answer.choices?.[0]?.finish_reason ?? null,
    });
    const message = validateAnswer(answer, id, tools);
    state.assistants.push(structuredClone(message));
    state.history = [...messages, structuredClone(message)];
    state.finished = answer.choices[0].finish_reason === 'stop';
    return responseStream(answer);
  } catch (failure) {
    state.failed = true;
    record(settings, { id, failure: failure.message });
    throw failure;
  } finally {
    state.busy = false;
  }
}

function promptMessages(prompt, assistants) {
  let index = 0;
  const messages = prompt.flatMap(message => {
    if (message.role === 'system') return [{ role: 'system', content: message.content }];
    if (message.role === 'user') return [{ role: 'user', content: textContent(message.content) }];
    if (message.role === 'tool') return message.content.map(toolResult);
    if (message.role !== 'assistant') throw new Error('Unsupported message role');
    const original = assistants[index++];
    if (!original) throw new Error('An assistant message did not come from this runtime');
    const content = message.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('');
    const calls = message.content
      .filter(part => part.type === 'tool-call')
      .map(part => ({
        id: part.toolCallId,
        name: part.toolName,
        arguments: part.input,
      }));
    const expected = (original.tool_calls ?? []).map(call => ({
      id: call.id,
      name: call.function.name,
      arguments: JSON.parse(call.function.arguments),
    }));
    if (content !== (original.content ?? '') || !isDeepStrictEqual(calls, expected))
      throw new Error('OpenCode changed the assistant text or tool calls');
    if (message.content.some(part => !['text', 'reasoning', 'tool-call'].includes(part.type)))
      throw new Error('Unsupported assistant content');
    // The SDK normalizes reasoning. Replay the entire original message, including fields it does not expose.
    return [structuredClone(original)];
  });
  if (index !== assistants.length) throw new Error('An assistant message was dropped');
  return messages;
}

function textContent(parts) {
  if (!parts.every(part => part.type === 'text')) throw new Error('Only text inputs are supported');
  return parts.map(part => part.text).join('');
}

function toolResult(part) {
  if (part.type !== 'tool-result') throw new Error('Unsupported tool message');
  const output = part.output;
  if (!['text', 'json', 'error-text', 'error-json'].includes(output.type)) throw new Error('Unsupported tool output');
  const content = output.type.endsWith('json') ? JSON.stringify(output.value) : output.value;
  return { role: 'tool', tool_call_id: part.toolCallId, content };
}

function requestTools(tools, allowed) {
  return tools.map(tool => {
    if (tool.type !== 'function' || !allowed.includes(tool.name)) throw new Error('An unapproved tool was exposed');
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema,
      },
    };
  });
}

function toolChoice(choice) {
  if (!choice || choice.type === 'auto') return 'auto';
  if (['none', 'required'].includes(choice.type)) return choice.type;
  throw new Error('Unsupported tool choice');
}

function validateAnswer(answer, id, tools) {
  if (answer.id !== id || answer.error || answer.choices?.length !== 1) throw new Error('Invalid runtime answer');
  const { message, finish_reason: finish } = answer.choices[0];
  if (!['stop', 'tool_calls'].includes(finish)) throw new Error('Runtime answer is truncated or unsuccessful');
  if (message?.role !== 'assistant') throw new Error('Runtime did not return an assistant');
  if (message.content != null && typeof message.content !== 'string') throw new Error('Invalid assistant text');
  if (message.reasoning_content != null && typeof message.reasoning_content !== 'string')
    throw new Error('Invalid reasoning text');
  const calls = message.tool_calls ?? [];
  if (!Array.isArray(calls) || (finish === 'tool_calls') !== calls.length > 0)
    throw new Error('Tool calls and finish reason disagree');
  const ids = new Set();
  for (const call of calls) {
    if (
      call.type !== 'function' ||
      typeof call.id !== 'string' ||
      ids.has(call.id) ||
      !tools.some(tool => tool.function.name === call.function?.name)
    )
      throw new Error('Invalid or unapproved tool call');
    ids.add(call.id);
    const argumentsObject = JSON.parse(call.function.arguments);
    if (!argumentsObject || Array.isArray(argumentsObject) || typeof argumentsObject !== 'object')
      throw new Error('Tool arguments must be an object');
  }
  return message;
}

function responseParts(answer) {
  const { message, finish_reason: finish } = answer.choices[0];
  const parts = [{ type: 'stream-start', warnings: [] }];
  for (const [type, text] of [
    ['reasoning', message.reasoning_content],
    ['text', message.content],
  ]) {
    if (!text) continue;
    parts.push({ type: `${type}-start`, id: type });
    parts.push({ type: `${type}-delta`, id: type, delta: text });
    parts.push({ type: `${type}-end`, id: type });
  }
  for (const call of message.tool_calls ?? [])
    parts.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.function.name,
      input: call.function.arguments,
    });
  parts.push({
    type: 'finish',
    finishReason: { unified: finish === 'stop' ? 'stop' : 'tool-calls', raw: finish },
    usage: {
      inputTokens: {
        total: answer.usage?.prompt_tokens,
        noCache: undefined,
        cacheRead: answer.usage?.prompt_tokens_details?.cached_tokens,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: answer.usage?.completion_tokens,
        text: undefined,
        reasoning: answer.usage?.completion_tokens_details?.reasoning_tokens,
      },
    },
  });
  return parts;
}

function responseStream(answer) {
  const parts = responseParts(answer);
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

function writeLine(fd, value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
}

function record(settings, measurement) {
  writeLine(settings.eventsFd, { phase: settings.phase ?? 'execution', ...measurement });
}

async function readLine(reader) {
  while (!reader.pending.includes(10)) {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await readBytes(reader.fd, buffer, 0, buffer.length, null);
    if (!bytesRead) throw new Error('Runtime ended before its answer');
    reader.pending = Buffer.concat([reader.pending, buffer.subarray(0, bytesRead)]);
  }
  const end = reader.pending.indexOf(10);
  const line = reader.pending.subarray(0, end).toString('utf8');
  reader.pending = reader.pending.subarray(end + 1);
  return line;
}
