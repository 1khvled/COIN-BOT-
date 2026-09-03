document.getElementById("copyBtn").onclick = async () => {
  const status = document.getElementById("status");
  status.textContent = "Fetching cookies...";

  try {
    const cookies = await chrome.cookies.getAll({ domain: ".aliexpress.com" });
    if (!cookies.length) {
      status.textContent = "No cookies found for aliexpress.com";
      return;
    }

    const str = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    await navigator.clipboard.writeText(str);

    const count = cookies.length;
    status.textContent = `✅ Copied ${count} cookies (${str.length} chars)`;

    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.png",
      title: "AE Cookies Copied",
      message: `${count} cookies copied to clipboard. Paste them in the Telegram bot.`,
    });
  } catch (err) {
    status.textContent = "Error: " + err.message;
  }
};
