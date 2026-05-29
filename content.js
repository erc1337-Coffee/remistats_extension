// Content script for overlaying user scores on X.com.

// Inject font into page
const fontUrl = chrome.runtime.getURL('RemiliaMincho-Regular.otf');
const fontStyle = document.createElement('style');
fontStyle.textContent = `
  @font-face {
    font-family: 'Remilia Mincho';
    src: url('${fontUrl}') format('opentype');
    font-weight: normal;
    font-style: normal;
    font-display: swap;
  }
`;
document.head.appendChild(fontStyle);

// Configuration
const CONFIG = {
  apiEndpoint: 'https://api.remistats.net/user', // Real API endpoint
  cacheTimeout: 5 * 60 * 1000, // 5 minutes
  observerDebounce: 100,
  batchSize: 50, // Max usernames per batch request
  batchDelay: 100 // Delay before sending batch (ms)
};

// Cache for user scores
const scoreCache = new Map();

// Batch fetching queue
let batchQueue = new Set();
let batchTimeout = null;
const batchPromises = new Map();

// Debounce helper
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Routes that look like usernames in URLs but aren't
const ROUTE_BLOCKLIST = new Set([
  'home', 'explore', 'notifications', 'messages', 'settings', 'compose',
  'search', 'i', 'tos', 'privacy', 'login', 'signup', 'logout', 'about',
  'jobs', 'lists', 'bookmarks', 'communities', 'topics', 'verified-orgs-signup'
]);

// Find the first profile-link username inside a container, skipping routes
// like /messages/<id> that appear in DM cells before the avatar link.
function findUsernameInLinks(container) {
  const links = container.querySelectorAll('a[href^="/"]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (href.includes('/status/')) continue;
    const match = href.match(/^\/([^\/\?#]+)(?:\/|$)/);
    if (!match) continue;
    const candidate = match[1];
    if (ROUTE_BLOCKLIST.has(candidate)) continue;
    return candidate;
  }
  return null;
}

// Extract username from X's avatar testid convention: UserAvatar-Container-<username>
function extractUsernameFromAvatar(container) {
  const avatar = container.querySelector('[data-testid^="UserAvatar-Container-"]');
  if (avatar) {
    const testid = avatar.getAttribute('data-testid');
    const candidate = testid.replace('UserAvatar-Container-', '').trim();
    if (candidate && !ROUTE_BLOCKLIST.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Extract username from various Twitter/X elements
function extractUsername(element) {
  const userCell = element.closest('[data-testid="UserCell"]');
  const tweet = element.closest('[data-testid="tweet"]');
  const container = userCell || tweet;

  let username = null;

  if (container) {
    // Most reliable: X's own avatar testid always has the username baked in
    username = extractUsernameFromAvatar(container);

    if (!username) {
      username = findUsernameInLinks(container);
    }

    if (!username) {
      const screenNameEl = container.querySelector('[data-screen-name]');
      if (screenNameEl) {
        username = screenNameEl.getAttribute('data-screen-name');
      }
    }

    if (!username) {
      const profileLink = container.querySelector('a[aria-label*="@"]');
      if (profileLink) {
        const label = profileLink.getAttribute('aria-label');
        const match = label.match(/@(\w+)/);
        if (match) {
          username = match[1];
        }
      }
    }
  }

  return username ? username.replace('@', '') : null;
}

// Store max values globally
let maxBeetles = 100;
let maxScore = 1000;

// Process batch of usernames
async function processBatch(usernames) {
  const results = {};
  // Negative cache: every requested handle that isn't in the response is
  // stored as a "not found" sentinel so we don't refetch it on every
  // observer tick. Without this, 404s (or unknown users) trigger an
  // infinite retry loop as the MutationObserver keeps firing.
  const requested = Array.from(usernames).map(u => u.toLowerCase());
  const cacheNotFound = () => {
    const now = Date.now();
    for (const handle of requested) {
      if (!scoreCache.has(handle)) {
        scoreCache.set(handle, { data: null, timestamp: now });
      }
    }
  };

  try {
    const url = `${CONFIG.apiEndpoint}/${Array.from(usernames).join(',')}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error('RemiStats API returned non-OK status:', response.status);
      cacheNotFound();
      return results;
    }

    const data = await response.json();

    if (data.max_beetles !== undefined) maxBeetles = data.max_beetles;
    if (data.max_score !== undefined) maxScore = data.max_score;

    if (data.user) {
      const userData = transformApiResponse(data.user);
      const handle = data.user.twitterHandle.toLowerCase();
      scoreCache.set(handle, { data: userData, timestamp: Date.now() });
      results[handle] = userData;
    }

    if (data.users) {
      for (const [handle, user] of Object.entries(data.users)) {
        const userData = transformApiResponse(user);
        const normalized = handle.toLowerCase();
        scoreCache.set(normalized, { data: userData, timestamp: Date.now() });
        results[normalized] = userData;
      }
    }
  } catch (error) {
    console.error('RemiStats API error:', error.message);
  }

  cacheNotFound();
  return results;
}

// Transform API response to extension format
function transformApiResponse(apiUser) {
  return {
    username: apiUser.username,
    twitterHandle: apiUser.twitterHandle,
    displayName: apiUser.displayName,
    score: apiUser.socialCreditScore,
    beetleCount: apiUser.beetles,
    followers: apiUser.friendCount,
    pfpProject: apiUser.pfpProject,
    pfpId: apiUser.pfpId,
    trophyShelves: apiUser.trophyShelves || [],
    shelfTexture: apiUser.shelfTexture || null
  };
}

// Fetch user score with batching
async function fetchUserScore(username) {
  const normalizedUsername = username.toLowerCase();
  
  // Check cache first
  const cached = scoreCache.get(normalizedUsername);
  if (cached && Date.now() - cached.timestamp < CONFIG.cacheTimeout) {
    return cached.data;
  }
  
  // Add to batch queue
  return new Promise((resolve) => {
    // Store promise resolver
    if (!batchPromises.has(normalizedUsername)) {
      batchPromises.set(normalizedUsername, []);
    }
    batchPromises.get(normalizedUsername).push(resolve);
    
    // Add to queue
    batchQueue.add(normalizedUsername);
    
    // Clear existing timeout
    if (batchTimeout) {
      clearTimeout(batchTimeout);
    }
    
    // Set new timeout to process batch
    batchTimeout = setTimeout(async () => {
      const usernamesToFetch = Array.from(batchQueue).slice(0, CONFIG.batchSize);
      batchQueue.clear();
      
      // Fetch batch
      const results = await processBatch(usernamesToFetch);
      
      // Resolve all waiting promises
      usernamesToFetch.forEach(user => {
        const resolvers = batchPromises.get(user);
        if (resolvers) {
          const userData = results[user]; // null/undefined if user not found
          resolvers.forEach(resolve => resolve(userData));
          batchPromises.delete(user);
        }
      });
    }, CONFIG.batchDelay);
  });
}

// Create score badge element
function createScoreBadge(scoreData) {
  const badge = document.createElement('div');
  badge.className = 'reminet-score-badge';
  badge.setAttribute('data-reminet-badge', 'true');
  
  const beetleCount = scoreData.beetleCount || Math.floor(scoreData.score / 10);
  
  // Get extension URLs for images
  const beetleUrl = chrome.runtime.getURL('beetle.png');
  const starUrl = chrome.runtime.getURL('star.svg');
  
  badge.innerHTML = `
    <div class="reminet-badge-content">
      <div class="reminet-badge-group">
        <img src="${starUrl}" class="reminet-star" alt="★" />
        <span class="reminet-label">${scoreData.score}</span>
      </div>
      <div class="reminet-badge-group">
        <img src="${beetleUrl}" class="reminet-beetle" alt="🪲" />
        <span class="reminet-label">${beetleCount}</span>
      </div>
    </div>
  `;
  
  // Create tooltip as a separate element attached to body (not nested in badge)
  const tooltip = document.createElement('div');
  tooltip.className = 'reminet-tooltip';
  tooltip.setAttribute('data-reminet-tooltip', 'true');
  
  // Calculate progress percentages
  const scorePercent = Math.min(100, (scoreData.score / maxScore) * 100);
  const beetlePercent = Math.min(100, (beetleCount / maxBeetles) * 100);
  
  // Build PFP image URL if we have project and ID
  const pfpImageUrl = (scoreData.pfpProject && scoreData.pfpId) 
    ? `https://pfp.remilia.net/pfp/${scoreData.pfpProject.toLowerCase()}/${scoreData.pfpId}`
    : '';
  
  const pfpInfo = scoreData.pfpProject ? `${scoreData.pfpProject} #${scoreData.pfpId}` : '';
  
  const shelfTextureUrl = scoreData.shelfTexture
    ? `data:image/png;base64,${scoreData.shelfTexture}`
    : null;
  const trophies = (scoreData.trophyShelves || []).slice(0, 6);

  if (shelfTextureUrl) {
    tooltip.style.backgroundImage = `url('${shelfTextureUrl}')`;
    tooltip.style.backgroundSize = 'cover';
    tooltip.style.backgroundPosition = 'center';
    tooltip.style.backgroundRepeat = 'no-repeat';
    tooltip.classList.add('reminet-tooltip--textured');
  }

  tooltip.innerHTML = `
    <div class="reminet-tooltip-header">
      <span class="reminet-tooltip-displayname">${scoreData.displayName || scoreData.username}</span>
      <span class="reminet-tooltip-handle">@${scoreData.twitterHandle || scoreData.username}</span>
    </div>
    ${pfpInfo ? `<div class="reminet-tooltip-pfp">
      ${pfpImageUrl ? `<img src="${pfpImageUrl}" alt="${pfpInfo}" class="pfp-image" onerror="this.style.display='none';" />` : ''}
      <span class="pfp-label">${pfpInfo}</span>
    </div>` : ''}
    ${trophies.length > 0 ? `<div class="reminet-trophy-shelf">
      <div class="reminet-trophy-items">
        ${trophies.map(url => `<img src="${url}" class="reminet-trophy-item" alt="" onerror="this.style.display='none';" />`).join('')}
      </div>
    </div>` : ''}
    <div class="reminet-tooltip-metrics">
      <div class="metric">
        <span class="metric-label">Score</span>
        <div class="metric-bar">
          <div class="metric-fill" style="width: ${scorePercent}%;"></div>
        </div>
        <span class="metric-value">${scoreData.score} / ${maxScore}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Beetles</span>
        <div class="metric-bar">
          <div class="metric-fill" style="width: ${beetlePercent}%;"></div>
        </div>
        <span class="metric-value">${beetleCount} / ${maxBeetles}</span>
      </div>
    </div>
    <div class="reminet-tooltip-footer">
      <span>${scoreData.followers?.toLocaleString() || 0} friends</span>
    </div>
  `;
  
  // Position tooltip on hover
  const badgeContent = badge.querySelector('.reminet-badge-content');
  let isTooltipVisible = false;
  
  const showTooltip = async () => {
    // Check if tooltips are enabled
    const settings = await chrome.storage.sync.get(['showTooltips']);
    if (settings.showTooltips === false) return;
    
    const rect = badgeContent.getBoundingClientRect();
    tooltip.style.left = `${rect.left + rect.width / 2}px`;
    tooltip.style.top = `${rect.bottom + 8}px`;
    tooltip.classList.add('visible');
    isTooltipVisible = true;
  };
  
  const hideTooltip = () => {
    tooltip.classList.remove('visible');
    isTooltipVisible = false;
  };
  
  badgeContent.addEventListener('mouseenter', showTooltip);
  badgeContent.addEventListener('mouseleave', hideTooltip);
  
  // Update tooltip position on scroll
  let scrollTimeout;
  const updateTooltipPosition = () => {
    if (isTooltipVisible) {
      const rect = badgeContent.getBoundingClientRect();
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
      tooltip.style.top = `${rect.bottom + 8}px`;
    }
  };
  
  window.addEventListener('scroll', () => {
    if (isTooltipVisible) {
      updateTooltipPosition();
      // Hide tooltip after scrolling stops for better UX
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(hideTooltip, 300);
    }
  }, true);
  
  // Cleanup tooltip when badge is removed
  const cleanupObserver = new MutationObserver((mutations) => {
    if (!document.body.contains(badge)) {
      tooltip.remove();
      cleanupObserver.disconnect();
    }
  });
  cleanupObserver.observe(document.body, { childList: true, subtree: true });
  
  // Append tooltip to body for maximum z-index effectiveness
  document.body.appendChild(tooltip);
  
  // Prevent hover events from propagating to parent elements (Twitter's native hover)
  badge.addEventListener('mouseenter', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    
    // Play hover sound if enabled
    const settings = await chrome.storage.sync.get(['soundsEnabled']);
    if (settings.soundsEnabled !== false && window.reminetSounds) {
      window.reminetSounds.playHover();
    }
  });
  
  badge.addEventListener('mouseover', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  
  
  badge.addEventListener('mouseleave', (e) => {
    e.stopPropagation();
  });
  
  // Click badge to open remilia.net profile
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    window.open(`https://remilia.net/~${scoreData.username}`, '_blank');
  });
  
  return badge;
}

// Find a sensible anchor element next to which the badge should sit.
// Order of preference:
//   1. <time> element (tweets and user cells)
//   2. [data-testid="User-Name"] (tweets)
//   3. Any [dir="ltr"][class*="css"] block as a last resort
function insertBadgeIntoElement(element, badge) {
  const timeElement = element.querySelector('time');
  if (timeElement && timeElement.parentElement) {
    timeElement.parentElement.insertBefore(badge, timeElement.nextSibling);
    return true;
  }

  const userNameContainer = element.querySelector('[data-testid="User-Name"]');
  if (userNameContainer) {
    const insertPoint = userNameContainer.querySelector('[dir="ltr"]') || userNameContainer;
    if (insertPoint.parentElement) {
      insertPoint.parentElement.insertBefore(badge, insertPoint.nextSibling);
      return true;
    }
  }

  const fallback = element.querySelector('[dir="ltr"][class*="css"]');
  if (fallback && fallback.parentElement) {
    const insertPoint = fallback.querySelector('[dir="ltr"]') || fallback;
    insertPoint.parentElement.insertBefore(badge, insertPoint.nextSibling);
    return true;
  }

  return false;
}

// Insert badge into the DOM for tweets and user cells
async function insertBadge(element) {
  // Check if badge already exists
  if (element.querySelector('[data-reminet-badge]')) {
    return;
  }
  
  // Mark element as processing to prevent duplicate insertions during async operations
  if (element.hasAttribute('data-reminet-processing')) {
    return;
  }
  element.setAttribute('data-reminet-processing', 'true');
  
  const username = extractUsername(element);
  if (!username) {
    element.removeAttribute('data-reminet-processing');
    return;
  }
  
  try {
    const scoreData = await fetchUserScore(username);

    if (!scoreData) {
      element.removeAttribute('data-reminet-processing');
      return;
    }

    const badge = createScoreBadge(scoreData);
    
    // Remove processing flag since we're about to insert the badge
    element.removeAttribute('data-reminet-processing');
    
    insertBadgeIntoElement(element, badge);
  } catch (error) {
    console.error('Error inserting badge:', error);
    element.removeAttribute('data-reminet-processing');
  }
}

// Track which profiles have been processed
const processedProfiles = new Set();

// Insert badge on profile pages
async function insertProfileBadge() {
  // Check if we're on a profile page
  const profileHeader = document.querySelector('[data-testid="UserProfileHeader_Items"]');
  if (!profileHeader) {
    return;
  }
  
  // Find the username/handle section
  const userNameSection = document.querySelector('[data-testid="UserName"]');
  if (!userNameSection) {
    return;
  }
  
  // Check if badge already exists in this specific location
  if (userNameSection.querySelector('[data-reminet-badge]')) {
    return;
  }
  
  // Check if already processing
  if (userNameSection.hasAttribute('data-reminet-processing')) {
    return;
  }
  userNameSection.setAttribute('data-reminet-processing', 'true');
  
  // Extract username from URL or from the handle in the profile
  let username = null;
  
  // Try to get from URL first
  const urlMatch = window.location.pathname.match(/^\/([^\/\?]+)/);
  if (urlMatch && urlMatch[1] && !['home', 'explore', 'notifications', 'messages', 'settings', 'i'].includes(urlMatch[1])) {
    username = urlMatch[1];
  }
  
  // Fallback: try to extract from the page
  if (!username) {
    const handleElement = userNameSection.querySelector('[href^="/"]');
    if (handleElement) {
      const href = handleElement.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);
      if (match) {
        username = match[1];
      }
    }
  }
  
  if (!username) {
    userNameSection.removeAttribute('data-reminet-processing');
    return;
  }
  
  // Create a unique key for this profile + location
  const profileKey = `${username}-${window.location.pathname}`;
  if (processedProfiles.has(profileKey)) {
    userNameSection.removeAttribute('data-reminet-processing');
    return;
  }
  processedProfiles.add(profileKey);
  
  try {
    const scoreData = await fetchUserScore(username);

    if (!scoreData) {
      userNameSection.removeAttribute('data-reminet-processing');
      return;
    }

    userNameSection.removeAttribute('data-reminet-processing');
    const badge = createScoreBadge(scoreData);
    badge.style.marginLeft = '8px';
    badge.style.display = 'inline-flex';
    badge.style.verticalAlign = 'middle';
    badge.setAttribute('data-profile-badge', username);
    
    // Find the handle text (the @username part)
    const handleSpan = userNameSection.querySelector('span[style*="color"]');
    if (handleSpan && handleSpan.textContent.startsWith('@')) {
      handleSpan.parentElement.appendChild(badge);
    } else {
      // Fallback: append to the username section
      userNameSection.appendChild(badge);
    }
  } catch (error) {
    console.error('Error inserting profile badge:', error);
    userNameSection.removeAttribute('data-reminet-processing');
    // Remove from processed set on error so we can retry
    processedProfiles.delete(profileKey);
  }
}

// Compact score-only "ribbon" anchored under sender avatars in group chats.
function createCompactBadge(scoreData) {
  const badge = document.createElement('div');
  badge.className = 'reminet-compact-badge';
  badge.setAttribute('data-reminet-badge', 'true');
  badge.setAttribute('data-reminet-compact', 'true');

  const starUrl = chrome.runtime.getURL('star.svg');
  badge.innerHTML = `
    <img src="${starUrl}" class="reminet-compact-star" alt="" />
    <span class="reminet-compact-score">${scoreData.score}</span>
  `;

  badge.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(`https://remilia.net/~${scoreData.username}`, '_blank');
  });

  return badge;
}

// Group chats only: URL pattern /i/chat/g<id>. 1-on-1 DMs are ignored.
function isInGroupChat() {
  return /^\/i\/chat\/g/.test(location.pathname);
}

// Avatar links we've already badged. WeakSet so removed nodes get GC'd.
const processedMessageAvatars = new WeakSet();

// In group chats X renders each sender's avatar as
// <a href="https://x.com/<handle>"> inside the message bubble. The avatar
// itself has overflow-hidden, so the ribbon attaches to the parent grid
// slot (style="grid-area: avatar") to escape clipping.
async function processGroupChatAvatars() {
  if (!isInGroupChat()) return;

  const messageList = document.querySelector('[data-testid="dm-message-list"]')
    || document.querySelector('[data-testid="dm-message-list-container"]');
  if (!messageList) return;

  const links = messageList.querySelectorAll('a[href]');

  for (const link of links) {
    if (processedMessageAvatars.has(link)) continue;

    const href = link.getAttribute('href') || '';
    // Match /handle, https://x.com/handle, https://twitter.com/handle.
    // Reject anything with a second path segment (status urls, etc.).
    const match = href.match(/^(?:https?:\/\/(?:twitter|x)\.com)?\/([^\/\?#]+)\/?$/);
    if (!match) continue;

    const username = match[1];
    if (!username || ROUTE_BLOCKLIST.has(username)) continue;

    // Only badge the chat sender's avatar. Embedded post cards (shared
    // tweets, link previews) also contain author avatar links but lack the
    // grid-area: avatar wrapper. Reject anything inside such embeds.
    const avatarSlot = link.closest('[style*="grid-area: avatar"]');
    if (!avatarSlot) continue;
    if (link.closest('article, [data-testid="tweet"], [data-testid="card.wrapper"]')) continue;
    if (avatarSlot.querySelector('[data-reminet-compact]')) continue;

    processedMessageAvatars.add(link);

    try {
      const scoreData = await fetchUserScore(username);
      if (!scoreData) continue;
      if (avatarSlot.querySelector('[data-reminet-compact]')) continue;

      if (getComputedStyle(avatarSlot).position === 'static') {
        avatarSlot.style.position = 'relative';
      }
      avatarSlot.style.overflow = 'visible';

      avatarSlot.appendChild(createCompactBadge(scoreData));
    } catch (error) {
      console.error('RemiStats group avatar error:', error);
    }
  }
}

// Process all visible user elements
async function processUserElements() {
  const tweets = document.querySelectorAll('[data-testid="tweet"]');
  const userCells = document.querySelectorAll('[data-testid="UserCell"]');

  const elements = [...tweets, ...userCells];

  for (const element of elements) {
    await insertBadge(element);
  }

  await insertProfileBadge();
  await processGroupChatAvatars();
}

// Observe DOM changes
const observer = new MutationObserver(
  debounce(() => {
    processUserElements();
  }, CONFIG.observerDebounce)
);

function init() {
  processUserElements();
  
  // Observe future changes
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  // Re-process when navigating (Twitter is an SPA)
  let lastUrl = location.href;
  // Watch for navigation changes by observing the title or body
  const titleElement = document.querySelector('title') || document.head;
  if (titleElement) {
    new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        // Clear processed profiles when navigating
        processedProfiles.clear();
        setTimeout(processUserElements, 500);
      }
    }).observe(titleElement, {
      subtree: true,
      characterData: true,
      childList: true
    });
  }
}

// Wait for page to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
