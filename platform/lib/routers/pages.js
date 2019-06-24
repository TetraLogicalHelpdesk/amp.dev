/**
 * Copyright 2019 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const express = require('express');
const URL = require('url').URL;
const LRU = require('lru-cache');
const config = require('@lib/config');
const {Templates, context} = require('@lib/templates/');

/**
 * Transforms a request URL to match the defined scheme: has trailing slash,
 * doesn't have a HTML file extension
 * @param  {String} originalUrl
 * @return {URL}    The eventually rewritten URL
 */
function ensureUrlScheme(originalUrl) {
  const url = new URL(originalUrl, config.hosts.platform.base);

  // Get rid of former .amp.html file extension for legacy support
  if (url.pathname.endsWith('.amp.html')) {
    url.pathname = url.pathname.slice(0, -9);
  }

  // Get rid of .html file extension
  if (url.pathname.endsWith('.html')) {
    url.pathname = url.pathname.slice(0, -5);
  }

  // Get rid of index in the URL
  if (url.pathname.endsWith('index')) {
    url.pathname = url.pathname.slice(0, -5);
  }

  // Ensure there is a trailing slash
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }

  return url;
}

// Used to speed up resolving of path stubs to valid paths
const pathCache = new LRU({
  max: 500
});

/**
 * Fetches a template matching the requested path
 * @param  {String}             templatePath The path where the template can be found
 * @return {nunjucks.Template|null}
 */
async function loadTemplate(templatePath) {
  const AVAILABLE_STUBS = ['.html', '/index.html', '', '/'];
  let template = null;

  // The path has been ensured to always have a trailing slash which isn't
  // needed to find a matching page file
  templatePath = templatePath.slice(0, -1);

  const resolvedPath = pathCache.get(templatePath);
  // If the path has already been tried to resolve but never found
  // do not try to resolve it again
  if (resolvedPath === false) {
    return template;
  }

  // As the request path is not the actual path to the template it is somehow
  // guessed by testing all of AVAILABLE_STUBS ...
  for (const stub of AVAILABLE_STUBS) {
    // Othwerwise try the first stub or the already resolved path if there is one
    const searchPath = resolvedPath || `${templatePath}${stub}`;
    try {
      template = await Templates.get(searchPath);
    } catch(e) {
      continue;
    }

    if (template) {
      // ... therefore a resolved path gets cached
      pathCache.set(templatePath, searchPath);
      break;
    }
  }

  // If no template could be found, mark this as unresolvable
  if (!template) {
    pathCache.set(templatePath, false);
  }

  return template;
}

/**
 * Takes the rendered template and rewrites all hrefs in anchor tags
 * to have the currently selected format
 * @param  {String} html
 * @return {String}
 */
function rewriteLinks(canonical, html, format) {
  const DOCUMENTATION_ROUTE_PATTERN = /\/documentation\/*/;
  if (!DOCUMENTATION_ROUTE_PATTERN.test(canonical)) {
    return html;
  }

  const A_HREF_PATTERN = /<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1/gm
  html = html.replace(A_HREF_PATTERN, (match, p1, p2) => {
    if (!DOCUMENTATION_ROUTE_PATTERN.test(p2)) {
      return match;
    }

    const url = new URL(p2, config.hosts.platform.base);
    if (!url.searchParams.has('format')) {
      url.searchParams.set('format', format);
    }

    return match.replace(p2, url.toString());
  });

  return html;
}

// eslint-disable-next-line new-cap
const pages = express.Router();

pages.get('/*', async (req, res, next) => {
  // Let known file extensions automatically fallthrough as if they could not
  // been resolved by the preceeding middleware the pages router can't
  // resolve them either
  const KNOWN_FILE_EXTENSIONS = /\.(jpg|png|css|js|map)$/
  if (KNOWN_FILE_EXTENSIONS.test(req.path)) {
    next();
    return;
  }

  const url = ensureUrlScheme(req.originalUrl);
  if (url.pathname !== req.path) {
    res.redirect(url.toString());
    return;
  }

  const template = await loadTemplate(url.pathname);
  if (!template) {
    next();
    return;
  }

  const templateContext = context(req);
  let renderedTemplate = null;
  try {
    renderedTemplate = template.render(templateContext);
  } catch(e) {
    next(e);
    return;
  }

  // The documentation pages rely on passing along their currently
  // selected format via GET paramters. The static URLs need to be rewritten
  // for this use case
  renderedTemplate = rewriteLinks(url.pathname, renderedTemplate, templateContext.format);

  res.send(renderedTemplate);
});

module.exports = pages;
