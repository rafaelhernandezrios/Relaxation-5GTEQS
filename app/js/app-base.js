(function () {
  const u = new URL(window.location.href);
  const proto = u.protocol === "https:" ? "https:" : "http:";
  const host = u.hostname || "localhost";
  const port = u.port || (proto === "https:" ? "443" : "80");
  const base =
    proto + "//" + host + (u.port ? ":" + u.port : "");
  window.APP_BASE_URL = base;

  window.assetUrl = function assetUrl(rel) {
    if (!rel) return base + "/";
    if (/^https?:\/\//i.test(rel)) return rel;
    const path = rel.replace(/^\//, "");
    return base + "/" + path;
  };

  window.wsRecorderUrl = function wsRecorderUrl() {
    const wsProto = proto === "https:" ? "wss:" : "ws:";
    return wsProto + "//" + host + ":8765";
  };
})();
