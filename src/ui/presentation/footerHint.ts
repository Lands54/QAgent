interface FooterHintInput {
  currentTokenEstimate: number;
  autoCompactThresholdTokens: number;
}

export function buildFooterHint(input: FooterHintInput): string {
  const tokenRatio =
    input.autoCompactThresholdTokens > 0
      ? (input.currentTokenEstimate / input.autoCompactThresholdTokens) * 100
      : 0;
  const tokenSummary = `tokens: ${input.currentTokenEstimate}/${input.autoCompactThresholdTokens} (${tokenRatio.toFixed(1)}%)`;

  return [
    "slash: /help",
    "history: ↑/↓",
    "agents: Ctrl+P/Ctrl+N",
    "complete: Tab",
    "approval: y/n",
    "Ctrl+C: 中断当前执行或退出",
    tokenSummary,
  ].join(" | ");
}
