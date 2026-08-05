// Deployment seam. The Pages workflow overwrites this file with the public
// signaling URL at publish time.
//
// Empty in the repo on purpose: a local checkout then falls through to the
// 127.0.0.1:8000 default in index.html, so `make up-native`, run-local.sh and
// the Playwright suite keep working with no signaling parameter in the URL.
window.SS_SIGNALING = "";
