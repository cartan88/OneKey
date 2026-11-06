'use strict';

/**
 * Host matching for browser fills.
 *
 * The rule: an entry matches a page when their hostnames are equal, or when one
 * is a dot-boundary suffix of the other (so a `google.com` entry offers itself
 * on `accounts.google.com`). The suffix side must have at least two labels,
 * which is what stops `com` — or a lone `co.uk` — from matching everything.
 *
 * This is not a Public Suffix List implementation. It will still over-match on
 * multi-label suffixes: an entry saved for `foo.github.io` matches
 * `bar.github.io`. That errs toward offering an extra choice on a related
 * domain, never toward filling silently — every fill needs a click — so the
 * failure mode is a redundant list item, not a leaked password.
 */

/** Hostname in comparable form, or '' if the input isn't a usable http(s) URL. */
function hostOf(rawUrl) {
  if (!rawUrl) return '';
  const text = String(rawUrl).trim();
  if (!text) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch {
    return '';
  }
}

function hostsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;

  const suffixOf = (short, long) =>
    short.split('.').length >= 2 && long.endsWith(`.${short}`);

  return suffixOf(a, b) || suffixOf(b, a);
}

/** True if `entryUrl` should be offered on the page at `pageUrl`. */
function entryMatchesUrl(entryUrl, pageUrl) {
  return hostsMatch(hostOf(entryUrl), hostOf(pageUrl));
}

/** A sensible entry name for a login captured from the browser. */
function nameFromUrl(rawUrl) {
  const host = hostOf(rawUrl);
  if (!host) return 'Untitled';
  const labels = host.split('.');
  // Drop the TLD and capitalise: "accounts.google.com" -> "Google".
  const core = labels.length > 1 ? labels[labels.length - 2] : labels[0];
  return core.charAt(0).toUpperCase() + core.slice(1);
}

module.exports = { hostOf, hostsMatch, entryMatchesUrl, nameFromUrl };
