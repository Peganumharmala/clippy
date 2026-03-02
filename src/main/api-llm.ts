import { BrowserWindow, net } from "electron";
import { IpcMessages } from "../ipc-messages";
import { ApiProvider } from "../models";
import { getLogger } from "./logger";

interface ApiMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ApiPromptRequest {
  provider: ApiProvider;
  apiKey: string;
  modelId: string;
  messages: ApiMessage[];
  systemPrompt: string;
  temperature?: number;
  requestUUID: string;
}

const activeRequests = new Map<string, AbortController>();

export function abortApiRequest(requestUUID: string) {
  const controller = activeRequests.get(requestUUID);
  if (controller) {
    controller.abort();
    activeRequests.delete(requestUUID);
  }
}

export async function apiPromptStreaming(
  window: BrowserWindow,
  request: ApiPromptRequest,
) {
  const controller = new AbortController();
  activeRequests.set(request.requestUUID, controller);

  try {
    switch (request.provider) {
      case "openai":
        await streamOpenAI(window, request, controller.signal);
        break;
      case "anthropic":
        await streamAnthropic(window, request, controller.signal);
        break;
      case "gemini":
        await streamGemini(window, request, controller.signal);
        break;
    }
  } catch (error: any) {
    if (error.name === "AbortError") {
      getLogger().info("API request aborted", { uuid: request.requestUUID });
    } else {
      const errorMsg = error.message || "Unknown API error";
      getLogger().error("API streaming error", errorMsg);
      window.webContents.send(
        IpcMessages.API_PROMPT_ERROR,
        request.requestUUID,
        errorMsg,
      );
    }
  } finally {
    activeRequests.delete(request.requestUUID);
    window.webContents.send(
      IpcMessages.API_PROMPT_DONE,
      request.requestUUID,
    );
  }
}

async function streamOpenAI(
  window: BrowserWindow,
  request: ApiPromptRequest,
  signal: AbortSignal,
) {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: request.systemPrompt },
    ...request.messages,
  ];

  const response = await net.fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.modelId,
        messages,
        stream: true,
        temperature: request.temperature ?? 0.7,
      }),
      signal,
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${body}`);
  }

  await processSSEStream(response, signal, (line) => {
    if (line === "[DONE]") return null;
    try {
      const parsed = JSON.parse(line);
      return parsed.choices?.[0]?.delta?.content ?? null;
    } catch {
      return null;
    }
  }, (chunk) => {
    window.webContents.send(
      IpcMessages.API_PROMPT_CHUNK,
      request.requestUUID,
      chunk,
    );
  });
}

async function streamAnthropic(
  window: BrowserWindow,
  request: ApiPromptRequest,
  signal: AbortSignal,
) {
  const response = await net.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": request.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.modelId,
      system: request.systemPrompt,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
      max_tokens: 4096,
      temperature: request.temperature ?? 0.7,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${body}`);
  }

  await processSSEStream(response, signal, (line, event) => {
    if (event === "content_block_delta") {
      try {
        const parsed = JSON.parse(line);
        return parsed.delta?.text ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }, (chunk) => {
    window.webContents.send(
      IpcMessages.API_PROMPT_CHUNK,
      request.requestUUID,
      chunk,
    );
  });
}

async function streamGemini(
  window: BrowserWindow,
  request: ApiPromptRequest,
  signal: AbortSignal,
) {
  const contents = [
    { role: "user", parts: [{ text: request.systemPrompt }] },
    { role: "model", parts: [{ text: "Understood." }] },
    ...request.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
  ];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${request.modelId}:streamGenerateContent?key=${request.apiKey}&alt=sse`;

  const response = await net.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: request.temperature ?? 0.7,
      },
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${body}`);
  }

  await processSSEStream(response, signal, (line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    } catch {
      return null;
    }
  }, (chunk) => {
    window.webContents.send(
      IpcMessages.API_PROMPT_CHUNK,
      request.requestUUID,
      chunk,
    );
  });
}

async function processSSEStream(
  response: Response,
  signal: AbortSignal,
  extractText: (data: string, event?: string) => string | null,
  onChunk: (text: string) => void,
) {
  if (!response.body) {
    const text = await response.text();
    processSSELines(text.split("\n"), signal, extractText, onChunk);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  try {
    while (true) {
      if (signal.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6);
          const extracted = extractText(data, currentEvent);
          if (extracted) {
            onChunk(extracted);
          }
        } else if (line.trim() === "") {
          currentEvent = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function processSSELines(
  lines: string[],
  signal: AbortSignal,
  extractText: (data: string, event?: string) => string | null,
  onChunk: (text: string) => void,
) {
  let currentEvent = "";
  for (const line of lines) {
    if (signal.aborted) break;
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      const data = line.slice(6);
      const extracted = extractText(data, currentEvent);
      if (extracted) {
        onChunk(extracted);
      }
    } else if (line.trim() === "") {
      currentEvent = "";
    }
  }
}
