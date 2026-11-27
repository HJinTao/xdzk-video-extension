export const AUTO_REFRESH_COOLDOWN_MS = 30_000;
export const LOGIN_PORTAL_URL = "https://xdspoc.xidian.edu.cn/";

export function refreshFailureActions(reason, onRetry) {
  const retry = {
    type: "button",
    label: reason === "login" ? "更新视频源" : "重试更新视频源",
    onClick: onRetry
  };
  if (reason === "login") {
    return [
      { type: "link", label: "前往西电智课登录 ↗", href: LOGIN_PORTAL_URL },
      retry
    ];
  }
  if (reason === "network") return [retry];
  return [];
}

export function canTriggerAutoRefresh({
  detail,
  currentLiveId,
  autoRefreshing,
  switchingLesson,
  autoRefreshFailedFor,
  lastAutoRefreshSuccessAt,
  now = Date.now()
}) {
  return detail?.kind === "media"
    && !!currentLiveId
    && !autoRefreshing
    && !switchingLesson
    && autoRefreshFailedFor !== currentLiveId
    && (now - lastAutoRefreshSuccessAt) >= AUTO_REFRESH_COOLDOWN_MS;
}

export function renderMessageBar(bar, textNode, actionsBox, text = "", { actions = [] } = {}) {
  const doc = bar.ownerDocument;
  textNode.textContent = text;
  actionsBox.replaceChildren();
  for (const action of actions) {
    if (action.type === "link") {
      const link = doc.createElement("a");
      link.className = "message-link";
      link.href = action.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = action.label;
      actionsBox.append(link);
    } else if (action.type === "button") {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "message-retry";
      button.textContent = action.label;
      button.addEventListener("click", action.onClick);
      actionsBox.append(button);
    }
  }
  actionsBox.hidden = actions.length === 0;
  bar.hidden = !text;
}
