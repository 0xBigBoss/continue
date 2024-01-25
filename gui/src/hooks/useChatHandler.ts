import { Dispatch } from "@reduxjs/toolkit";

import { JSONContent } from "@tiptap/react";
import {
  ChatHistory,
  ChatHistoryItem,
  ChatMessage,
  LLMReturnValue,
  MessageContent,
  SlashCommand,
} from "core";
import { ideStreamRequest, llmStreamChat } from "core/ide/messaging";
import { constructMessages } from "core/llm/constructMessages";
import { stripImages } from "core/llm/countTokens";
import { usePostHog } from "posthog-js/react";
import { useEffect, useRef } from "react";
import { useSelector } from "react-redux";
import resolveEditorContent from "../components/mainInput/resolveInput";
import { defaultModelSelector } from "../redux/selectors/modelSelectors";
import {
  addLogs,
  initNewActiveMessage,
  resubmitAtIndex,
  setInactive,
  setMessageAtIndex,
  streamUpdate,
} from "../redux/slices/stateSlice";
import { RootStore } from "../redux/store";
import { errorPopup } from "../util/ide";

function useChatHandler(dispatch: Dispatch) {
  const posthog = usePostHog();

  const defaultModel = useSelector(defaultModelSelector);

  const slashCommands = useSelector(
    (store: RootStore) => store.state.config.slashCommands || []
  );

  const contextItems = useSelector(
    (state: RootStore) => state.state.contextItems
  );
  const embeddingsProvider = useSelector(
    (state: RootStore) => state.state.config.embeddingsProvider
  );
  const history = useSelector((store: RootStore) => store.state.history);
  const contextProviders = useSelector(
    (store: RootStore) => store.state.config.contextProviders || []
  );
  const active = useSelector((store: RootStore) => store.state.active);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  async function _streamNormalInput(messages: ChatMessage[]) {
    const abortController = new AbortController();
    const cancelToken = abortController.signal;
    const gen = llmStreamChat(defaultModel.title, cancelToken, messages);
    let next = await gen.next();

    while (!next.done) {
      if (!activeRef.current) {
        abortController.abort();
        break;
      }
      dispatch(streamUpdate((next.value as ChatMessage).content));
      next = await gen.next();
    }

    let returnVal = next.value as LLMReturnValue;
    if (returnVal) {
      dispatch(addLogs([[returnVal?.prompt, returnVal?.completion]]));
    }
  }

  const getSlashCommandForInput = (
    input: MessageContent
  ): [SlashCommand, string] | undefined => {
    let slashCommand: SlashCommand | undefined;
    let slashCommandName: string | undefined;

    let firstText =
      typeof input === "string"
        ? input
        : input.filter((part) => part.type === "text")[0]?.text || "";

    if (firstText.startsWith("/")) {
      slashCommandName = firstText.split(" ")[0].substring(1);
      slashCommand = slashCommands.find(
        (command) => command.name === slashCommandName
      );
    }
    if (!slashCommand || !slashCommandName) {
      return undefined;
    }

    // Convert to actual slash command object with runnable function
    return [slashCommand, stripImages(input)];
  };

  async function _streamSlashCommand(
    messages: ChatMessage[],
    slashCommand: SlashCommand,
    input: string
  ) {
    const modelTitle = defaultModel.title;

    for await (const update of ideStreamRequest("runNodeJsSlashCommand", {
      input,
      history: messages,
      modelTitle,
      slashCommandName: slashCommand.name,
      contextItems,
      params: slashCommand.params,
    })) {
      if (!activeRef.current) {
        break;
      }
      if (typeof update === "string") {
        dispatch(streamUpdate(update));
      }
    }
  }

  async function streamResponse(editorState: JSONContent, index?: number) {
    try {
      if (typeof index === "number") {
        dispatch(resubmitAtIndex({ index, editorState }));
      } else {
        dispatch(initNewActiveMessage({ editorState }));
      }

      // Resolve context providers and construct new history
      const [contextItems, content] = await resolveEditorContent(
        editorState,
        contextProviders,
        defaultModel,
        embeddingsProvider
      );
      const message: ChatMessage = {
        role: "user",
        content,
      };
      const historyItem: ChatHistoryItem = {
        message,
        contextItems:
          typeof index === "number"
            ? history[index].contextItems
            : contextItems,
        editorState,
      };

      let newHistory: ChatHistory = [...history.slice(0, index), historyItem];
      dispatch(
        setMessageAtIndex({
          message,
          index: index || newHistory.length - 1,
          contextItems,
        })
      );

      // TODO: hacky way to allow rerender
      await new Promise((resolve) => setTimeout(resolve, 0));

      posthog.capture("step run", {
        step_name: "User Input",
        params: {
          user_input: content,
        },
      });
      posthog.capture("userInput", {
        input: content,
      });

      const messages = constructMessages(newHistory);

      // Determine if the input is a slash command
      let commandAndInput = getSlashCommandForInput(content);

      if (!commandAndInput) {
        await _streamNormalInput(messages);
      } else {
        const [slashCommand, commandInput] = commandAndInput;
        posthog.capture("step run", {
          step_name: slashCommand.name,
          params: {
            user_input: commandInput,
          },
        });
        await _streamSlashCommand(messages, slashCommand, commandInput);
      }
    } catch (e) {
      console.log("Continue: error streaming response: ", e);
      errorPopup(`Error streaming response: ${e.message}`);
    } finally {
      dispatch(setInactive());
    }
  }

  return { streamResponse };
}

export default useChatHandler;
