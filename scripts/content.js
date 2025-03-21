// content.js
const DEBOUNCE_TIME = 350;
let currentGhost = null;
let activeElement = null;
let controller = null;

console.log('Content script loaded!');

function debounce(func, timeout = DEBOUNCE_TIME) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => func.apply(this, args), timeout);
  };
}

async function getStorage(key) {
  console.log('Getting storage for key:', key);
  try {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.get([key], result => {
        console.log('Storage result:', result);
        if (chrome.runtime.lastError) {
          console.error('Storage error:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
        } else {
          resolve(result[key]);
        }
      });
    });
  } catch (error) {
    console.error('Error getting storage:', error);
    return null;
  }
}

function watchTextFields() {
  console.log('Starting to watch text fields');
  try {
    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            handleNewElements(node);
            traverseShadowDOM(node);
          }
        });
      });
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['contenteditable', 'role', 'type']
    });

    // Initial setup
    handleNewElements(document.body);
    traverseShadowDOM(document.body);
  } catch (error) {
    console.error('Error in watchTextFields:', error);
  }
}

function traverseShadowDOM(node) {
  if (node.shadowRoot) {
    handleNewElements(node.shadowRoot);
    node.shadowRoot.querySelectorAll('*').forEach(child => {
      if (child.shadowRoot) traverseShadowDOM(child);
    });
  }
}

function handleNewElements(root) {
  const textInputs = [
    'textarea',
    'input[type="text"]',
    'input[type="search"]',
    '[contenteditable="true"]',
    '[role="textbox"]'
  ].join(',');

  const elements = Array.from(root.querySelectorAll(textInputs))
    .filter(el => {
      if (el.tagName === 'INPUT' && !['text', 'search'].includes(el.type)) return false;
      return !el.dataset.autotabHandled;
    });

  elements.forEach(element => {
    element.dataset.autotabHandled = "true";
    attachAIHandler(element);
    if (element.shadowRoot) traverseShadowDOM(element);
  });
}

function attachAIHandler(element) {
  console.log('Attaching AI handler to element:', element);
  const handleInput = debounce(async () => {
    if (!element.isConnected) return;
    activeElement = element;
    
    const context = getTextContext(element);
    if (!context || context.text.length < 3) {
      clearGhostText();
      return;
    }

    try {
      controller?.abort();
      controller = new AbortController();
      
      console.log('Sending message to background script with text:', context.text);
      const apiKey = await getStorage('apiKey');
      console.log('Got API key:', apiKey ? 'Present' : 'Missing');
      
      if (!apiKey) {
        console.error('No API key found. Please set your API key in the extension popup.');
        return;
      }

      console.log('Sending message to background script...');
      const suggestion = await chrome.runtime.sendMessage({
        type: 'fetchCompletion',
        text: context.text,
        apiKey: apiKey
      });

      console.log('Received suggestion:', suggestion);
      if (suggestion?.trim()) {
        showGhostText(element, suggestion, context.absolutePos);
      } else {
        clearGhostText();
      }
    } catch (error) {
      console.error('Error in handleInput:', error);
      if (error.name !== 'AbortError') {
        console.error('API error:', error);
      }
      clearGhostText();
    }
  });

  const events = ['input', 'keyup', 'click', 'focus'];
  events.forEach(event => {
    element.addEventListener(event, (e) => {
      console.log(`Event ${event} triggered on element`);
      handleInput(e);
    });
  });
  
  element.addEventListener('keydown', handleKeyDown);
  element.addEventListener('blur', clearGhostText);
  element.addEventListener('scroll', clearGhostText);
}

function getTextContext(element) {
  let text, cursorPos;
  if (element.isContentEditable) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const parent = range.commonAncestorContainer.parentElement;
    text = parent.textContent || '';
    cursorPos = range.startOffset;
  } else {
    text = element.value;
    cursorPos = element.selectionStart;
  }

  const start = Math.max(0, cursorPos - 40);
  const end = Math.min(text.length, cursorPos + 20);
  return {
    text: text.slice(start, end),
    absolutePos: cursorPos
  };
}

function showGhostText(element, suggestion, cursorPos) {
  clearGhostText();
  
  const ghost = document.createElement('div');
  ghost.className = 'autotab-ghost';
  ghost.textContent = suggestion;
  
  document.body.appendChild(ghost);
  positionGhost(element, ghost, cursorPos);
  currentGhost = ghost;
}

function positionGhost(element, ghost, cursorPos) {
  const elementRect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  
  if (element.isContentEditable) {
    const range = document.createRange();
    const sel = window.getSelection();
    range.setStart(sel.anchorNode, sel.anchorOffset);
    const rect = range.getBoundingClientRect();
    
    ghost.style.left = `${rect.right + window.scrollX + 2}px`;
    ghost.style.top = `${rect.top + window.scrollY}px`;
  } else {
    const fontSize = parseInt(style.fontSize) || 16;
    const charWidth = fontSize * 0.6;
    const scrollLeft = element.scrollLeft || 0;
    
    ghost.style.left = `${elementRect.left + (cursorPos * charWidth) - scrollLeft + 2}px`;
    ghost.style.top = `${elementRect.top + window.scrollY}px`;
  }

  ghost.style.position = 'absolute';
  ghost.style.zIndex = '2147483647';
}

function clearGhostText() {
  if (currentGhost) {
    currentGhost.remove();
    currentGhost = null;
  }
}

function handleKeyDown(event) {
  if (event.key === 'Tab' && currentGhost) {
    event.preventDefault();
    insertSuggestion(activeElement, currentGhost.textContent);
    clearGhostText();
  }
}

function insertSuggestion(element, text) {
  if (!element || !text) return;

  if (element.isContentEditable) {
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
    }
  } else {
    const start = element.selectionStart;
    element.setRangeText(
      text,
      start,
      start,
      'end'
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Initialize
console.log('Initializing content script');
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Content Loaded, starting to watch text fields');
    watchTextFields();
  });
} else {
  console.log('DOM already loaded, starting to watch text fields');
  watchTextFields();
}
document.addEventListener('visibilitychange', clearGhostText);