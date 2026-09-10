// ============================================================================
// QQ 桥接安全边界
// ============================================================================

/** 单聊：只接受扫码绑定用户，或显式加入白名单的 openid。空 id 一律不放行。 */
export function isAuthorizedC2cSender(
  senderId: string | undefined,
  boundUserOpenId: string,
  allowedUsers: readonly string[] = [],
): boolean {
  if (!senderId) return false
  if (boundUserOpenId && senderId === boundUserOpenId) return true
  return allowedUsers.includes(senderId)
}

/** 群聊：默认只接受白名单群；只有显式开启 allowAll 才放行任意群。 */
export function isAuthorizedGroup(
  groupOpenId: string | undefined,
  allowedGroups: readonly string[] = [],
  allowAll = false,
): boolean {
  if (!groupOpenId) return false
  if (allowedGroups.includes(groupOpenId)) return true
  return allowAll
}
