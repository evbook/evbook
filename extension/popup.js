document.getElementById("start").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "start" });
  window.close();
});
