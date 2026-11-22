const sidebar = document.getElementById("sidebar");
const toggleSidebarBtn = document.getElementById("toggle-sidebar-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const sessionList = document.getElementById("session-list");
const sessionBadge = document.getElementById("session-badge");
const chatFeed = document.getElementById("chat-feed");
const emptyState = document.getElementById("empty-state");
const chatForm = document.getElementById("chat-form");
const promptInput = document.getElementById("prompt-input");
const sendBtn = document.getElementById("send-btn");

let currentSessionId = crypto.randomUUID();
let isStreaming = false;

function updateSessionBadge() {
  sessionBadge.textContent = `Session: ${currentSessionId.slice(0, 8)}`;
}

function renderMarkdown(md) {
  const rawHtml = marked.parse(md || "");
  return DOMPurify.sanitize(rawHtml);
}

function appendMessage(role, content) {
  if (emptyState) emptyState.style.display = "none";
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "user") {
    div.textContent = content;
  } else {
    div.innerHTML = renderMarkdown(content);
  }
  chatFeed.appendChild(div);
  chatFeed.scrollTop = chatFeed.scrollHeight;
  return div;
}

async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    const { sessions } = await res.json();
    sessionList.innerHTML = "";

    for (const s of sessions) {
      const btn = document.createElement("button");
      btn.className = `session-item ${s.session_id === currentSessionId ? "active" : ""}`;
      btn.textContent = s.title || "Untitled Chat";
      btn.title = s.title || s.session_id;
      btn.onclick = () => switchSession(s.session_id);
      sessionList.appendChild(btn);
    }
  } catch (err) {
    console.error("Failed to load sessions:", err);
  }
}

async function switchSession(sessionId) {
  if (isStreaming) return;
  currentSessionId = sessionId;
  updateSessionBadge();
  chatFeed.innerHTML = "";

  const res = await fetch(`/api/sessions/${sessionId}`);
  const { turns } = await res.json();

  if (!turns || turns.length === 0) {
    chatFeed.appendChild(emptyState);
    emptyState.style.display = "block";
  } else {
    for (const t of turns) {
      appendMessage("user", t.user_message);
      appendMessage("assistant", t.assistant_response);
    }
  }
  await loadSessions();
}

function startNewChat() {
  if (isStreaming) return;
  currentSessionId = crypto.randomUUID();
  updateSessionBadge();
  chatFeed.innerHTML = "";
  chatFeed.appendChild(emptyState);
  emptyState.style.display = "block";
  promptInput.focus();
  loadSessions();
}

toggleSidebarBtn.addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
});

newChatBtn.addEventListener("click", startNewChat);

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = promptInput.value.trim();
  if (!message || isStreaming) return;

  isStreaming = true;
  sendBtn.disabled = true;
  promptInput.value = "";

  appendMessage("user", message);

  const assistantDiv = appendMessage("assistant", "");
  const statusEl = document.createElement("div");
  statusEl.className = "status-pill";
  statusEl.style.display = "none";

  const bodyEl = document.createElement("div");
  assistantDiv.appendChild(statusEl);
  assistantDiv.appendChild(bodyEl);

  let accumulatedText = "";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId, message }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const rawEvent of events) {
        const lines = rawEvent.split("\n");
        let eventName = "message";
        let dataStr = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) eventName = line.slice(7).trim();
          if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
        }
        if (!dataStr) continue;

        const payload = JSON.parse(dataStr);
        if (eventName === "status") {
          statusEl.textContent = payload.status;
          statusEl.style.display = "inline-block";
        } else if (eventName === "token") {
          statusEl.style.display = "none";
          accumulatedText += payload.token;
          bodyEl.innerHTML = renderMarkdown(accumulatedText);
          chatFeed.scrollTop = chatFeed.scrollHeight;
        } else if (eventName === "error") {
          bodyEl.innerHTML = renderMarkdown(`**Error:** ${payload.message}`);
        }
      }
    }
  } catch (err) {
    bodyEl.innerHTML = renderMarkdown(`**Network error:** ${err.message}`);
  } finally {
    isStreaming = false;
    sendBtn.disabled = false;
    promptInput.focus();
    // Refresh sidebar after background indexing completes
    setTimeout(loadSessions, 1200);
  }
});

updateSessionBadge();
loadSessions();