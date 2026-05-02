// Popup UI for the RemiStats extension. Audio is handled by the shared
// SoundManager exposed via `window.reminetSounds` (see sounds.js).

const sounds = window.reminetSounds;

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  document.getElementById('pingBtn').addEventListener('click', pingAPI);

  document.getElementById('showTooltips').addEventListener('change', autoSaveSettings);
  document.getElementById('soundsEnabled').addEventListener('change', (e) => {
    sounds.setEnabled(e.target.checked);
    autoSaveSettings();
  });

  for (const button of document.querySelectorAll('.button')) {
    button.addEventListener('mouseenter', () => sounds.playHover());
    button.addEventListener('click', () => sounds.playClick());
  }

  const logo = document.querySelector('.logo-container');
  if (logo) {
    logo.addEventListener('mouseenter', () => sounds.playLogoHover());
  }

  for (const toggleContainer of document.querySelectorAll('.toggle')) {
    toggleContainer.addEventListener('mouseenter', () => sounds.playHover());
    const input = toggleContainer.querySelector('input');
    if (input) {
      input.addEventListener('change', () => sounds.playClick());
    }
  }
});

function autoSaveSettings() {
  const settings = {
    showTooltips: document.getElementById('showTooltips').checked,
    soundsEnabled: document.getElementById('soundsEnabled').checked,
  };
  chrome.storage.sync.set(settings, () => {
    showStatus('Saved', 'success');
  });
}

function loadSettings() {
  chrome.storage.sync.get(['showTooltips', 'soundsEnabled'], (items) => {
    document.getElementById('showTooltips').checked = items.showTooltips !== false;
    document.getElementById('soundsEnabled').checked = items.soundsEnabled !== false;
  });
}

async function pingAPI() {
  const startTime = Date.now();
  showStatus('Pinging API...', 'success');

  try {
    const response = await fetch('https://api.remistats.net/user/coffeeweed_eth');
    const responseTime = Date.now() - startTime;

    if (!response.ok) {
      showStatus(`API Error: ${response.status}`, 'error');
      return;
    }

    const data = await response.json();
    if (data.user) {
      showStatus(`API Online (${responseTime}ms)`, 'success');
    } else {
      showStatus('API returned invalid data', 'error');
    }
  } catch (error) {
    showStatus(`API Offline: ${error.message}`, 'error');
  }
}

function showStatus(message, type = 'info') {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;

  const duration = type === 'success' ? 5000 : 3000;
  setTimeout(() => {
    statusEl.textContent = '';
    statusEl.className = 'status';
  }, duration);
}
