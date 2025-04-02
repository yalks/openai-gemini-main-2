import { Buffer } from "node:buffer";
import keyManager from './keyManager.mjs'; // 导入密钥管理器

// 初始化密钥管理器
let keysLoaded = false;
async function ensureKeysLoaded() {
  if (!keysLoaded) {
    const success = await keyManager.loadKeys();
    if (success) {
      keysLoaded = true;
    } else {
      // 如果密钥加载失败，可能需要抛出错误或采取其他措施
      console.error("FATAL: Failed to load API keys. Key Manager will not function.");
      // 在这种情况下，服务可能无法正常处理请求
    }
  }
}

// 自定义HttpError类
class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

// CORS处理函数
const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "*",); // 允许所有方法
  headers.set("Access-Control-Allow-Headers", "*",); // 允许所有头部
  return { headers, status, statusText };
};

// OPTIONS请求处理
const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
};

// Gemini API基础URL和版本
const BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";

// API客户端标识
const API_CLIENT = "genai-js/0.21.0"; // npm view @google/generative-ai version

// 创建请求头
const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }), // 确保apiKey存在时才添加
  ...more
});

// 错误处理函数
const errHandler = (err) => {
  console.error(err);
  // 尝试从自定义错误中获取状态码，否则默认为500
  const status = err instanceof HttpError ? err.status : 500;
  return new Response(err.message || 'Internal Server Error', fixCors({ status }));
};

// 主fetch处理函数
export default {
  async fetch (request) {
    // 确保密钥已加载
    await ensureKeysLoaded();

    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }

    try {
      // 移除从请求中获取API密钥的代码
      // const auth = request.headers.get("Authorization");
      // const apiKey = auth?.split(" ")[1];

      const assert = (success, message = "Method Not Allowed", status = 405) => {
        if (!success) {
          throw new HttpError(message, status);
        }
      };

      const { pathname } = new URL(request.url);

      switch (true) {
        case pathname.endsWith("/chat/completions"):
          assert(request.method === "POST");
          // 修改调用，不传递apiKey参数
          return handleCompletions(await request.json())
            .catch(errHandler);
        case pathname.endsWith("/embeddings"):
          assert(request.method === "POST");
          // 同样修改其他处理函数调用 (假设它们也需要修改)
          return handleEmbeddings(await request.json())
            .catch(errHandler);
        case pathname.endsWith("/models"):
          assert(request.method === "GET");
          // 同样修改其他处理函数调用 (假设它们也需要修改)
          return handleModels()
            .catch(errHandler);

        // 添加新的管理API端点
        case pathname.endsWith("/admin/keys/stats"):
          assert(request.method === "GET", "Method Not Allowed", 405);
          return handleKeyStats()
            .catch(errHandler);

        case pathname.match(/\/admin\/keys\/reset\/key-\d+$/): // 匹配 /admin/keys/reset/key-数字
          assert(request.method === "POST", "Method Not Allowed", 405);
          const keyId = pathname.split('/').pop();
          return handleKeyReset(keyId)
            .catch(errHandler);

        case pathname.endsWith("/admin/keys/config"):
          if (request.method === "GET") {
            return handleGetConfig()
              .catch(errHandler);
          } else if (request.method === "POST") {
            return handleUpdateConfig(await request.json())
              .catch(errHandler);
          }
          throw new HttpError("Method Not Allowed", 405);

        default:
          throw new HttpError("Not Found", 404);
      }
    } catch (err) {
      return errHandler(err);
    }
  }
};


// --- 处理函数 ---

// 处理 /models 请求 (需要修改以使用keyManager)
async function handleModels() {
  let response;
  let usedKey;
  let attempts = 0;
  const maxRetries = keyManager.getConfig().maxRetries;

  while (attempts <= maxRetries) {
    try {
      usedKey = keyManager.getAvailableKey();
      const requestStartTime = Date.now();
      response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
        headers: makeHeaders(usedKey.key),
      });
      const responseTime = Date.now() - requestStartTime;

      if (!response.ok) {
        keyManager.markKeyCooling(usedKey);
        attempts++;
        if (attempts > maxRetries) throw new HttpError(`API请求失败 (${response.status})`, response.status);
        keyManager.metrics.recordRetry();
        continue;
      }
      keyManager.markKeyUsed(usedKey, responseTime);
      break;
    } catch (error) {
      if (usedKey) keyManager.markKeyCooling(usedKey);
      attempts++;
      if (attempts > maxRetries) throw new HttpError(`处理请求出错: ${error.message}`, error.status || 500);
      keyManager.metrics.recordRetry();
    }
  }

  let { body } = response;
  if (response.ok) {
    const { models } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: models.map(({ name }) => ({
        id: name.replace("models/", ""),
        object: "model",
        created: 0,
        owned_by: "",
      })),
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

// 处理 /embeddings 请求 (需要修改以使用keyManager)
const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-004";
async function handleEmbeddings(req) {
  if (typeof req.model !== "string") {
    throw new HttpError("model is not specified", 400);
  }
  if (!Array.isArray(req.input)) {
    req.input = [ req.input ];
  }
  let model;
  if (req.model.startsWith("models/")) {
    model = req.model;
  } else {
    req.model = DEFAULT_EMBEDDINGS_MODEL;
    model = "models/" + req.model;
  }

  let response;
  let usedKey;
  let attempts = 0;
  const maxRetries = keyManager.getConfig().maxRetries;

  while (attempts <= maxRetries) {
    try {
      usedKey = keyManager.getAvailableKey();
      const requestStartTime = Date.now();
      response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
        method: "POST",
        headers: makeHeaders(usedKey.key, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          "requests": req.input.map(text => ({
            model,
            content: { parts: { text } },
            outputDimensionality: req.dimensions,
          }))
        })
      });
      const responseTime = Date.now() - requestStartTime;

      if (!response.ok) {
        keyManager.markKeyCooling(usedKey);
        attempts++;
        if (attempts > maxRetries) throw new HttpError(`API请求失败 (${response.status})`, response.status);
        keyManager.metrics.recordRetry();
        continue;
      }
      keyManager.markKeyUsed(usedKey, responseTime);
      break;
    } catch (error) {
      if (usedKey) keyManager.markKeyCooling(usedKey);
      attempts++;
      if (attempts > maxRetries) throw new HttpError(`处理请求出错: ${error.message}`, error.status || 500);
      keyManager.metrics.recordRetry();
    }
  }

  let { body } = response;
  if (response.ok) {
    const { embeddings } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }, index) => ({
        object: "embedding",
        index,
        embedding: values,
      })),
      model: req.model,
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

// 处理 /chat/completions 请求 (使用keyManager)
const DEFAULT_MODEL = "gemini-1.5-pro-latest";
async function handleCompletions(req) {
  let model = DEFAULT_MODEL;
  switch(true) {
    case typeof req.model !== "string":
      break;
    case req.model.startsWith("models/"):
      model = req.model.substring(7);
      break;
    case req.model.startsWith("gemini-"):
    case req.model.startsWith("learnlm-"):
      model = req.model;
  }

  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }

  let response;
  let usedKey;
  let attempts = 0;
  const maxRetries = keyManager.getConfig().maxRetries;
  const startTime = Date.now();

  while (attempts <= maxRetries) { // <= 因为第一次不算重试
    try {
      // 获取可用密钥
      usedKey = keyManager.getAvailableKey();

      const requestStartTime = Date.now();

      // 发起请求
      response = await fetch(url, {
        method: "POST",
        headers: makeHeaders(usedKey.key, { "Content-Type": "application/json" }),
        body: JSON.stringify(await transformRequest(req)),
      });

      const responseTime = Date.now() - requestStartTime;

      // 如果响应不成功，标记密钥冷却并重试
      if (!response.ok) {
        keyManager.markKeyCooling(usedKey);
        attempts++;

        if (attempts > maxRetries) {
          // 尝试读取错误信息
          let errorBody = 'Unknown API Error';
          try {
            errorBody = await response.text();
          } catch (e) { /* ignore read error */ }
          throw new HttpError(`API请求失败 (${response.status}): ${errorBody}`, response.status);
        }

        keyManager.metrics.recordRetry();
        continue;
      }

      // 记录成功使用
      keyManager.markKeyUsed(usedKey, responseTime);

      // 处理成功，退出循环
      break;
    } catch (error) {
      // 请求异常，标记密钥冷却
      if (usedKey) {
        keyManager.markKeyCooling(usedKey);
      }
      attempts++;

      // 如果达到最大重试次数，抛出异常
      if (attempts > maxRetries) {
        throw new HttpError(`处理请求出错: ${error.message}`, error.status || 500);
      }

      keyManager.metrics.recordRetry();
    }
  }

  const totalTime = Date.now() - startTime;
  keyManager.logger.info(`Completed request in ${totalTime}ms with ${attempts -1} retries`); // attempts-1 是实际重试次数

  // 处理响应体
  let body = response.body;
  if (response.ok) {
    let id = generateChatcmplId();
    if (req.stream) {
      body = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
        }))
        .pipeThrough(new TransformStream({
          transform: toOpenAiStream,
          flush: toOpenAiStreamFlush,
          streamIncludeUsage: req.stream_options?.include_usage,
          model, id, last: [],
        }))
        .pipeThrough(new TextEncoderStream());
    } else {
      body = await response.text();
      body = processCompletionsResponse(JSON.parse(body), model, id);
    }
  }

  return new Response(body, fixCors(response));
}

// --- 辅助函数 ---

// 转换请求格式
const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];
const safetySettings = harmCategory.map(category => ({
  category,
  threshold: "BLOCK_NONE",
}));
const fieldsMap = {
  stop: "stopSequences",
  n: "candidateCount", // not for streaming
  max_tokens: "maxOutputTokens",
  max_completion_tokens: "maxOutputTokens",
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK", // non-standard
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
};
const transformConfig = (req) => {
  let cfg = {};
  for (let key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = req[key];
    }
  }
  if (req.response_format) {
    switch(req.response_format.type) {
      case "json_schema":
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }
  return cfg;
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} (${url})`);
      }
      mimeType = response.headers.get("content-type");
      data = Buffer.from(await response.arrayBuffer()).toString("base64");
    } catch (err) {
      throw new Error("Error fetching image: " + err.toString());
    }
  } else {
    const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
    if (!match) {
      throw new Error("Invalid image data: " + url);
    }
    ({ mimeType, data } = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformMsg = async ({ role, content }) => {
  const parts = [];
  if (!Array.isArray(content)) {
    parts.push({ text: content || " " }); // Ensure text is not null or empty for model role
    return { role, parts };
  }
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push({ text: item.text });
        break;
      case "image_url":
        parts.push(await parseImg(item.image_url.url));
        break;
      case "input_audio":
        parts.push({
          inlineData: {
            mimeType: "audio/" + item.input_audio.format,
            data: item.input_audio.data,
          }
        });
        break;
      default:
        throw new TypeError(`Unknown "content" item type: "${item.type}"`);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({ text: "" });
  }
  return { role, parts };
};

const transformMessages = async (messages) => {
  if (!messages) { return {}; }
  const contents = [];
  let system_instruction;
  for (const item of messages) {
    if (item.role === "system") {
      delete item.role;
      system_instruction = await transformMsg(item);
    } else {
      item.role = item.role === "assistant" ? "model" : "user";
      contents.push(await transformMsg(item));
    }
  }
  if (system_instruction && contents.length === 0) {
    // Gemini requires at least one non-system message if system instruction is present
    contents.push({ role: "user", parts: [{ text: " " }] }); // Add a dummy user message
  }
  return { system_instruction, contents };
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
});

// 生成唯一ID
const generateChatcmplId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return "chatcmpl-" + Array.from({ length: 29 }, randomChar).join("");
};

// 转换响应格式
const reasonsMap = {
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
};
const SEP = ""; // OpenAI usually doesn't join parts with separators
const transformCandidates = (key, cand) => ({
  index: cand.index || 0,
  [key]: {
    role: "assistant",
    // Ensure content is a string, handle potential missing parts or text
    content: cand.content?.parts?.map(p => p.text || "").join(SEP) || null,
  },
  logprobs: null,
  finish_reason: reasonsMap[cand.finishReason] || cand.finishReason || null, // Ensure null if undefined
});
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

const transformUsage = (data) => ({
  completion_tokens: data?.candidatesTokenCount || 0,
  prompt_tokens: data?.promptTokenCount || 0,
  total_tokens: data?.totalTokenCount || 0
});

const processCompletionsResponse = (data, model, id) => {
  // Handle cases where candidates might be missing
  const choices = data.candidates ? data.candidates.map(transformCandidatesMessage) : [];
  return JSON.stringify({
    id,
    choices,
    created: Math.floor(Date.now()/1000),
    model,
    object: "chat.completion",
    usage: transformUsage(data.usageMetadata),
  });
};

// 处理流式响应
const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
async function parseStream (chunk, controller) {
  chunk = await chunk;
  if (!chunk) { return; }
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true);
}
async function parseStreamFlush (controller) {
  if (this.buffer) {
    // Try to parse the remaining buffer as JSON, might be an error object
    try {
      const jsonData = JSON.parse(this.buffer);
      if (jsonData.error) {
        console.error("Stream ended with error:", jsonData.error);
        // You might want to enqueue a specific error message here
        controller.enqueue(JSON.stringify({
          id: this.id || generateChatcmplId(),
          choices: [{ index: 0, delta: {}, finish_reason: "error", error: jsonData.error }],
          created: Math.floor(Date.now()/1000),
          model: this.model || 'unknown',
          object: "chat.completion.chunk",
        }));
      } else {
         controller.enqueue(this.buffer); // Enqueue remaining valid data if any
      }
    } catch (e) {
       console.error("Invalid data at end of stream:", this.buffer);
       // Enqueue a generic error chunk
       controller.enqueue(JSON.stringify({
         id: this.id || generateChatcmplId(),
         choices: [{ index: 0, delta: {}, finish_reason: "error", error: { message: "Invalid stream data" } }],
         created: Math.floor(Date.now()/1000),
         model: this.model || 'unknown',
         object: "chat.completion.chunk",
       }));
    }
  }
}

const delimiter = "\n\n";
function transformResponseStream (data, stop, first) {
  // Ensure candidates exist and have at least one element
  if (!data.candidates || data.candidates.length === 0) {
    // Handle cases like safety blocks which might not have candidates
    // Or just return an empty chunk? Let's create a minimal chunk.
    return "data: " + JSON.stringify({
      id: this.id,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: data.promptFeedback?.blockReason || (stop ? "stop" : null) || null
      }],
      created: Math.floor(Date.now()/1000),
      model: this.model,
      object: "chat.completion.chunk",
      usage: (data.usageMetadata && this.streamIncludeUsage && stop) ? transformUsage(data.usageMetadata) : null,
    }) + delimiter;
  }

  const item = transformCandidatesDelta(data.candidates[0]);
  if (stop) {
    item.delta = {}; // Stop signal has empty delta
  } else {
    item.finish_reason = null; // Intermediate chunks don't have finish_reason
  }
  // Ensure delta exists even if content is null
  item.delta = item.delta || {};
  if (first) {
    // First chunk might not have content, but should have role
    item.delta.role = "assistant";
    if (!item.delta.content) item.delta.content = ""; // Ensure content field exists
  } else {
    delete item.delta.role; // Subsequent chunks don't repeat role
  }

  const output = {
    id: this.id,
    choices: [item],
    created: Math.floor(Date.now()/1000),
    model: this.model,
    object: "chat.completion.chunk",
  };
  if (data.usageMetadata && this.streamIncludeUsage && stop) {
    output.usage = transformUsage(data.usageMetadata);
  }
  return "data: " + JSON.stringify(output) + delimiter;
}

async function toOpenAiStream (chunk, controller) {
  const transform = transformResponseStream.bind(this);
  const line = await chunk;
  if (!line) { return; }
  let data;
  try {
    data = JSON.parse(line);
  } catch (err) {
    console.error("Error parsing stream line:", line);
    console.error(err);
    // Create an error chunk to send to the client
    const errorData = {
      candidates: [{
        index: 0,
        finishReason: "error",
        content: { parts: [{ text: `Stream parsing error: ${err.message}` }] }
      }]
    };
    controller.enqueue(transform(errorData, true)); // Send as a final chunk with error
    return;
  }

  // Handle potential prompt feedback (e.g., safety blocks)
  if (data.promptFeedback && data.promptFeedback.blockReason) {
      console.warn(`Stream blocked due to: ${data.promptFeedback.blockReason}`);
      // Send a chunk indicating content filter finish reason
      const blockData = {
          candidates: [{
              index: 0,
              finishReason: "SAFETY", // Map to OpenAI's content_filter
              content: null // No content when blocked
          }],
          usageMetadata: data.usageMetadata // Include usage if available
      };
      controller.enqueue(transform(blockData, true)); // Send as final chunk
      return;
  }


  // Ensure candidates exist before proceeding
  if (!data.candidates || data.candidates.length === 0) {
      // If no candidates and no block reason, it might be an empty final chunk or unexpected data
      console.warn("Received stream chunk with no candidates and no block reason:", data);
       // Send usage data if available and it's the final chunk
      if (data.usageMetadata && this.streamIncludeUsage) {
          const usageData = {
              candidates: [{ index: 0, finishReason: "stop", content: null }], // Assume stop if no other reason
              usageMetadata: data.usageMetadata
          };
          controller.enqueue(transform(usageData, true));
      }
      return; // Don't process further if no candidates
  }


  const cand = data.candidates[0];
  cand.index = cand.index || 0;

  // Initialize last array if needed
  if (!this.last) this.last = [];

  if (!this.last[cand.index]) {
    // First chunk for this candidate index
    controller.enqueue(transform(data, false, true)); // Pass 'first' flag
  }
  this.last[cand.index] = data; // Store the last received data for this index

  // Send intermediate content chunk if content exists
  if (cand.content && cand.content.parts && cand.content.parts.some(p => p.text)) {
    controller.enqueue(transform(data, false, false)); // Not first, not stop
  }

  // If this chunk indicates a finish reason, send the final chunk with usage
  if (cand.finishReason) {
      controller.enqueue(transform(data, true, false)); // Send final chunk (stop=true)
  }
}
async function toOpenAiStreamFlush (controller) {
  // This flush might not be strictly necessary if the stream always ends with a finishReason chunk
  // However, it can handle cases where the stream terminates unexpectedly.
  const transform = transformResponseStream.bind(this);
  if (this.last && this.last.length > 0) {
    // Check if the last received chunk already had a finish reason
    const lastData = this.last[this.last.length - 1]; // Assuming single candidate stream for simplicity
    if (!lastData?.candidates?.[0]?.finishReason) {
      // If the stream ended without a proper finish signal, send a final [DONE] chunk
      // We might not have usage data here.
       console.warn("Stream flushing without a final finishReason chunk.");
       // Send a minimal stop chunk if needed, or just the DONE signal
       // controller.enqueue(transform({ candidates: [{ index: 0, finishReason: "stop" }] }, true));
    }
  }
  controller.enqueue("data: [DONE]" + delimiter);
}


// --- 管理API处理函数 ---
async function handleKeyStats() {
  await ensureKeysLoaded(); // Ensure keys are loaded before accessing stats
  const stats = {
    keys: keyManager.getKeyStats(),
    global: keyManager.getGlobalStats()
  };
  return new Response(JSON.stringify(stats, null, 2), fixCors({
    status: 200,
    headers: { "Content-Type": "application/json" }
  }));
}

async function handleKeyReset(keyId) {
  await ensureKeysLoaded();
  const success = keyManager.resetKey(keyId);
  return new Response(JSON.stringify({ success }), fixCors({
    status: success ? 200 : 404,
    headers: { "Content-Type": "application/json" }
  }));
}

async function handleGetConfig() {
  await ensureKeysLoaded();
  const config = keyManager.getConfig();
  return new Response(JSON.stringify(config, null, 2), fixCors({
    status: 200,
    headers: { "Content-Type": "application/json" }
  }));
}

async function handleUpdateConfig(newConfig) {
  await ensureKeysLoaded();
  const config = keyManager.updateConfig(newConfig);
  return new Response(JSON.stringify(config, null, 2), fixCors({
    status: 200,
    headers: { "Content-Type": "application/json" }
  }));
}
