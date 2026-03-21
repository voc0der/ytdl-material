var enabledIconPaths = {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    64: 'icons/icon-64.png',
    128: 'icons/icon-128.png'
};

var hiddenIconPaths = {
    16: 'icons/transparent-16.png',
    32: 'icons/transparent-32.png',
    48: 'icons/transparent-48.png',
    64: 'icons/transparent-64.png',
    128: 'icons/transparent-128.png'
};

function isSupportedYouTubeUrl(url) {
    if (!url) {
        return false;
    }

    try {
        var parsed = new URL(url);
        var hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();

        return hostname === 'youtube.com' ||
            hostname === 'm.youtube.com' ||
            hostname === 'music.youtube.com' ||
            hostname === 'youtu.be';
    } catch (err) {
        return false;
    }
}

function setActionState(tabId, enabled) {
    chrome.browserAction.setPopup({
        tabId: tabId,
        popup: enabled ? 'popup.html' : ''
    });

    chrome.browserAction.setIcon({
        tabId: tabId,
        path: enabled ? enabledIconPaths : hiddenIconPaths
    });

    chrome.browserAction.setTitle({
        tabId: tabId,
        title: enabled ? 'ytdl-material' : 'ytdl-material (available on YouTube pages)'
    });

    if (enabled) {
        chrome.browserAction.enable(tabId);
        return;
    }

    chrome.browserAction.disable(tabId);
}

function updateActionForTab(tabId, tab) {
    if (typeof tabId !== 'number' || tabId < 0) {
        return;
    }

    if (tab && typeof tab.url === 'string') {
        setActionState(tabId, isSupportedYouTubeUrl(tab.url));
        return;
    }

    chrome.tabs.get(tabId, function(fetchedTab) {
        if (chrome.runtime.lastError) {
            return;
        }

        setActionState(tabId, isSupportedYouTubeUrl(fetchedTab && fetchedTab.url));
    });
}

function refreshAllTabs() {
    chrome.tabs.query({}, function(tabs) {
        if (chrome.runtime.lastError || !tabs) {
            return;
        }

        tabs.forEach(function(tab) {
            updateActionForTab(tab.id, tab);
        });
    });
}

chrome.runtime.onInstalled.addListener(function() {
    refreshAllTabs();
});

if (chrome.runtime.onStartup) {
    chrome.runtime.onStartup.addListener(function() {
        refreshAllTabs();
    });
}

chrome.tabs.onActivated.addListener(function(activeInfo) {
    updateActionForTab(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    if (typeof changeInfo.status === 'undefined' && typeof changeInfo.url === 'undefined') {
        return;
    }

    updateActionForTab(tabId, tab);
});

chrome.windows.onFocusChanged.addListener(function(windowId) {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        return;
    }

    chrome.tabs.query({ active: true, windowId: windowId }, function(tabs) {
        if (chrome.runtime.lastError || !tabs || !tabs.length) {
            return;
        }

        updateActionForTab(tabs[0].id, tabs[0]);
    });
});

refreshAllTabs();
