import { describe, expect, it, vi } from 'vitest'
import { generateText, streamText, tool, wrapLanguageModel, type LanguageModelMiddleware } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { utilityToolContractMiddleware } from '../spec-client'

type StreamArguments = Parameters<NonNullable<LanguageModelMiddleware['wrapStream']>>[0]
type GenerateArguments = Parameters<NonNullable<LanguageModelMiddleware['wrapGenerate']>>[0]
type LanguageModelV4StreamPart = Awaited<ReturnType<StreamArguments['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never
type LanguageModelV4Content = Awaited<ReturnType<GenerateArguments['doGenerate']>>['content'][number]
type LanguageModelV4FunctionTool = Extract<NonNullable<StreamArguments['params']['tools']>[number], { type: 'function' }>

const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } }
const providerMetadata = { gateway: { generationId: 'generation-fixture', cost: '0.0001' } }
const finalOutput: LanguageModelV4FunctionTool = { type: 'function', name: 'eve__reply', inputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } }
const extensionTool: LanguageModelV4FunctionTool = { type: 'function', name: 'self-modification__agent', inputSchema: { type: 'object' } }
const call = (toolName = 'eve__reply', providerExecuted = false): LanguageModelV4Content => ({ type: 'tool-call', toolName, toolCallId: 'call-1', input: '{"answer":"yes"}', providerExecuted })
const finish: LanguageModelV4StreamPart = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage, providerMetadata }
function model(content: LanguageModelV4Content[] = [{ type: 'text', text: 'ok' }], parts?: LanguageModelV4StreamPart[]) {
  const inner = new MockLanguageModelV4({ provider: 'gateway', modelId: 'deepseek/deepseek-v4-flash',
    doGenerate: async () => ({ content, usage, providerMetadata, finishReason: { unified: 'stop', raw: 'stop' }, warnings: [] }),
    doStream: async () => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
      for (const part of parts ?? [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, finish]) controller.enqueue(part)
      controller.close()
    } }) }),
  })
  return { inner, wrapped: wrapLanguageModel({ model: inner, middleware: utilityToolContractMiddleware() }) }
}
async function readAll(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const reader = stream.getReader(), parts: LanguageModelV4StreamPart[] = []
  try { for (;;) { const next = await reader.read(); if (next.done) return parts; parts.push(next.value) } }
  finally { reader.releaseLock() }
}

describe('utility tool contract, enforced at the actual model boundary', () => {
  it('removes extension and provider tools for plaintext while preserving identity, options and usage', async () => {
    const m = model(), providerOptions = { gateway: { only: ['alibaba'] }, deepseek: { thinking: { type: 'disabled' } } }
    const result = await m.wrapped.doGenerate({ prompt: [], tools: [extensionTool, { type: 'provider', id: 'provider.search', name: 'search', args: {} }], toolChoice: { type: 'tool', toolName: extensionTool.name }, providerOptions, maxOutputTokens: 900 })
    expect(m.inner.doGenerateCalls[0]).toMatchObject({ tools: undefined, toolChoice: { type: 'none' }, providerOptions, maxOutputTokens: 900 })
    expect(m.wrapped.provider).toBe('gateway')
    expect(m.wrapped.modelId).toBe(m.inner.modelId)
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'ok' }], usage, providerMetadata })
  })
  it('retains only the original structured eve__reply declaration and its schema', async () => {
    const m = model([call()])
    await m.wrapped.doGenerate({ prompt: [], tools: [extensionTool, finalOutput], toolChoice: { type: 'required' } })
    expect(m.inner.doGenerateCalls[0]).toMatchObject({ tools: [finalOutput], toolChoice: { type: 'required' } })
  })
  it.each([['self-modification__agent', false], ['agent', false], ['eve__reply', true]] as const)('rejects generated %s (providerExecuted=%s) before SDK execution', async (name, providerExecuted) => {
    const m = model([call(name, providerExecuted)])
    await expect(m.wrapped.doGenerate({ prompt: [], tools: [extensionTool, finalOutput] })).rejects.toThrow('unexpected tool output')
  })
  it('does not permit unsolicited eve__reply without an original function declaration', async () => {
    const m = model([call()])
    await expect(m.wrapped.doGenerate({ prompt: [], tools: [extensionTool] })).rejects.toThrow('unexpected tool output')
  })
  it('preserves legitimate structured input events, answer call and finish metadata', async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: 'tool-input-start', id: 'call-1', toolName: 'eve__reply' },
      { type: 'tool-input-delta', id: 'call-1', delta: '{"answer":"yes"}' },
      { type: 'tool-input-end', id: 'call-1' }, call() as LanguageModelV4StreamPart, finish,
    ]
    const m = model([], parts)
    const result = await m.wrapped.doStream({ prompt: [], tools: [extensionTool, finalOutput] })
    expect(await readAll(result.stream)).toEqual(parts)
    expect(m.inner.doStreamCalls[0].tools).toEqual([finalOutput])
  })
  it.each([
    { type: 'tool-input-start', id: 'x', toolName: 'self-modification__agent' },
    { type: 'tool-input-delta', id: 'unknown', delta: '{}' },
    { type: 'tool-input-end', id: 'unknown' },
    { type: 'tool-call', toolCallId: 'x', toolName: 'self-modification__agent', input: '{}' },
    { type: 'tool-call', toolCallId: 'x', toolName: 'eve__reply', input: '{}', providerExecuted: true },
    { type: 'tool-approval-request', approvalId: 'approval', toolCallId: 'x' },
    { type: 'tool-result', toolCallId: 'x', toolName: 'eve__reply', result: {} },
  ] satisfies LanguageModelV4StreamPart[])('rejects streamed $type before it can escape the boundary', async part => {
    const m = model([], [part, finish])
    const result = await m.wrapped.doStream({ prompt: [], tools: [extensionTool, finalOutput] })
    await expect(readAll(result.stream)).rejects.toThrow('unexpected tool output')
  })
  it('rejects a forbidden completed call even after an allowed eve__reply start', async () => {
    const m = model([], [{ type: 'tool-input-start', id: 'call-1', toolName: 'eve__reply' }, call('self-modification__agent') as LanguageModelV4StreamPart, finish])
    const result = await m.wrapped.doStream({ prompt: [], tools: [finalOutput, extensionTool] })
    await expect(readAll(result.stream)).rejects.toThrow('unexpected tool output')
  })
  it('cancels an open upstream stream when an unexpected tool starts', async () => {
    const cancel = vi.fn()
    const inner = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) { controller.enqueue({ type: 'tool-input-start', id: 'x', toolName: 'self-modification__agent' }) },
      cancel,
    }) }) })
    const wrapped = wrapLanguageModel({ model: inner, middleware: utilityToolContractMiddleware() })
    const result = await wrapped.doStream({ prompt: [], tools: [extensionTool] })
    await expect(readAll(result.stream)).rejects.toThrow('unexpected tool output')
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('propagates a provider setup error without inventing text or usage', async () => {
    const failure = new Error('fixture setup failure')
    const inner = new MockLanguageModelV4({ doStream: async () => { throw failure } })
    const wrapped = wrapLanguageModel({ model: inner, middleware: utilityToolContractMiddleware() })
    await expect(wrapped.doStream({ prompt: [] })).rejects.toBe(failure)
    expect(inner.doStreamCalls).toHaveLength(1)
  })
  it('actual SDK cannot execute a hallucinated extension tool still known by the outer harness', async () => {
    const execute = vi.fn(async () => 'must never execute')
    const m = model([call('self-modification__agent')])
    await expect(generateText({ model: m.wrapped, prompt: 'Resolve one field.', maxRetries: 0,
      tools: { 'self-modification__agent': tool({ inputSchema: z.object({ answer: z.string() }), execute }) },
    })).rejects.toThrow('unexpected tool output')
    expect(execute).not.toHaveBeenCalled()
    expect(m.inner.doGenerateCalls).toHaveLength(1)
  })
  it('actual streaming SDK cannot execute an unsolicited namespaced tool', async () => {
    const execute = vi.fn(async () => 'must never execute'), errors: unknown[] = []
    const m = model([], [call('self-modification__agent') as LanguageModelV4StreamPart, finish])
    const result = streamText({ model: m.wrapped, prompt: 'Resolve one field.', maxRetries: 0,
      tools: { 'self-modification__agent': tool({ inputSchema: z.object({ answer: z.string() }), execute }) },
    })
    try {
      for await (const part of result.fullStream) if (part.type === 'error') errors.push(part.error)
    } catch (error) { errors.push(error) }
    expect(execute).not.toHaveBeenCalled()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('unexpected tool output')
    expect(m.inner.doStreamCalls).toHaveLength(1)
  })
  it('actual SDK retains the legitimate structured result path', async () => {
    const execute = vi.fn(async value => value)
    const m = model([call()])
    const result = await generateText({ model: m.wrapped, prompt: 'Return a structured answer.', maxRetries: 0,
      tools: { eve__reply: tool({ inputSchema: z.object({ answer: z.string() }), execute }) },
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(result.toolResults[0]?.output).toEqual({ answer: 'yes' })
  })
})
