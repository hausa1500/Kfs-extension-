import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../content/chatgpt.js", import.meta.url), "utf8");
const users = [];
const assistants = [];
const statusMessages = [];
let generating = false;
let nextAssistantText = "";
let listener;

const visibleElement = {
  isConnected: true,
  disabled: false,
  getAttribute: () => null,
  getBoundingClientRect: () => ({ width: 320, height: 42, bottom: 500 }),
};

class MockTextArea {
  constructor() {
    this.value = "";
    this.isConnected = true;
    this.parentElement = null;
  }

  focus() {}
  dispatchEvent() {}
  closest(selector) {
    return selector === "form" ? form : null;
  }

  getBoundingClientRect() {
    return visibleElement.getBoundingClientRect();
  }
}

const composer = new MockTextArea();
const form = {
  querySelectorAll: (selector) => selector.includes("send-button") ? [sendButton] : [],
};
const makeMessage = (text) => ({
  ...visibleElement,
  innerText: text,
  textContent: text,
  querySelector: () => null,
});
const stopButton = { ...visibleElement };
const sendButton = {
  ...visibleElement,
  click() {
    composer.value = "";
    users.push(makeMessage("submitted"));
    assistants.push(makeMessage(nextAssistantText));
    generating = true;
  },
};

const document = {
  querySelectorAll(selector) {
    if (selector === "#prompt-textarea") return [composer];
    if (selector === '[data-message-author-role="user"]') return users;
    if (selector === '[data-message-author-role="assistant"]') return assistants;
    if (selector.includes("stop-button") || selector.includes("Stop") || selector.includes("Parar")) {
      return generating ? [stopButton] : [];
    }
    return [];
  },
};

const chrome = {
  runtime: {
    onMessage: { addListener: (callback) => { listener = callback; } },
    sendMessage: async (message) => {
      statusMessages.push(message);
      return { ok: true };
    },
  },
};

vm.runInNewContext(source, {
  window: {},
  document,
  chrome,
  HTMLTextAreaElement: MockTextArea,
  HTMLInputElement: class {},
  InputEvent: class {},
  Event: class {},
  KeyboardEvent: class {},
  getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  setTimeout,
  setInterval,
  clearInterval,
});

assert.equal(typeof listener, "function", "ChatGPT bridge listener should register");

const dispatch = (prompt) => new Promise((resolve) => {
  listener({ type: "KFS_SUBMIT_TO_CHATGPT", prompt }, {}, resolve);
});
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitForSubmission(prompt, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const response = await dispatch(prompt);
    if (response?.ok) return response;
    await delay(100);
  }
  throw new Error(`ChatGPT bridge did not accept ${prompt} after the previous task ended`);
}
async function waitForStatusCount(count, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (statusMessages.filter(({ marker }) => marker === "KFS_DONE").length >= count) return;
    await delay(50);
  }
  throw new Error(`Expected ${count} terminal status messages`);
}

nextAssistantText = "First response without a KFS terminal marker";
const firstStarted = Date.now();
const first = await Promise.race([
  dispatch("prompt one"),
  delay(2000).then(() => { throw new Error("Initial handoff waited for task completion"); }),
]);
assert.equal(first?.ok, true, `first prompt should be handed off: ${first?.error || "no response"}`);
assert.equal(generating, true, "handoff should return while ChatGPT is still working");
assert.ok(Date.now() - firstStarted < 2000, "handoff should not wait for the assistant response");

const concurrent = await dispatch("overlapping prompt");
assert.equal(concurrent?.ok, false, "a genuinely active task must remain protected");
assert.match(concurrent?.error || "", /ocupado/i);

generating = false;
const settledAt = Date.now();
nextAssistantText = "Second response with a terminal marker";
await waitForSubmission("prompt two");
assert.ok(Date.now() - settledAt >= 2000, "marker-free response must settle before releasing the guard");
assert.equal(generating, true, "second prompt should begin after marker-free completion");

const overlappingSecond = await dispatch("overlapping prompt two");
assert.equal(overlappingSecond?.ok, false, "second active task must remain protected");
assert.match(overlappingSecond?.error || "", /ocupado/i);

assistants.at(-1).innerText = "[KFS_DONE] second task complete";
assistants.at(-1).textContent = "[KFS_DONE] second task complete";
generating = false;
nextAssistantText = "Third response with a terminal marker";
await waitForSubmission("prompt three");
assert.equal(generating, true, "third prompt should proceed after explicit completion");

assistants.at(-1).innerText = "[KFS_DONE] third task complete";
assistants.at(-1).textContent = "[KFS_DONE] third task complete";
generating = false;
await waitForStatusCount(2);

console.log("ChatGPT lifecycle regression verification OK");