import { useState, useEffect, useRef, useCallback } from "react";

import { Message } from "./Message";
import { ChatInput } from "./ChatInput";
import { ANIMATION_KEYS_BRACKETS } from "../clippy-animation-helpers";
import { useChat } from "../contexts/ChatContext";
import { electronAi, clippyApi } from "../clippyApi";
import { useSharedState } from "../contexts/SharedStateContext";

export type ChatProps = {
  style?: React.CSSProperties;
};

export function Chat({ style }: ChatProps) {
  const { setAnimationKey, setStatus, status, messages, addMessage } =
    useChat();
  const { settings } = useSharedState();
  const [streamingMessageContent, setStreamingMessageContent] =
    useState<string>("");
  const [lastRequestUUID, setLastRequestUUID] = useState<string>(
    crypto.randomUUID(),
  );
  const apiStreamRef = useRef<{
    fullContent: string;
    filteredContent: string;
    hasSetAnimationKey: boolean;
    error: string | null;
    resolve: () => void;
  } | null>(null);

  useEffect(() => {
    clippyApi.onApiPromptChunk((requestUUID, chunk) => {
      if (!apiStreamRef.current) return;

      const stream = apiStreamRef.current;
      if (stream.fullContent === "") {
        setStatus("responding");
      }

      if (!stream.hasSetAnimationKey) {
        const { text, animationKey } = filterMessageContent(
          stream.fullContent + chunk,
        );
        stream.filteredContent = text;
        stream.fullContent = stream.fullContent + chunk;

        if (animationKey) {
          setAnimationKey(animationKey);
          stream.hasSetAnimationKey = true;
        }
      } else {
        stream.filteredContent += chunk;
      }

      setStreamingMessageContent(stream.filteredContent);
    });

    clippyApi.onApiPromptDone((requestUUID) => {
      if (apiStreamRef.current) {
        apiStreamRef.current.resolve();
      }
    });

    clippyApi.onApiPromptError((requestUUID, error) => {
      console.error("API prompt error:", error);
      if (apiStreamRef.current) {
        apiStreamRef.current.error = error;
        apiStreamRef.current.resolve();
      }
    });

    return () => {
      clippyApi.offApiPromptChunk();
      clippyApi.offApiPromptDone();
      clippyApi.offApiPromptError();
    };
  }, [setStatus, setAnimationKey]);

  const handleAbortMessage = () => {
    if (settings.useApiModel) {
      clippyApi.apiAbortRequest(lastRequestUUID);
    } else {
      electronAi.abortRequest(lastRequestUUID);
    }
  };

  const sendViaApi = useCallback(
    async (message: string, allMessages: Message[]) => {
      const requestUUID = crypto.randomUUID();
      setLastRequestUUID(requestUUID);

      const apiMessages = allMessages
        .filter((m) => m.content)
        .map((m) => ({
          role: m.sender === "clippy" ? ("assistant" as const) : ("user" as const),
          content: m.content!,
        }));

      const streamPromise = new Promise<void>((resolve) => {
        apiStreamRef.current = {
          fullContent: "",
          filteredContent: "",
          hasSetAnimationKey: false,
          error: null,
          resolve,
        };
      });

      await clippyApi.apiPromptStreaming({
        provider: settings.apiProvider,
        apiKey: settings.apiKey,
        modelId: settings.apiModelId,
        messages: apiMessages,
        systemPrompt: settings.systemPrompt || "",
        temperature: settings.temperature,
        requestUUID,
      });

      await streamPromise;

      const error = apiStreamRef.current?.error;
      const finalContent = apiStreamRef.current?.filteredContent || "";
      apiStreamRef.current = null;

      if (error) {
        throw new Error(error);
      }

      return finalContent;
    },
    [settings],
  );

  const sendViaLocal = async (message: string) => {
    const requestUUID = crypto.randomUUID();
    setLastRequestUUID(requestUUID);

    const response = await window.electronAi.promptStreaming(message, {
      requestUUID,
    });

    let fullContent = "";
    let filteredContent = "";
    let hasSetAnimationKey = false;

    for await (const chunk of response) {
      if (fullContent === "") {
        setStatus("responding");
      }

      if (!hasSetAnimationKey) {
        const { text, animationKey } = filterMessageContent(
          fullContent + chunk,
        );

        filteredContent = text;
        fullContent = fullContent + chunk;

        if (animationKey) {
          setAnimationKey(animationKey);
          hasSetAnimationKey = true;
        }
      } else {
        filteredContent += chunk;
      }

      setStreamingMessageContent(filteredContent);
    }

    return filteredContent;
  };

  const handleSendMessage = async (message: string) => {
    if (status !== "idle") {
      return;
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      content: message,
      sender: "user",
      createdAt: Date.now(),
    };

    await addMessage(userMessage);
    setStreamingMessageContent("");
    setStatus("thinking");

    try {
      let filteredContent: string;

      if (settings.useApiModel) {
        filteredContent = await sendViaApi(message, [
          ...messages,
          userMessage,
        ]);
      } else {
        filteredContent = await sendViaLocal(message);
      }

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        content: filteredContent,
        sender: "clippy",
        createdAt: Date.now(),
      };

      addMessage(assistantMessage);
    } catch (error: any) {
      console.error(error);
      addMessage({
        id: crypto.randomUUID(),
        content: `**API Error:** ${error.message || "Something went wrong. Check your API key and model ID."}`,
        sender: "clippy",
        createdAt: Date.now(),
      });
    } finally {
      setStreamingMessageContent("");
      setStatus("idle");
    }
  };

  return (
    <div style={style} className="chat-container">
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
      {status === "responding" && (
        <Message
          message={{
            id: "streaming",
            content: streamingMessageContent,
            sender: "clippy",
            createdAt: Date.now(),
          }}
        />
      )}
      <ChatInput onSend={handleSendMessage} onAbort={handleAbortMessage} />
    </div>
  );
}

/**
 * Filter the message content to get the text and animation key
 *
 * @param content - The content of the message
 * @returns The text and animation key
 */
function filterMessageContent(content: string): {
  text: string;
  animationKey: string;
} {
  let text = content;
  let animationKey = "";

  if (content === "[") {
    text = "";
  } else if (/^\[[A-Za-z]*$/m.test(content)) {
    text = content.replace(/^\[[A-Za-z]*$/m, "").trim();
  } else {
    // Check for animation keys in brackets
    for (const key of ANIMATION_KEYS_BRACKETS) {
      if (content.startsWith(key)) {
        animationKey = key.slice(1, -1);
        text = content.slice(key.length).trim();
        break;
      }
    }
  }

  return { text, animationKey };
}
