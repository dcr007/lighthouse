/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * URL shim so we keep our code DRY
 */

/* global self */

const Util = require('../report/html/renderer/util.js');

// Type cast so tsc sees window.URL and require('url').URL as sufficiently equivalent.
const URL = /** @type {!Window["URL"]} */ (typeof self !== 'undefined' && self.URL) ||
    require('url').URL;

const tldPlusOne = {
  ar: ['com', 'edu', 'gob', 'int', 'mil', 'mar', 'net', 'org', 'tur', 'musica'],
  at: ['co', 'or', 'priv', 'ac'],
  fr: ['avocat', 'aeroport', 'veterinaire'],
  nz: ['ac', 'co', 'school', 'cri', 'govt', 'mil', 'parliament'],
  il: ['org', 'k12', 'gov', 'muni', 'idf'],
  ru: ['com', 'edu', 'gob', 'int', 'mil', 'mar', 'net', 'org', 'tur', 'musica'],
  za: ['ac', 'gov', 'law', 'mil', 'nom', 'school', 'net'],
  kr: ['ac', 'co', 'es', 'go', 'hs', 'kg', 'mil', 'ms', 'ne', 'or', 'pe', 're', 'sc', 'busan',
    'chungbuk', 'chungnam', 'daegu', 'daejeon', 'gangwon', 'gwangju', 'gyeongbuk', 'gyeonggi',
    'gyeongnam', 'incheon', 'jeju', 'jeonbuk', 'jeonnam', 'seoul', 'ulsan'],
  es: ['org', 'gob'],
  tr: ['com', 'info', 'biz', 'net', 'org', 'web', 'gen', 'tv', 'av', 'dr', 'bbs', 'name', 'tel',
    'gov', 'bel', 'pol', 'mil', 'k12', 'edu', 'kep', 'nc', 'gov.nc'],
  ua: ['gov', 'com', 'in', 'org', 'net', 'edu'],
  uk: ['co', 'org', 'me', 'ltd', 'plc', 'net', 'sch', 'ac', 'gov', 'mod', 'mil', 'nhs', 'police'],
};

/**
 * There is fancy URL rewriting logic for the chrome://settings page that we need to work around.
 * Why? Special handling was added by Chrome team to allow a pushState transition between chrome:// pages.
 * As a result, the network URL (chrome://chrome/settings/) doesn't match the final document URL (chrome://settings/).
 * @param {string} url
 * @return {string}
 */
function rewriteChromeInternalUrl(url) {
  if (!url || !url.startsWith('chrome://')) return url;
  // Chrome adds a trailing slash to `chrome://` URLs, but the spec does not.
  //   https://github.com/GoogleChrome/lighthouse/pull/3941#discussion_r154026009
  if (url.endsWith('/')) url = url.replace(/\/$/, '');
  return url.replace(/^chrome:\/\/chrome\//, 'chrome://');
}

/**
 * Checks if an url contains a TLD plus one domain
 *
 * @param {string} url
 * @return {boolean}
 */
function isTldPlusDomain(url) {
  try {
    const parsedUrl = new URL(url);
    if (!parsedUrl.hostname) {
      return false;
    }

    const tld = parsedUrl.hostname.split('.').slice(-1)[0];
    if (!tldPlusOne[tld]) {
      return false;
    }

    const tldPlusOneRegex = new RegExp(`\\.(${tldPlusOne[tld].join('|')})\\.${tld}`);
    return tldPlusOneRegex.test(url);
  } catch (err) {
    return false;
  }
}

class URLShim extends URL {
  /**
   * @param {string} url
   * @return {boolean}
   */
  static isValid(url) {
    try {
      new URL(url);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {string} urlA
   * @param {string} urlB
   * @return {boolean}
   */
  static hostsMatch(urlA, urlB) {
    try {
      return new URL(urlA).host === new URL(urlB).host;
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {string} urlA
   * @param {string} urlB
   * @return {boolean}
   */
  static originsMatch(urlA, urlB) {
    try {
      return new URL(urlA).origin === new URL(urlB).origin;
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {string} url
   * @return {?string}
   */
  static getOrigin(url) {
    try {
      const urlInfo = new URL(url);
      // check for both host and origin since some URLs schemes like data and file set origin to the
      // string "null" instead of the object
      return (urlInfo.host && urlInfo.origin) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Check if rootDomains matches
   *
   * @param {string} urlA
   * @param {string} urlB
   */
  static rootDomainsMatch(urlA, urlB) {
    let urlAInfo;
    let urlBInfo;
    try {
      urlAInfo = new URL(urlA);
      urlBInfo = new URL(urlB);
    } catch (err) {
      return false;
    }

    if (!urlAInfo.hostname || !urlBInfo.hostname) {
      return false;
    }

    const isTldPlusOneA = isTldPlusDomain(urlA);
    const isTldPlusOneB = isTldPlusDomain(urlB);

    const urlARootDomain = urlAInfo.hostname.split('.').slice(isTldPlusOneA ? -3 : -2).join('.');
    const urlBRootDomain = urlBInfo.hostname.split('.').slice(isTldPlusOneB ? -3 : -2).join('.');

    return urlARootDomain === urlBRootDomain;
  }

  /**
   * @param {string} url
   * @param {{numPathParts: number, preserveQuery: boolean, preserveHost: boolean}=} options
   * @return {string}
   */
  static getURLDisplayName(url, options) {
    return Util.getURLDisplayName(new URL(url), options);
  }

  /**
   * Limits data URIs to 100 characters, returns all other strings untouched.
   * @param {string} url
   * @return {string}
   */
  static elideDataURI(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'data:' ? url.slice(0, 100) : url;
    } catch (e) {
      return url;
    }
  }

  /**
   * Determine if url1 equals url2, ignoring URL fragments.
   * @param {string} url1
   * @param {string} url2
   * @return {boolean}
   */
  static equalWithExcludedFragments(url1, url2) {
    [url1, url2] = [url1, url2].map(rewriteChromeInternalUrl);
    try {
      const urla = new URL(url1);
      urla.hash = '';

      const urlb = new URL(url2);
      urlb.hash = '';

      return urla.href === urlb.href;
    } catch (e) {
      return false;
    }
  }
}

URLShim.URLSearchParams = (typeof self !== 'undefined' && self.URLSearchParams) ||
    require('url').URLSearchParams;

URLShim.INVALID_URL_DEBUG_STRING =
    'Lighthouse was unable to determine the URL of some script executions. ' +
    'It\'s possible a Chrome extension or other eval\'d code is the source.';

module.exports = URLShim;
