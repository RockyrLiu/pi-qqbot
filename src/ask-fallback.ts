// ============================================================================
// ask_user_question 在 QQ 轮次的降级
//
// rpiv-ask-user-question 在 TUI 下用 ctx.ui.custom() 渲染全屏问卷并阻塞等待键盘；
// QQ 端既看不到弹窗也无法作答，而 pi 没有「从扩展侧回答一个进行中的 UI 提示」的
// API（ui_prompt_start/end 仅通知，tool_call 只能 block 不能替换结果）。
//
// 因此在 QQ 触发的轮次里：
//   1. 轮次开始前注入提示，让模型改用文本提问（省掉一次无效工具调用）；
//   2. 模型若仍调用该工具，用 tool_call 事件拦截（block），
//      reason 会作为工具结果回到模型，等于把「改用文本提问」的指令再喂一次。
// ============================================================================

/** rpiv-ask-user-question 注册的工具名。 */
export const ASK_TOOL_NAME = 'ask_user_question'

/** 轮次开始时注入的提示（display:false，不进入会话历史）。 */
export const QQ_ASK_GUIDANCE = [
  '[pi-qqbot] 本轮由 QQ 用户发起：用户在手机 QQ 上，看不到也无法操作电脑端的 TUI 问答弹窗。',
  `请不要调用 ${ASK_TOOL_NAME}（调用会被拦截）。`,
  '需要向用户确认时，直接在回复正文里提问：把问题写清楚，选项用 1. 2. 3. 编号列出，并说明可直接回复编号或文字。',
].join('\n')

/** 拦截工具调用时返回给模型的原因。 */
export const QQ_ASK_BLOCK_REASON = [
  `当前用户通过 QQ 交互，无法回答 TUI 问答弹窗，${ASK_TOOL_NAME} 已被 pi-qqbot 拦截。`,
  '请不要再次调用该工具；改为在回复正文里用编号列表直接提问。',
].join('\n')

export interface AskFallbackState {
  /** 桥接是否在运行（QQ 通道可用）。 */
  running: boolean
  /** 当前轮次是否由 QQ 触发。 */
  qqTurn: boolean
  /** 当前活跃工具列表里是否包含 ask 工具。 */
  askToolActive: boolean
}

/** 是否需要在轮次开始时注入「改用文本提问」的提示。 */
export function shouldInjectAskGuidance(
  state: AskFallbackState,
): boolean {
  return state.running && state.qqTurn && state.askToolActive
}

/** 是否拦截这次工具调用。 */
export function shouldBlockAskTool(
  toolName: string,
  state: Pick<AskFallbackState, 'running' | 'qqTurn'>,
): boolean {
  return toolName === ASK_TOOL_NAME && state.running && state.qqTurn
}

/** 构造注入用的自定义消息。 */
export function buildAskGuidanceMessage(): {
  customType: string
  content: Array<{ type: 'text'; text: string }>
  display: boolean
} {
  return {
    customType: 'qq-ask-fallback',
    content: [{ type: 'text', text: QQ_ASK_GUIDANCE }],
    display: false,
  }
}
