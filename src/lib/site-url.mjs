// src/lib/site-url.mjs
// Shared by the Astro build and by scripts/monitor.mjs, so it stays plain ESM:
// the Node scripts cannot import a .ts module without a loader, and the package
// still declares Node 22.12 as its floor.

/**
 * Decode a site URL that PT-depiler stores ROT13-encoded.
 *
 * Definitions fetched from PT-depiler carry obfuscated URLs (`uggcf://…`), so
 * every caller that shows, filters or follows one has to decode it first. The
 * two halves of the project — the site build and the monitor that probes the
 * URLs — must agree on the rule, which is why it lives here rather than in
 * either of them.
 *
 * @param {string} url URL as stored in data/site.json.
 * @returns {string} The URL to display or follow, unchanged when not encoded.
 */
export function decodeUrl(url) {
  if (!/^uggcf?:\/\//i.test(url)) return url;
  return url.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}
