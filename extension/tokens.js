// Shows the result once, then forgets it: the tokens live only in this tab.
const show = (id) => {
  for (const s of ["busy", "ok", "fail", "none"]) document.getElementById(s).hidden = s !== id;
};

function render(result) {
  if (result?.busy) return show("busy");
  if (result?.access) {
    document.getElementById("access").value = result.access;
    document.getElementById("refresh").value = result.refresh;
    show("ok");
  } else if (result?.error) {
    document.getElementById("title").textContent = "Sign-in didn't finish";
    document.getElementById("message").textContent = result.error;
    show("fail");
  } else {
    return show("none");
  }
  chrome.storage.session.remove("result");
}

chrome.storage.session.get("result").then(({ result }) => render(result));
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.result?.newValue) render(changes.result.newValue);
});

for (const btn of document.querySelectorAll("[data-copy]")) {
  btn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(document.getElementById(btn.dataset.copy).value);
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });
}

for (const id of ["retry", "again"]) {
  document.getElementById(id).addEventListener("click", () => chrome.runtime.sendMessage({ type: "start" }));
}
