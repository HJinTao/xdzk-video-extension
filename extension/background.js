import { createController } from "./lib/controller.js";

const controller = createController(chrome);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  controller.dispatch(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || "操作失败，请重试。" }));
  return true;
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => { void controller.recordResponse(details).catch(() => {}); },
  { urls: ["https://kdlbptvideo.xidian.edu.cn/*", "http://kdlbptvideo.xidian.edu.cn/*"] },
  ["responseHeaders"]
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => { void controller.tabUpdated(tabId, changeInfo).catch(() => {}); });
chrome.tabs.onRemoved.addListener((tabId) => { void controller.tabRemoved(tabId).catch(() => {}); });
