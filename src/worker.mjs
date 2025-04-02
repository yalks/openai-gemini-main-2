import { Buffer } from "node:buffer";
import keyManager from './keyManager.mjs'; // 导入密钥管理器
import { logToFile, formatLog, logKeyStatus } from './logger.mjs'; // 导入日志模块和新函数

// 初始化密钥管理器
let keysLoaded = false;
async function ensureKeysLoaded() {
  if (!keysLoaded) {
    const success = await keyManager.loadKeys();
    if (success) {
      keysLoaded = true;
    } else {
      console.error("FATAL: Failed to load API keys. Key Manager will not function.");
      await logToFile(formatLog('ERROR', { message: "FATAL: Failed to load API keys." }));
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
const handleOPTIONS = async (request) => {
  const requestUrl = request.url;
  // Log OPTIONS request info
  await logToFile(formatLog('REQUEST', {
    method: request.method,
    url: requestUrl,
    headers: Object.fromEntries(request.headers.entries())
  }));
  const response = new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
  // Log OPTIONS response info
  await logToFile(formatLog('RESPONSE', {
    requestUrl: requestUrl,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries())
  }));
  // Log key status after handling OPTIONS (though no key is used)
  if (keysLoaded) {
      await logKeyStatus(keyManager.getKeyStats());
  }
  return response;
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
const errHandler = async (err, requestUrl = 'N/A') => { // 添加 requestUrl 参数
  console.error(`Error handling request for ${requestUrl}:`, err);
  const status = err instanceof HttpError ? err.status : 500;
  const message = err.message || 'Internal Server Error';

  // Log error details
  await logToFile(formatLog('ERROR', {
    requestUrl: requestUrl,
    status: status,
    message: message,
    stack: err.stack // Include stack trace if available
  }));

  const response = new Response(message, fixCors({ status }));

  // Log error response details
  await logToFile(formatLog('RESPONSE', {
    requestUrl: requestUrl, // Log which request resulted in this error response
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: message // Log the error message sent to client
  }));

  // Log key status even after error
  if (keysLoaded) {
      await logKeyStatus(keyManager.getKeyStats());
  }

  return response;
};

// Helper to safely get request body for logging
async function getRequestBodyForLog(request) {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
        return null; // No body or not relevant
    }
    try {
        const clonedRequest = request.clone();
        const contentType = clonedRequest.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            // Limit size of logged JSON body
            const jsonBody = await clonedRequest.json();
            const strBody = JSON.stringify(jsonBody);
            return strBody.length > 2000 ? strBody.substring(0, 2000) + '...[truncated]' : jsonBody;
        } else {
            const text = await clonedRequest.text();
             return text.length > 1000 ? text.substring(0, 1000) + '...[truncated]' : text; // Limit size
        }
    } catch (e) {
        return `[Error reading body: ${e.message}]`;
    }
}

// Helper to safely get response body for logging
async function getResponseBodyForLog(response) {
    try {
        const clonedResponse = response.clone();
        const contentType = clonedResponse.headers.get('content-type');

        if (clonedResponse.body instanceof ReadableStream) {
             return '[Stream Body]';
        }
         if (contentType && (contentType.includes('image/') || contentType.includes('audio/') || contentType.includes('video/'))) {
             return `[Binary Body: ${contentType}]`;
         }

        if (contentType && contentType.includes('application/json')) {
             // Limit size of logged JSON body
            const jsonBody = await clonedResponse.json();
            const strBody = JSON.stringify(jsonBody);
            return strBody.length > 2000 ? strBody.substring(0, 2000) + '...[truncated]' : jsonBody;
        } else {
            const text = await clonedResponse.text();
            return text.length > 1000 ? text.substring(0, 1000) + '...[truncated]' : text; // Limit size
        }
    } catch (e) {
        // Handle cases where body might have already been read (e.g., in handler)
        if (e.message.includes("already been read")) {
            return "[Body Already Read]";
        }
        return `[Error reading body: ${e.message}]`;
    }
}


// 主fetch处理函数
export default {
  async fetch (request) {
    const requestUrl = request.url; // Store URL for logging, especially in error cases
    let response;
    let requestBodyForLog = null; // Initialize
    const requestId = generateChatcmplId().substring(9); // Generate a short unique ID for this request

    try {
      await ensureKeysLoaded();

      requestBodyForLog = await getRequestBodyForLog(request);
      await logToFile(formatLog('REQUEST', {
        requestId: requestId, // Log request ID
        method: request.method,
        url: requestUrl,
        headers: Object.fromEntries(request.headers.entries()),
        body: requestBodyForLog
      }));


      if (request.method === "OPTIONS") {
        // handleOPTIONS now logs and writes key status itself
        return await handleOPTIONS(request);
      }


      const assert = (success, message = "Method Not Allowed", status = 405) => {
        if (!success) {
          throw new HttpError(message, status);
        }
      };

      const { pathname } = new URL(requestUrl);

      // --- Routing ---
      switch (true) {
        case pathname.endsWith("/chat/completions"):
          assert(request.method === "POST");
          // 记录完整的请求路径
          await logToFile(`[DEBUG][ReqID: ${requestId}] 完整请求路径: ${pathname}`);
          
          // 特别处理不同的URL路径
          let chatReqBody;
          if (pathname === "/v1/chat/completions") {
            // 对于单v1路径，我们需要进行特殊处理
            try {
              // 尝试读取原始请求而不是可能被截断的日志版本
              const clonedRequest = request.clone();
              chatReqBody = await clonedRequest.json();
              await logToFile(`[DEBUG][ReqID: ${requestId}] 使用原始请求体解析成功`);
            } catch (error) {
              // 如果无法解析JSON，使用字符串安全方式获取请求体
              const rawText = await request.text();
              await logToFile(`[ERROR][ReqID: ${requestId}] JSON解析失败，尝试直接转发原始文本: ${error.message}`);
              // 直接使用请求文本作为请求体，handleCompletions函数会进行对象检查和转换
              chatReqBody = { messages: [{role: "user", content: "处理错误，请重试"}], model: "gemini-1.5-pro-latest" };
            }
          } else {
            // 对于其他路径（包括/v1/v1/chat/completions），使用原来的处理方式
            chatReqBody = requestBodyForLog || await request.json(); // Use already read body if available
          }
          response = await handleCompletions(chatReqBody, requestId); // Pass requestId
          break;
        case pathname.endsWith("/embeddings"):
          assert(request.method === "POST");
          const embedReqBody = requestBodyForLog || await request.json();
          response = await handleEmbeddings(embedReqBody, requestId); // Pass requestId
          break;
        case pathname.endsWith("/models"):
          assert(request.method === "GET");
          response = await handleModels(requestId); // Pass requestId
          break;
        // --- Admin Routes ---
        case pathname.endsWith("/admin/keys/stats"):
          assert(request.method === "GET", "Method Not Allowed", 405);
          response = await handleKeyStats(requestId); // Pass requestId
          break;
        case pathname.match(/\/admin\/keys\/reset\/key-\d+$/):
          assert(request.method === "POST", "Method Not Allowed", 405);
          const keyId = pathname.split('/').pop();
          response = await handleKeyReset(keyId, requestId); // Pass requestId
          break;
        case pathname.endsWith("/admin/keys/config"):
          if (request.method === "GET") {
            response = await handleGetConfig(requestId); // Pass requestId
          } else if (request.method === "POST") {
             const configReqBody = requestBodyForLog || await request.json();
            response = await handleUpdateConfig(configReqBody, requestId); // Pass requestId
          } else {
             throw new HttpError("Method Not Allowed", 405);
          }
          break;
        default:
          throw new HttpError("Not Found", 404);
      }

      // Log successful response
      const responseBodyForLog = await getResponseBodyForLog(response);
      await logToFile(formatLog('RESPONSE', {
        requestId: requestId, // Log request ID
        requestUrl: requestUrl,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBodyForLog
      }));

      return response;

    } catch (err) {
      // Use the specific errHandler, passing the request URL and ID
      return await errHandler(err, requestUrl); // errHandler now logs key status
    } finally {
        // Log key status after every request (success or handled error)
        // Avoid logging if keys failed to load initially
        if (keysLoaded) {
            await logKeyStatus(keyManager.getKeyStats());
        }
    }
  }
};


// --- 处理函数 ---

// 处理 /models 请求 (使用keyManager)
async function handleModels(requestId) { // Accept requestId
  let response;
  let usedKey = null; // Initialize to null
  let attempts = 0;
  const maxRetries = keyManager.getConfig().maxRetries;

  while (attempts <= maxRetries) {
    try {
      usedKey = keyManager.getAvailableKey(); // Might throw if no keys available
      await logToFile(`[ReqID: ${requestId}] Attempt ${attempts + 1}/${maxRetries + 1} using Key ID: ${usedKey.id} for /models`); // Log key usage attempt

      const requestStartTime = Date.now();
      response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
        headers: makeHeaders(usedKey.key),
      });
      const responseTime = Date.now() - requestStartTime;

      if (!response.ok) {
        await logToFile(`[ReqID: ${requestId}] Key ${usedKey.id} failed for /models with status ${response.status}`);
        keyManager.markKeyCooling(usedKey);
        usedKey = null; // Reset usedKey as it's now cooling
        attempts++;
        if (attempts > maxRetries) throw new HttpError(`API请求失败 (${response.status})`, response.status);
        keyManager.metrics.recordRetry();
        continue;
      }
      keyManager.markKeyUsed(usedKey, responseTime);
      await logToFile(`[ReqID: ${requestId}] Key ${usedKey.id} succeeded for /models`);
      break; // Success
    } catch (error) {
      await logToFile(`[ReqID: ${requestId}] Error during attempt ${attempts + 1} for /models (Key: ${usedKey?.id || 'N/A'}): ${error.message}`);
      if (usedKey) keyManager.markKeyCooling(usedKey); // Mark cooling if a key was obtained before error
      usedKey = null;
      attempts++;
      if (attempts > maxRetries) throw new HttpError(`处理/models请求出错: ${error.message}`, error.status || 500);
      keyManager.metrics.recordRetry();
    }
  }

  let body;
  const responseToLog = response.clone(); // Clone before reading body

  if (response.ok) {
    const text = await response.text();
    const { models } = JSON.parse(text);
    body = JSON.stringify({
      object: "list",
      data: models.map(({ name }) => ({
        id: name.replace("models/", ""),
        object: "model",
        created: 0,
        owned_by: "",
      })),
    }, null, "  ");
     return new Response(body, fixCors(responseToLog));
  } else {
      const errorText = await response.text();
      return new Response(errorText, fixCors(responseToLog));
  }
}

// 处理 /embeddings 请求 (使用keyManager)
const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-004";
async function handleEmbeddings(req, requestId) { // Accept requestId
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
  let usedKey = null;
  let attempts = 0;
  const maxRetries = keyManager.getConfig().maxRetries;

  while (attempts <= maxRetries) {
    try {
      usedKey = keyManager.getAvailableKey();
      await logToFile(`[ReqID: ${requestId}] Attempt ${attempts + 1}/${maxRetries + 1} using Key ID: ${usedKey.id} for /embeddings`);

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
         await logToFile(`[ReqID: ${requestId}] Key ${usedKey.id} failed for /embeddings with status ${response.status}`);
        keyManager.markKeyCooling(usedKey);
        usedKey = null;
        attempts++;
        if (attempts > maxRetries) throw new HttpError(`API请求失败 (${response.status})`, response.status);
        keyManager.metrics.recordRetry();
        continue;
      }
      keyManager.markKeyUsed(usedKey, responseTime);
       await logToFile(`[ReqID: ${requestId}] Key ${usedKey.id} succeeded for /embeddings`);
      break; // Success
    } catch (error) {
       await logToFile(`[ReqID: ${requestId}] Error during attempt ${attempts + 1} for /embeddings (Key: ${usedKey?.id || 'N/A'}): ${error.message}`);
      if (usedKey) keyManager.markKeyCooling(usedKey);
      usedKey = null;
      attempts++;
      if (attempts > maxRetries) throw new HttpError(`处理/embeddings请求出错: ${error.message}`, error.status || 500);
      keyManager.metrics.recordRetry();
    }
  }

  let body;
  const responseToLog = response.clone();

  if (response.ok) {
     const text = await response.text();
    const { embeddings } = JSON.parse(text);
    body = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }, index) => ({
        object: "embedding",
        index,
        embedding: values,
      })),
      model: req.model,
    }, null, "  ");
     return new Response(body, fixCors(responseToLog));
  } else {
      const errorText = await response.text();
      return new Response(errorText, fixCors(responseToLog));
  }
}

// 处理 /chat/completions 请求 (使用keyManager)
const DEFAULT_MODEL = "gemini-1.5-pro-latest";
async function handleCompletions(req, requestId) { // Accept requestId
  // 检查req是否为字符串，如果是则解析为JSON对象
  if (typeof req === 'string') {
    try {
      await logToFile(`[DEBUG][ReqID: ${requestId}] 请求体是字符串，尝试解析为JSON对象`);
      req = JSON.parse(req);
      await logToFile(`[DEBUG][ReqID: ${requestId}] 解析成功，请求体结构: ${JSON.stringify(Object.keys(req))}`);
    } catch (error) {
      await logToFile(`[ERROR][ReqID: ${requestId}] 解析请求体失败: ${error.message}`);
      throw new HttpError(`解析请求体失败: ${error.message}`, 400);
    }
  }
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
  let usedKey = null;
  let attempts = 0;
  const maxRetries = keyManager.getConfig().maxRetries;
  const startTime = Date.now();

  while (attempts <= maxRetries) {
    try {
      usedKey = keyManager.getAvailableKey();
      await logToFile(`[ReqID: ${requestId}] Attempt ${attempts + 1}/${maxRetries + 1} using Key ID: ${usedKey.id} for /chat/completions`);

      const requestStartTime = Date.now();
      // 将requestId添加到req对象中，以便在转换过程中使用
      req.requestId = requestId;
      response = await fetch(url, {
        method: "POST",
        headers: makeHeaders(usedKey.key, { "Content-Type": "application/json" }),
        body: JSON.stringify(await transformRequest(req)), // Transform needs original req
      });
      const responseTime = Date.now() - requestStartTime;

      if (!response.ok) {
        let errorBody = `Status ${response.status}`;
        try { errorBody = await response.text(); } catch(e){}
        await logToFile(`[ReqID: ${requestId}] Key ${usedKey.id} failed for /chat/completions with status ${response.status}: ${errorBody.substring(0,100)}`);
        keyManager.markKeyCooling(usedKey);
        usedKey = null;
        attempts++;
        if (attempts > maxRetries) {
          throw new HttpError(`API请求失败 (${response.status}): ${errorBody}`, response.status);
        }
        keyManager.metrics.recordRetry();
        continue;
      }
      keyManager.markKeyUsed(usedKey, responseTime);
      await logToFile(`[ReqID: ${requestId}] Key ${usedKey.id} succeeded for /chat/completions`);
      break; // Success
    } catch (error) {
      await logToFile(`[ReqID: ${requestId}] Error during attempt ${attempts + 1} for /chat/completions (Key: ${usedKey?.id || 'N/A'}): ${error.message}`);
      if (usedKey) keyManager.markKeyCooling(usedKey);
      usedKey = null;
      attempts++;
      if (attempts > maxRetries) {
        throw new HttpError(`处理/chat/completions请求出错: ${error.message}`, error.status || 500);
      }
      keyManager.metrics.recordRetry();
    }
  }

  const totalTime = Date.now() - startTime;
  keyManager.logger.info(`[ReqID: ${requestId}] Completed request in ${totalTime}ms with ${attempts -1} retries`);

  // --- Response Processing ---
  if (response.ok) {
    if (req.stream) {
      const transformedStream = response.body
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
          model, id: generateChatcmplId(), last: [],
        }))
        .pipeThrough(new TextEncoderStream());
      return new Response(transformedStream, fixCors(response));
    } else {
      const responseBody = await response.text();
      const processedBody = processCompletionsResponse(JSON.parse(responseBody), model, generateChatcmplId());
      const newResponse = new Response(processedBody, fixCors(response));
      newResponse.headers.set('Content-Type', 'application/json');
      return newResponse;
    }
  } else {
      // Return original error response (will be logged by main handler)
      return response;
  }
}

// --- 辅助函数 ---
// (Keep transformRequest and stream processing functions as before)
// ... (HarmCategory, safetySettings, fieldsMap, transformConfig, parseImg, transformMsg, transformMessages, transformRequest) ...
// ... (generateChatcmplId) ...
// ... (reasonsMap, SEP, transformCandidates, transformCandidatesMessage, transformCandidatesDelta, transformUsage, processCompletionsResponse) ...
// ... (responseLineRE, parseStream, parseStreamFlush, delimiter, transformResponseStream, toOpenAiStream, toOpenAiStreamFlush) ...
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
    contents.push({ role: "user", parts: [{ text: " " }] });
  }
  return { system_instruction, contents };
};

const transformRequest = async (req) => {
  // 记录请求ID，如果存在的话
  const reqId = req.requestId || 'unknown';

  // 记录请求结构
  await logToFile(`[DEBUG][ReqID: ${reqId}] 请求体结构: ${JSON.stringify(Object.keys(req || {}))}`); 
  
  // 记录messages字段的结构和存在性
  if (req.messages) {
    await logToFile(`[DEBUG][ReqID: ${reqId}] Messages存在: true, 长度: ${req.messages.length}`);
    if (req.messages.length > 0) {
      await logToFile(`[DEBUG][ReqID: ${reqId}] Messages角色: ${JSON.stringify(req.messages.map(m => m.role))}`);
    }
  } else {
    await logToFile(`[DEBUG][ReqID: ${reqId}] Messages存在: false`);
  }

  // 转换请求
  const transformed = {
    ...await transformMessages(req.messages),
    safetySettings,
    generationConfig: transformConfig(req),
  };

  // 记录转换后的结构
  await logToFile(`[DEBUG][ReqID: ${reqId}] 转换后的请求结构: ${JSON.stringify(Object.keys(transformed))}`);
  await logToFile(`[DEBUG][ReqID: ${reqId}] Contents字段存在: ${transformed.contents !== undefined}`);
  if (transformed.contents) {
    await logToFile(`[DEBUG][ReqID: ${reqId}] Contents长度: ${transformed.contents.length}`);
  }

  return transformed;
};

const generateChatcmplId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return "chatcmpl-" + Array.from({ length: 29 }, randomChar).join("");
};

const reasonsMap = {
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
};
const SEP = "";
const transformCandidates = (key, cand) => ({
  index: cand.index || 0,
  [key]: {
    role: "assistant",
    content: cand.content?.parts?.map(p => p.text || "").join(SEP) || null,
  },
  logprobs: null,
  finish_reason: reasonsMap[cand.finishReason] || cand.finishReason || null,
});
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

const transformUsage = (data) => ({
  completion_tokens: data?.candidatesTokenCount || 0,
  prompt_tokens: data?.promptTokenCount || 0,
  total_tokens: data?.totalTokenCount || 0
});

const processCompletionsResponse = (data, model, id) => {
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
    try {
      const jsonData = JSON.parse(this.buffer);
      if (jsonData.error) {
        console.error("Stream ended with error:", jsonData.error);
        controller.enqueue(JSON.stringify({
          id: this.id || generateChatcmplId(),
          choices: [{ index: 0, delta: {}, finish_reason: "error", error: jsonData.error }],
          created: Math.floor(Date.now()/1000),
          model: this.model || 'unknown',
          object: "chat.completion.chunk",
        }));
      } else {
         controller.enqueue(this.buffer);
      }
    } catch (e) {
       console.error("Invalid data at end of stream:", this.buffer);
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
  if (!data.candidates || data.candidates.length === 0) {
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
    item.delta = {};
  } else {
    item.finish_reason = null;
  }
  item.delta = item.delta || {};
  if (first) {
    item.delta.role = "assistant";
    if (!item.delta.content) item.delta.content = "";
  } else {
    delete item.delta.role;
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
    const errorData = {
      candidates: [{
        index: 0,
        finishReason: "error",
        content: { parts: [{ text: `Stream parsing error: ${err.message}` }] }
      }]
    };
    controller.enqueue(transform(errorData, true));
    return;
  }

  if (data.promptFeedback && data.promptFeedback.blockReason) {
      console.warn(`Stream blocked due to: ${data.promptFeedback.blockReason}`);
      const blockData = {
          candidates: [{
              index: 0,
              finishReason: "SAFETY",
              content: null
          }],
          usageMetadata: data.usageMetadata
      };
      controller.enqueue(transform(blockData, true));
      return;
  }

  if (!data.candidates || data.candidates.length === 0) {
      console.warn("Received stream chunk with no candidates and no block reason:", data);
      if (data.usageMetadata && this.streamIncludeUsage) {
          const usageData = {
              candidates: [{ index: 0, finishReason: "stop", content: null }],
              usageMetadata: data.usageMetadata
          };
          controller.enqueue(transform(usageData, true));
      }
      return;
  }

  const cand = data.candidates[0];
  cand.index = cand.index || 0;

  if (!this.last) this.last = [];

  if (!this.last[cand.index]) {
    controller.enqueue(transform(data, false, true));
  }
  this.last[cand.index] = data;

  if (cand.content && cand.content.parts && cand.content.parts.some(p => p.text)) {
    controller.enqueue(transform(data, false, false));
  }

  if (cand.finishReason) {
      controller.enqueue(transform(data, true, false));
  }
}
async function toOpenAiStreamFlush (controller) {
  const transform = transformResponseStream.bind(this);
  if (this.last && this.last.length > 0) {
    const lastData = this.last[this.last.length - 1];
    if (!lastData?.candidates?.[0]?.finishReason) {
       console.warn("Stream flushing without a final finishReason chunk.");
    }
  }
  controller.enqueue("data: [DONE]" + delimiter);
}


// --- 管理API处理函数 ---
async function handleKeyStats(requestId) { // Accept requestId
  await ensureKeysLoaded();
  const stats = {
    keys: keyManager.getKeyStats(),
    global: keyManager.getGlobalStats()
  };
   const response = new Response(JSON.stringify(stats, null, 2), fixCors({
    status: 200,
    headers: { "Content-Type": "application/json" }
  }));
   // Log admin response in main log
   await logToFile(formatLog('RESPONSE', {
       requestId: requestId,
       requestUrl: '/admin/keys/stats',
       status: response.status,
       statusText: response.statusText,
       headers: Object.fromEntries(response.headers.entries()),
       body: '[Stats Object]' // Avoid logging potentially large stats object here
   }));
   return response;
}

async function handleKeyReset(keyId, requestId) { // Accept requestId
  await ensureKeysLoaded();
  const success = keyManager.resetKey(keyId);
   const response = new Response(JSON.stringify({ success }), fixCors({
    status: success ? 200 : 404,
    headers: { "Content-Type": "application/json" }
  }));
   // Log admin response
   await logToFile(formatLog('RESPONSE', {
       requestId: requestId,
       requestUrl: `/admin/keys/reset/${keyId}`,
       status: response.status,
       statusText: response.statusText,
       headers: Object.fromEntries(response.headers.entries()),
       body: { success }
   }));
   return response;
}

async function handleGetConfig(requestId) { // Accept requestId
  await ensureKeysLoaded();
  const config = keyManager.getConfig();
   const response = new Response(JSON.stringify(config, null, 2), fixCors({
    status: 200,
    headers: { "Content-Type": "application/json" }
  }));
   // Log admin response
   await logToFile(formatLog('RESPONSE', {
       requestId: requestId,
       requestUrl: '/admin/keys/config',
       status: response.status,
       statusText: response.statusText,
       headers: Object.fromEntries(response.headers.entries()),
       body: config
   }));
   return response;
}

async function handleUpdateConfig(newConfig, requestId) { // Accept requestId
  await ensureKeysLoaded();
  const config = keyManager.updateConfig(newConfig);
   const response = new Response(JSON.stringify(config, null, 2), fixCors({
    status: 200,
    headers: { "Content-Type": "application/json" }
  }));
   // Log admin response
   await logToFile(formatLog('RESPONSE', {
       requestId: requestId,
       requestUrl: '/admin/keys/config (POST)',
       status: response.status,
       statusText: response.statusText,
       headers: Object.fromEntries(response.headers.entries()),
       body: config // Log the updated config
   }));
   return response;
}
