import { Box, Text } from "ink";
import TextInput from "ink-text-input";

import type { CompletionSuggestion } from "./inputEnhancements.js";

interface InputBoxProps {
  value: string;
  disabled?: boolean;
  completionHint?: string;
  completionMode?: "idle" | "chat" | "command";
  completionSuggestions?: CompletionSuggestion[];
  completionSelectedIndex?: number;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

export function InputBox({
  value,
  disabled = false,
  completionHint,
  completionMode = "idle",
  completionSuggestions = [],
  completionSelectedIndex = 0,
  onChange,
  onSubmit,
}: InputBoxProps) {
  const isIdleMode = completionMode === "idle";
  const isCommandMode = completionMode === "command";
  const borderColor = disabled
    ? "yellow"
    : isCommandMode
      ? "cyan"
      : isIdleMode
        ? "blue"
        : "green";
  const accentColor = isCommandMode ? "cyan" : isIdleMode ? "blue" : "green";
  const modeLabel = isCommandMode
    ? "命令模式 | Enter 发送 | Tab 补全"
    : isIdleMode
      ? "待机模式 | 直接开口，或输入 / 打开命令台"
      : "对话模式 | Enter 发送 | Tab 补全";
  const promptLabel = isCommandMode ? "› " : isIdleMode ? "○ " : "> ";
  const suggestionTitle = isIdleMode ? "今天的热身动作" : undefined;
  const suggestionBorderColor = isIdleMode ? "blue" : "gray";

  return (
    <Box flexDirection="column" gap={1}>
      <Box
        borderStyle="round"
        borderColor={borderColor}
        paddingX={1}
        flexDirection="column"
      >
        {disabled ? (
          <Text color="yellow">[等待审批] 按 y 批准，按 n 拒绝，Ctrl+C 取消本轮执行</Text>
        ) : (
          <Box flexDirection="column">
            <Text color={accentColor}>{modeLabel}</Text>
            <Box>
              <Text color={accentColor}>{promptLabel}</Text>
              <TextInput value={value} onChange={onChange} onSubmit={onSubmit} focus />
            </Box>
          </Box>
        )}
      </Box>
      {!disabled && (completionSuggestions.length > 0 || completionHint) ? (
        <Box
          borderStyle="round"
          borderColor={suggestionBorderColor}
          paddingX={1}
          flexDirection="column"
        >
          {suggestionTitle ? <Text color={accentColor}>{suggestionTitle}</Text> : null}
          {completionHint ? <Text color="gray">{completionHint}</Text> : null}
          {completionSuggestions.map((suggestion, index) => {
            const selected = !isIdleMode && index === completionSelectedIndex;
            return (
              <Text key={suggestion.value} color={selected ? "cyan" : undefined}>
                {selected ? "›" : isIdleMode ? "·" : " "} {suggestion.displayValue ?? suggestion.value}
                <Text color="gray">  {suggestion.description}</Text>
              </Text>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
}
