const MINIGET = require('miniget');

const BASE_URL = 'https://www.youtube.com/';
const DEFAULT_OPTIONS = { limit: 100, safeSearch: false };
const DEFAULT_QUERY = { gl: 'US', hl: 'en' };
const DEFAULT_CONTEXT = {
  client: {
    utcOffsetMinutes: 0,
    gl: 'US',
    hl: 'en',
    clientName: 'WEB',
    clientVersion: '<important information>',
  },
  user: {},
  request: {},
};

/**
 * Parse filter groups from the provided JSON data.
 * @param {Object} json The JSON data.
 * @returns {Map} The parsed filter groups.
 */
exports.parseFilters = json => {
  const primaryContents = json.contents.twoColumnSearchResultsRenderer.primaryContents;
  const wrapper = primaryContents.sectionListRenderer || primaryContents.richGridRenderer;
  let filterWrapper = (wrapper.subMenu || wrapper.submenu).searchSubMenuRenderer.groups;

  if (filterWrapper === undefined) {
    const popup = json.header.searchHeaderRenderer.searchFilterButton.buttonRenderer.command.openPopupAction.popup;
    filterWrapper = popup.searchFilterOptionsDialogRenderer.groups || [];
  }

  const parsedGroups = new Map();

  filterWrapper.forEach(filterGroup => {
    const singleFilterGroup = new Map();
    singleFilterGroup.active = null;

    filterGroup.searchFilterGroupRenderer.filters.forEach(filter => {
      const isSet = !filter.searchFilterRenderer.navigationEndpoint;
      const parsedFilter = {
        name: parseText(filter.searchFilterRenderer.label, ''),
        active: isSet,
        url: isSet ? null : new URL(
          filter.searchFilterRenderer.navigationEndpoint.commandMetadata.webCommandMetadata.url, BASE_URL).toString(),
        description: filter.searchFilterRenderer.tooltip,
      };

      if (isSet) singleFilterGroup.active = parsedFilter;
      singleFilterGroup.set(parsedFilter.name, parsedFilter);
    });

    parsedGroups.set(parseText(filterGroup.searchFilterGroupRenderer.title, 'Unknown Category'), singleFilterGroup);
  });

  return parsedGroups;
};

/**
 * Parse body content and extract relevant data like json, apiKey, and context.
 * @param {string} body The body content.
 * @param {Object} [options={}] Optional settings.
 * @returns {Object} Extracted data from the body.
 */
exports.parseBody = (body, options = {}) => {
  let json = null;
  try {
    json = jsonAfter(body, 'var ytInitialData = ');
  } catch (e) {
    /* Ignore and let json be null */
  }

  // Extract apiKey and clientVersion from body
  const apiKey = between(body, 'INNERTUBE_API_KEY":"', '"') || between(body, 'innertubeApiKey":"', '"');
  const clientVersion = between(body, 'INNERTUBE_CONTEXT_CLIENT_VERSION":"', '"') ||
    between(body, 'innertube_context_client_version":"', '"');

  // Create a deep copy of DEFAULT_CONTEXT and update clientVersion
  const context = JSON.parse(JSON.stringify(DEFAULT_CONTEXT));
  context.client.clientVersion = clientVersion;

  // Update context based on provided options
  ['gl', 'hl', 'utcOffsetMinutes'].forEach(key => {
    if (options[key]) context.client[key] = options[key];
  });

  if (options.safeSearch) context.user.enableSafetyMode = true;

  return { json, apiKey, context };
};

// Utility functions:

/**
 * Parse text from the provided content. Return the default value if unable to parse.
 * @param {Object|string} txt Content to parse.
 * @param {string|null} [def=null] Default value.
 * @returns {string|null} Parsed text or default value.
 */
const parseText = exports.parseText = (txt, def = null) => {
  if (typeof txt !== 'object') return def;

  if (txt.simpleText) return txt.simpleText;

  if (Array.isArray(txt.runs)) return txt.runs.map(a => a.text).join('');

  return def;
};

/**
 * Extract the number from the given text.
 * @param {Object|string} txt Text containing a number.
 * @returns {number} Extracted number.
 */
exports.parseIntegerFromText = txt => Number(parseText(txt).replace(/\D+/g, ''));

/**
 * Execute a POST request.
 * @param {string} url URL to post to.
 * @param {Object} payload Payload data.
 * @param {Object} [reqOpts={}] Request options.
 * @returns {Promise<Object>} Parsed JSON response.
 */
exports.doPost = async(url, payload, reqOpts = {}) => {
  reqOpts.method = 'POST';
  const req = MINIGET(url, reqOpts);

  if (payload) req.once('request', r => r.write(JSON.stringify(payload)));

  return JSON.parse(await req.text());
};

/**
 * Validate and normalize arguments.
 * @param {string} searchString The search query or URL.
 * @param {Object} [options={}] Optional settings.
 * @returns {Object} Normalized arguments.
 * @throws {Error} On invalid search string.
 */
exports.checkArgs = (searchString, options = {}) => {
  // Validation
  if (!searchString) {
    throw new Error('search string is mandatory');
  }
  if (typeof searchString !== 'string') {
    throw new Error('search string must be of type string');
  }

  // Normalisation
  let obj = Object.assign({}, DEFAULT_OPTIONS, options);
  // Other optional params
  if (!isNaN(obj.pages) && obj.pages > 0) {
    // Disable limit if pages is provided
    obj.limit = Infinity;
  } else if (isNaN(obj.limit) || obj.limit <= 0) {
    // Default limit
    obj.pages = Infinity;
    obj.limit = DEFAULT_OPTIONS.limit;
  }
  if (typeof obj.safeSearch !== 'boolean') obj.safeSearch = DEFAULT_OPTIONS.safeSearch;
  // Default requestOptions
  obj.requestOptions = Object.assign({}, options.requestOptions);
  // Unlink requestOptions#headers
  if (obj.requestOptions.headers) {
    obj.requestOptions.headers = JSON.parse(JSON.stringify(obj.requestOptions.headers));
  }
  // Setting cookie in request headers to get safe search results
  if (obj.safeSearch) {
    if (!obj.requestOptions.headers) obj.requestOptions.headers = {};
    if (!obj.requestOptions.headers.Cookie) obj.requestOptions.headers.Cookie = [];
    obj.requestOptions.headers.Cookie.push('PREF=f2=8000000');
  }
  // Set required parameter: query
  const inputURL = new URL(searchString, BASE_URL);
  if (searchString.startsWith(BASE_URL) && inputURL.pathname === '/results' && inputURL.searchParams.has('sp')) {
    // Watch out for requests with a set filter
    // in such a case searchString would be an url including `sp` & `search_query` querys
    if (!inputURL.searchParams.get('search_query')) {
      throw new Error('filter links have to include a "search_string" query');
    }
    // Object.fromEntries not supported in nodejs < v12
    obj.query = {};
    for (const key of inputURL.searchParams.keys()) {
      obj.query[key] = inputURL.searchParams.get(key);
    }
  } else {
    // If no filter-link default to passing it all as query
    obj.query = { search_query: searchString };
  }
  // Save the search term itself for potential later use
  obj.search = obj.query.search_query;

  // Add additional information
  obj.query = Object.assign({}, DEFAULT_QUERY, obj.query);
  if (options && options.gl) obj.query.gl = options.gl;
  if (options && options.hl) obj.query.hl = options.hl;
  return obj;
};

// Sorts Images in descending order & normalizes the url's
exports.prepImg = img => {
  // Resolve url
  img.forEach(x => x.url = x.url ? new URL(x.url, BASE_URL).toString() : null);
  // Sort
  return img.sort((a, b) => b.width - a.width);
};

exports.parseWrapper = primaryContents => {
  let rawItems = [];
  let continuation = null;

  // Older Format
  if (primaryContents.sectionListRenderer) {
    rawItems = primaryContents.sectionListRenderer.contents
      .find(x => Object.keys(x)[0] === 'itemSectionRenderer')
      .itemSectionRenderer.contents;
    continuation = primaryContents.sectionListRenderer.contents
      .find(x => Object.keys(x)[0] === 'continuationItemRenderer');
    // Newer Format
  } else if (primaryContents.richGridRenderer) {
    rawItems = primaryContents.richGridRenderer.contents
      .filter(x => !Object.prototype.hasOwnProperty.call(x, 'continuationItemRenderer'))
      .map(x => (x.richItemRenderer || x.richSectionRenderer).content);
    continuation = primaryContents.richGridRenderer.contents
      .find(x => Object.prototype.hasOwnProperty.call(x, 'continuationItemRenderer'));
  }

  return { rawItems, continuation };
};

exports.parsePage2Wrapper = continuationItems => {
  let rawItems = [];
  let continuation = null;

  for (const ci of continuationItems) {
    // Older Format
    if (Object.prototype.hasOwnProperty.call(ci, 'itemSectionRenderer')) {
      rawItems.push(...ci.itemSectionRenderer.contents);
      // Newer Format
    } else if (Object.prototype.hasOwnProperty.call(ci, 'richItemRenderer')) {
      rawItems.push(ci.richItemRenderer.content);
    } else if (Object.prototype.hasOwnProperty.call(ci, 'richSectionRenderer')) {
      rawItems.push(ci.richSectionRenderer.content);
      // Continuation
    } else if (Object.prototype.hasOwnProperty.call(ci, 'continuationItemRenderer')) {
      continuation = ci;
    }
  }

  return { rawItems, continuation };
};

/**
 * Extract JSON data that appears after a given string within a larger string.
 * @param {string} haystack The large string.
 * @param {string} left The string to search for.
 * @returns {Object|null} Extracted JSON data or null.
 */
const jsonAfter = (haystack, left) => {
  const pos = haystack.indexOf(left);
  if (pos === -1) return null;

  haystack = haystack.slice(pos + left.length);
  try {
    return JSON.parse(cutAfterJSON(haystack));
  } catch (e) {
    return null;
  }
};

/**
 * Extract a substring that is between two other substrings.
 * @param {string} haystack The larger string.
 * @param {string} left The left boundary.
 * @param {string} right The right boundary.
 * @returns {string} Extracted substring.
 */
const between = (haystack, left, right) => {
  let start = haystack.indexOf(left);
  if (start === -1) return '';

  start += left.length;
  haystack = haystack.slice(start);

  const end = haystack.indexOf(right);
  if (end === -1) return '';

  return haystack.slice(0, end);
};

/**
 * Match begin and end braces of input JSON, return only json
 * Property of https://github.com/fent/node-ytdl-core/blob/master/lib/utils.js
 *
 * @param {string} mixedJson
 * @returns {string}
 * @throws {Error} no json or invalid json
 */
const cutAfterJSON = exports.cutAfterJSON = mixedJson => {
  let open, close;
  if (mixedJson[0] === '[') {
    open = '[';
    close = ']';
  } else if (mixedJson[0] === '{') {
    open = '{';
    close = '}';
  }

  if (!open) {
    throw new Error(`Can't cut unsupported JSON (need to begin with [ or { ) but got: ${mixedJson[0]}`);
  }

  // States if the loop is currently in a string
  let isString = false;

  // States if the current character is treated as escaped or not
  let isEscaped = false;

  // Current open brackets to be closed
  let counter = 0;

  let i;
  for (i = 0; i < mixedJson.length; i++) {
    // Toggle the isString boolean when leaving/entering string
    if (mixedJson[i] === '"' && !isEscaped) {
      isString = !isString;
      continue;
    }

    // Toggle the isEscaped boolean for every backslash
    // Reset for every regular character
    isEscaped = mixedJson[i] === '\\' && !isEscaped;

    if (isString) continue;

    if (mixedJson[i] === open) {
      counter++;
    } else if (mixedJson[i] === close) {
      counter--;
    }

    // All brackets have been closed, thus end of JSON is reached
    if (counter === 0) {
      // Return the cut JSON
      return mixedJson.substr(0, i + 1);
    }
  }
  // We ran through the whole string and ended up with an unclosed bracket
  throw Error("Can't cut unsupported JSON (no matching closing bracket found)");
};

// Exports for testing
exports._hidden = {
  jsonAfter, between, cutAfterJSON,
};
