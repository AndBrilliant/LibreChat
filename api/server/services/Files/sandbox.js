const { logger } = require('@librechat/data-schemas');

/**
 * Diverts file content (currently: images) away from the outbound model
 * request and into a per-conversation sandbox session instead. The model
 * only ever sees a text note that the file landed in the sandbox — never
 * the actual bytes. Upload/storage/UI are untouched; this only affects
 * what gets attached to the request sent to the model provider.
 *
 * ADR fork addition — not upstream LibreChat.
 */

const SANDBOX_MCP_URL = 'http://host.docker.internal:9024/mcp';

/** conversationId -> sandbox session_id, in-memory (resets on api container restart; self-healing via sandbox_session_list) */
const sessionCache = new Map();

async function mcpCall(method, params, mcpSessionId) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} });

  const res = await fetch(SANDBOX_MCP_URL, { method: 'POST', headers, body });
  const newSessionId = res.headers.get('mcp-session-id') || mcpSessionId;
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) throw new Error(`sandbox MCP: no data line in response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(dataLine.slice('data: '.length));
  if (parsed.error) throw new Error(`sandbox MCP error: ${JSON.stringify(parsed.error)}`);
  return { result: parsed.result, mcpSessionId: newSessionId };
}

async function sandboxSessionAlive(sessionId) {
  try {
    const init = await mcpCall('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'librechat-sandbox-diversion', version: '1.0' },
    });
    const listRes = await mcpCall('tools/call', { name: 'sandbox_session_list', arguments: {} }, init.mcpSessionId);
    const parsed = JSON.parse(listRes.result.content[0].text);
    return parsed.sessions?.some((s) => s.session_id === sessionId && s.status?.startsWith('Up'));
  } catch (e) {
    logger.error('[sandbox] session liveness check failed', e);
    return false;
  }
}

async function ensureSandboxSession(conversationId) {
  const cached = sessionCache.get(conversationId);
  if (cached && (await sandboxSessionAlive(cached))) {
    return cached;
  }

  const init = await mcpCall('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'librechat-sandbox-diversion', version: '1.0' },
  });
  const startRes = await mcpCall('tools/call', { name: 'sandbox_session_start', arguments: {} }, init.mcpSessionId);
  const parsed = JSON.parse(startRes.result.content[0].text);
  if (!parsed.success) throw new Error(`sandbox_session_start failed: ${startRes.result.content[0].text}`);

  sessionCache.set(conversationId, parsed.session_id);
  logger.info(`[sandbox] created session ${parsed.session_id} for conversation ${conversationId}`);
  return parsed.session_id;
}

async function writeFileToSandbox(sessionId, filename, base64Content) {
  const init = await mcpCall('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'librechat-sandbox-diversion', version: '1.0' },
  });
  const writeRes = await mcpCall(
    'tools/call',
    { name: 'sandbox_write_file', arguments: { session_id: sessionId, filename, content_b64: base64Content } },
    init.mcpSessionId,
  );
  const parsed = JSON.parse(writeRes.result.content[0].text);
  if (!parsed.success) throw new Error(`sandbox_write_file failed: ${writeRes.result.content[0].text}`);
  return parsed;
}

/**
 * Diverts a set of encoded images (from encodeAndFormat's `image_urls` +
 * `files` results) into a sandbox session, returning a text note to append
 * to the outbound message instead of the real image content. Fails open:
 * any error here just skips diversion for that call, so a sandbox hiccup
 * never blocks a chat turn.
 *
 * @param {string} conversationId
 * @param {Array<{image_url: {url: string}}>} imageUrls
 * @param {Array<{filename?: string, file_id?: string}>} files
 * @returns {Promise<string|null>} note text to append to message.text, or null if diversion didn't happen
 */
async function divertImagesToSandbox(conversationId, imageUrls, files) {
  try {
    const sessionId = await ensureSandboxSession(conversationId);
    const notes = [];

    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i]?.image_url?.url;
      if (!url || !url.startsWith('data:')) continue;
      const match = url.match(/^data:([^;]+);base64,(.*)$/s);
      if (!match) continue;
      const [, , base64Data] = match;
      const filename = files[i]?.filename || `image-${i}.bin`;

      const written = await writeFileToSandbox(sessionId, filename, base64Data);
      notes.push(`'${filename}' -> /workspace/${written.path?.split('/').pop() ?? filename}`);
    }

    if (!notes.length) return null;

    return `[${notes.length} image(s) uploaded to sandbox session ${sessionId}: ${notes.join(', ')}. Use the sandbox MCP tools (sandbox_exec, sandbox_read_file) with this session_id to view or process them — the raw image data was not sent to you directly.]`;
  } catch (e) {
    logger.error('[sandbox] image diversion failed, falling back to normal image attachment', e);
    return null;
  }
}

async function streamToBase64(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    stream.on('error', reject);
  });
}

/**
 * Diverts a set of raw attachments (documents/videos/audios — anything with
 * real bytes in storage) into a sandbox session by re-fetching their bytes
 * directly via the storage strategy, rather than parsing a provider-specific
 * encoded content block. Returns a note to append to message.text in place
 * of calling the normal encode/attach path. Fails open.
 *
 * @param {string} conversationId
 * @param {Array<MongoFile>} attachments
 * @param {(source: string) => {getDownloadStream: Function}} getStrategyFunctions
 * @param {ServerRequest} req
 * @param {string} kindLabel - e.g. 'document', 'video', 'audio'
 * @returns {Promise<string|null>}
 */
async function divertAttachmentsToSandbox(conversationId, attachments, getStrategyFunctions, req, kindLabel) {
  try {
    const sessionId = await ensureSandboxSession(conversationId);
    const notes = [];

    for (const file of attachments) {
      const source = file.source ?? 'local';
      const { getDownloadStream } = getStrategyFunctions(source);
      if (!getDownloadStream) continue;
      const stream = await getDownloadStream(req, file.filepath);
      const base64Data = await streamToBase64(stream);
      const filename = file.filename || file.file_id || `${kindLabel}-file`;

      const written = await writeFileToSandbox(sessionId, filename, base64Data);
      notes.push(`'${filename}' -> /workspace/${written.path?.split('/').pop() ?? filename}`);
    }

    if (!notes.length) return null;

    return `[${notes.length} ${kindLabel}(s) uploaded to sandbox session ${sessionId}: ${notes.join(', ')}. Use the sandbox MCP tools (sandbox_exec, sandbox_read_file) with this session_id to view or process them — the raw file content was not sent to you directly.]`;
  } catch (e) {
    logger.error(`[sandbox] ${kindLabel} diversion failed, falling back to normal attachment`, e);
    return null;
  }
}

/**
 * Diverts pre-extracted document text (RAG/OCR output, from
 * extractFileContext's `file.text`) into the sandbox as a .txt file, in
 * place of inlining the full extracted text into the prompt. Fails open.
 *
 * @param {string} conversationId
 * @param {string} filename
 * @param {string} text
 * @returns {Promise<string|null>}
 */
async function divertTextToSandbox(conversationId, filename, text) {
  try {
    const sessionId = await ensureSandboxSession(conversationId);
    const base64Data = Buffer.from(text, 'utf-8').toString('base64');
    const safeName = (filename || 'document').replace(/\.[^.]+$/, '') + '.txt';
    const written = await writeFileToSandbox(sessionId, safeName, base64Data);
    return `[Extracted text for '${filename}' (${text.length} chars) saved to sandbox session ${sessionId} at /workspace/${written.path?.split('/').pop() ?? safeName}. Use sandbox_read_file with this session_id to read it — the extracted text was not inlined into this prompt.]`;
  } catch (e) {
    logger.error('[sandbox] text diversion failed, falling back to inlining extracted text', e);
    return null;
  }
}

module.exports = { divertImagesToSandbox, divertAttachmentsToSandbox, divertTextToSandbox };
