const parseItem = require('./parseItem.js');
const miniget = require('miniget');
const util = require('./utils.js');
const querystring = require('querystring');

const BASE_SEARCH_URL = 'https://www.youtube.com/results?';
const BASE_API_URL = 'https://www.youtube.com/youtubei/v1/search?key=';

/**
 * Fetch and parse search results from YouTube based on given query.
 *
 * @param {string} searchString - The search string/query.
 * @param {Object} options - Configuration options for the search.
 * @param {number} retries - Number of retries left if JSON is not found.
 * @returns {Object} - Parsed search result data.
 */
const fetchSearchResults = async(searchString, options, retries = 3) => {
  if (retries === 0) {
    throw new Error('Unable to find JSON!');
  }

  const opts = util.checkArgs(searchString, options);
  const searchUrl = BASE_SEARCH_URL + querystring.encode(opts.query);
  const responseBody = await miniget(searchUrl, opts.requestOptions).text();
  const parsedResponse = util.parseBody(responseBody, opts);

  // Retry if unable to find json, possibly because of old response.
  if (!parsedResponse.json) {
    return fetchSearchResults(searchString, options, retries - 1);
  }

  // Handle API errors.
  if (parsedResponse.json.alerts && !parsedResponse.json.contents) {
    const error = parsedResponse.json.alerts.find(alert =>
      alert.alertRenderer && alert.alertRenderer.type === 'ERROR',
    );
    if (error) {
      throw new Error(`API-Error: ${util.parseText(error.alertRenderer.text, '* no message *')}`);
    }
  }

  let result = {
    originalQuery: opts.search,
    correctedQuery: opts.search,
    results: Number(parsedResponse.json.estimatedResults) || 0,
    activeFilters: [],
    refinements: [],
    items: [],
    continuation: null,
  };

  // Add refinements.
  if (Array.isArray(parsedResponse.json.refinements)) {
    parsedResponse.json.refinements.map(refinement => ({
      q: refinement,
      url: new URL(refinement, BASE_SEARCH_URL).toString(),
      bestThumbnail: null,
      thumbnails: null,
    }));
  }

  // Extract and parse items.
  const { rawItems, continuation } = util.parseWrapper(
    parsedResponse.json.contents.twoColumnSearchResultsRenderer.primaryContents,
  );
  result.items = rawItems.map(item => parseItem(item, result))
    .filter(item => item)
    .filter((_, index) => index < opts.limit);

  // Update the remaining number of items and pages.
  opts.limit -= result.items.length;
  opts.pages -= 1;

  // Extract active filters.
  const filters = util.parseFilters(parsedResponse.json);
  result.activeFilters = Array.from(filters).map(filter => filter[1].active).filter(active => active);

  // Extract the continuation token.
  let token = continuation ?
    continuation.continuationItemRenderer.continuationEndpoint.continuationCommand.token : null;
  if (token && opts.limit === Infinity) {
    result.continuation = [parsedResponse.apiKey, token, parsedResponse.context, opts];
  }

  // Return the result if we're at the end or reached limits.
  if (!token || opts.limit < 1 || opts.pages < 1) {
    return result;
  }

  // Fetch the next page.
  const nextPageResults = await fetchNextPage(parsedResponse.apiKey, token, parsedResponse.context, opts);
  result.items.push(...nextPageResults.items);
  result.continuation = nextPageResults.continuation;
  return result;
};
fetchSearchResults.version = require('../package.json').version;

/**
 * Fetch and parse the next page of search results from YouTube.
 *
 * @param {string} apiKey - YouTube API key.
 * @param {string} token - Continuation token.
 * @param {Object} context - YouTube context object.
 * @param {Object} options - Configuration options for the search.
 * @returns {Object} - Parsed search result data from the next page.
 */
const fetchNextPage = async(apiKey, token, context, options) => {
  const response = await util.doPost(BASE_API_URL + apiKey, { context, continuation: token }, options.requestOptions);

  if (!Array.isArray(response.onResponseReceivedCommands)) {
    return { continuation: null, items: [] };
  }

  const { rawItems, continuation } = util.parsePage2Wrapper(
    response.onResponseReceivedCommands[0].appendContinuationItemsAction.continuationItems);

  const parsedItems = rawItems.map(item => parseItem(item))
    .filter(item => item)
    .filter((_, index) => index < options.limit);

  options.limit -= parsedItems.length;
  options.pages -= 1;

  const nextToken = continuation ?
    continuation.continuationItemRenderer.continuationEndpoint.continuationCommand.token : null;

  if (!nextToken || options.limit < 1 || options.pages < 1) {
    return {
      continuation: nextToken && options.limit === Infinity ? [apiKey, nextToken, context, options] : null,
      items: parsedItems,
    };
  }

  const nextPageResults = await fetchNextPage(apiKey, nextToken, context, options);
  nextPageResults.items.unshift(...parsedItems);
  return nextPageResults;
};

/**
 * Continue a previous search request based on given continuation arguments.
 *
 * @param {Array} args - Array containing API key, token, context, and options.
 * @returns {Object} - Parsed search result data.
 */
fetchSearchResults.continueRequest = async args => {
  if (!Array.isArray(args) || args.length !== 4) {
    throw new Error('Invalid continuation array');
  }
  if (!args[0] || typeof args[0] !== 'string') throw new Error('Invalid apiKey');
  if (!args[1] || typeof args[1] !== 'string') throw new Error('Invalid token');
  if (!args[2] || typeof args[2] !== 'object') throw new Error('Invalid context');
  if (!args[3] || typeof args[3] !== 'object') throw new Error('Invalid options');
  if (args[3].limit !== null && !isNaN(args[3].limit) && isFinite(args[3].limit)) {
    throw new Error('continueRequest only allowed for paged requests');
  }

  args[3].pages = 1;
  args[3].limit = Infinity;

  return fetchNextPage(...args);
};

/**
 * Get available filters for a specific search query on YouTube.
 *
 * @param {string} searchString - The search string/query.
 * @param {Object} options - Configuration options for the search.
 * @returns {Array} - Array of available filters.
 */
fetchSearchResults.getFilters = async(searchString, options) => {
  const opts = util.checkArgs(searchString, options);
  const searchUrl = BASE_SEARCH_URL + querystring.encode(opts.query);
  const responseBody = await miniget(searchUrl, opts.requestOptions).text();
  const parsedResponse = util.parseBody(responseBody);

  if (!parsedResponse.json) {
    return fetchSearchResults.getFilters(searchString, options);
  }

  return util.parseFilters(parsedResponse.json);
};

module.exports = fetchSearchResults;
