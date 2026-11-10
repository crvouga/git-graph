// Apply the stored theme before first paint (external file so a strict CSP needs no inline script).
try {
  var t = localStorage.getItem("lanes.theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
