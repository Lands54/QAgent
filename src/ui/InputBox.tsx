import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface InputBoxProps {
  value: string;
  disabled?: boolean;
  completionHint?: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

export function InputBox({
  value,
  disabled = false,
  completionHint,
  onChange,
  onSubmit,
}: InputBoxProps) {
  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={disabled ? "gray" : "green"}
        paddingX={1}
      >
        {disabled ? (
          <Text color="yellow">[等待审批] 按 y 批准，按 n 拒绝，Ctrl+C 取消本轮执行</Text>
        ) : (
          <>
            <Text color="green">{"> "}</Text>
            <TextInput value={value} onChange={onChange} onSubmit={onSubmit} focus />
          </>
        )}
      </Box>
      {!disabled && completionHint ? <Text color="gray">{completionHint}</Text> : null}
    </Box>
  );
}
