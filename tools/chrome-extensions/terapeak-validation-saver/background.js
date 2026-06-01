chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'HANKUK_TERAPEAK_SCRAPE_STATUS') return false;

  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return false;

  const count = Number(message.count || 0);
  chrome.action.setBadgeBackgroundColor({ tabId, color: count > 0 ? '#16a34a' : '#6b7280' });
  chrome.action.setBadgeText({ tabId, text: count > 0 ? String(Math.min(count, 9)) : '' });
  chrome.action.setTitle({
    tabId,
    title: count > 0
      ? `${count} scrapeable Terapeak query${count === 1 ? '' : 'ies'} found`
      : 'Save Terapeak validation'
  });

  return false;
});
