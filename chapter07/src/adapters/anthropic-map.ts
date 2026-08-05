/** Anthropic Messages API's stop_reason value */
export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | null;

export function stopReasonToFinishReason(
    stopReason: AnthropicStopReason | undefined, 
)  : string | null {
    switch(stopReason) {
        case 'end_turn':
            case 'stop_sequence':
              return 'stop';
            case 'max_tokens':
              return 'length';
            case 'tool_use':
              return 'tool_calls';
            case null:
            case undefined:
              return null;
            default:
              return stopReason;
    }
}