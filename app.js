(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const customerCode = params.get("uid") || "";
  const phone = params.get("phone") || "";
  const adminMode = params.get("admin") === "true" || params.get("mode") === "dev";
  const storageKey = token ? `survey_completed_${token}` : "";

  const screens = {
    blocked: document.getElementById("blocked-screen"),
    success: document.getElementById("success-screen"),
    form: document.getElementById("form-screen"),
  };

  function showScreen(name) {
    Object.values(screens).forEach((el) => el.classList.add("hidden"));
    screens[name].classList.remove("hidden");
  }

  function showBlocked(message) {
    document.getElementById("blocked-message").textContent = message;
    showScreen("blocked");
  }

  if (storageKey && window.localStorage.getItem(storageKey) === "true") {
    showScreen("success");
    return;
  }

  showScreen("form");

  let rating = null;
  let saving = false;

  const satisfiedButton = document.getElementById("rating-satisfied");
  const unsatisfiedButton = document.getElementById("rating-unsatisfied");
  const commentInput = document.getElementById("survey-comment");
  const characterCount = document.getElementById("character-count");
  const submitButton = document.getElementById("submit-button");
  const attemptedError = document.getElementById("attempted-error");
  const submitError = document.getElementById("submit-error");

  function choose(next) {
    rating = next;
    attemptedError.classList.add("hidden");
    satisfiedButton.classList.toggle("selected", rating === "satisfied");
    satisfiedButton.setAttribute("aria-pressed", String(rating === "satisfied"));
    unsatisfiedButton.classList.toggle("selected", rating === "unsatisfied");
    unsatisfiedButton.setAttribute("aria-pressed", String(rating === "unsatisfied"));
  }

  satisfiedButton.addEventListener("click", () => choose("satisfied"));
  unsatisfiedButton.addEventListener("click", () => choose("unsatisfied"));

  commentInput.addEventListener("input", () => {
    characterCount.textContent = `${commentInput.value.length}/300`;
  });

  function setSaving(next) {
    saving = next;
    submitButton.disabled = saving;
    submitButton.textContent = saving ? "送出中..." : "確認送出";
  }

  submitButton.addEventListener("click", async () => {
    if (!rating) {
      attemptedError.classList.remove("hidden");
      return;
    }

    const apiUrl = window.SURVEY_API_URL;
    if (!apiUrl || apiUrl.indexOf("PASTE_YOUR") === 0) {
      submitError.textContent = "尚未設定後端網址，請先在 config.js 填入 Apps Script 網址";
      submitError.classList.remove("hidden");
      return;
    }

    setSaving(true);
    submitError.classList.add("hidden");
    submitError.textContent = "";

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        // 用 text/plain 避免瀏覽器對 Apps Script 觸發 CORS 預檢請求（preflight）
        headers: { "content-type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "submitSurvey",
          rating,
          comment: commentInput.value,
          token,
          customerCode,
          phone,
        }),
      });

      const result = await response.json().catch(() => null);
      if (!result || result.error) {
        throw new Error((result && result.error) || "送出失敗");
      }

      if (storageKey) window.localStorage.setItem(storageKey, "true");
      showScreen("success");
    } catch (error) {
      submitError.textContent = error instanceof Error ? error.message : "目前無法送出，請稍後再試";
      submitError.classList.remove("hidden");
    } finally {
      setSaving(false);
    }
  });
})();
