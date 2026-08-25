// background.js — Service worker untuk Chrome Extension

let captureStatus = {
  lastCapture: null,
  lastSuccess: false,
  lastError: null,
  contentReady: false,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_SUCCESS') {
    captureStatus.lastCapture = Date.now();
    captureStatus.lastSuccess = true;
    captureStatus.lastError = null;
    captureStatus.contentReady = true;
  } else if (msg.type === 'CAPTURE_ERROR') {
    captureStatus.lastSuccess = false;
    captureStatus.lastError = msg.error;
    captureStatus.contentReady = true;
  } else if (msg.type === 'CONTENT_READY') {
    captureStatus.contentReady = true;
    console.log('[BG] Content script ready on:', msg.url);
  } else if (msg.type === 'GET_STATUS') {
    sendResponse(captureStatus);
  }
  return true;
});

// Set badge
function updateBadge() {
  if (captureStatus.lastSuccess) {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
  } else if (captureStatus.lastError) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    chrome.action.setBadgeText({ text: '...' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  }
}

updateBadge();
